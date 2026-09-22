import { randomUUID, createHash } from "node:crypto";
import {
  AGENT_NAMESPACES, AGENT_PROMPT_VERSION, AGENT_SCHEMA_VERSION, answerRunRequestSchema, createRunRequestSchema,
  dateInTimeZone, modelUsageSchema, planningSnapshotSchema,
} from "@newday/core/contracts/agent-planning";
import type {
  AgentError, AgentPreferences, AgentRun, AgentRunResponse, AnswerRunRequest, CreateRunRequest,
  DailyContext, ModelUsage, PlanningModelOutput, PlanningProposal, PlanningSnapshot, PlanningVersion,
} from "@newday/core/contracts/agent-planning";
import { AgentApiError } from "../http/agent-error.js";
import type { ModelGeneration, ModelRepair, PlanningAnswers, PlanningModel } from "../agent/planning-model.js";
import { forcedNoAction, InvalidPlanningOutputError, validatePlanningOutput } from "../agent/validate-planning-output.js";

export interface AgentRunRepository {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  getAgentRecord<T>(namespace: string, id: string): Promise<T | undefined>;
  putAgentRecord<T>(namespace: string, id: string, value: T): Promise<void>;
  listAgentRecords<T>(namespace: string): Promise<T[]>;
  getPlanningVersion(): Promise<PlanningVersion>;
  getAgentGeneration(): Promise<number>;
}
export interface PlanningSnapshotSource { createSnapshot(): Promise<PlanningSnapshot> }
export type AgentRunServiceOptions = { clock?: () => number; timeoutMs?: number };
const REQUESTS = "agent.run-request";
const ANSWERS = "agent.run-answer";
const active = (run: AgentRun) => run.status === "running" || run.status === "needs_clarification";

export class AgentRunService {
  private initialization?: Promise<void>;
  private closed = false;
  private readonly jobs = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  private readonly clock: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly repository: AgentRunRepository,
    private readonly snapshots: PlanningSnapshotSource,
    private readonly model?: PlanningModel | null,
    options: AgentRunServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000)
      throw new Error("Agent model timeout must be between 1 and 30000 milliseconds");
  }

  isConfigured() { return this.model != null; }
  get modelId(): string | null { return this.model?.modelId ?? null; }

  initialize(): Promise<void> {
    this.initialization ??= this.repository.transaction(async () => {
      for (const run of await this.repository.listAgentRecords<AgentRun>(AGENT_NAMESPACES.run)) {
        if (active(run)) await this.repository.putAgentRecord(AGENT_NAMESPACES.run, run.runId, {
          ...run, status: "interrupted", updatedAt: this.now(),
          error: this.errorRecord(new AgentApiError("RUN_NOT_ACTIVE", 409, "服务已重启，本次规划已中断，请重新开始", true), run.runId),
        });
      }
    });
    return this.initialization;
  }

  async create(input: CreateRunRequest): Promise<AgentRunResponse> {
    await this.initialize();
    this.assertOpen();
    const request = createRunRequestSchema.parse(input);
    for (;;) {
      let launch = false;
      const result = await this.repository.transaction(async () => {
        this.assertOpen();
        const previous = await this.repository.getAgentRecord<{ runId: string }>(REQUESTS, request.requestId);
        if (previous) return this.readResponse(previous.runId);
        if (!this.model) throw new AgentApiError("MODEL_UNAVAILABLE", 503, "尚未配置规划模型，手动清单仍可使用");
        const running = (await this.repository.listAgentRecords<AgentRun>(AGENT_NAMESPACES.run)).find(active);
        if (running) {
          if (await this.retireIfStale(running)) return { retiredRunId: running.runId };
          throw new AgentApiError("RUN_ACTIVE", 409, "已有一轮规划进行中，请继续或取消后再开始", false, running.runId);
        }
        // History clearing may have removed an in-flight run. Stop any orphaned
        // local waits before starting another request; their late results cannot
        // be written because the durable run identity no longer exists.
        for (const job of this.jobs.values()) job.controller.abort();
        const snapshot = planningSnapshotSchema.parse(await this.snapshots.createSnapshot());
        if (!snapshot.scope.complete || snapshot.scope.includedTasks !== snapshot.scope.totalEligibleTasks)
          throw new AgentApiError("CONTEXT_TOO_LARGE", 422, "今日候选超出了规划上下文范围，请缩小范围后重试");
        if (dateInTimeZone(this.clock(), snapshot.timeZone) !== snapshot.date)
          throw new AgentApiError("DATE_EXPIRED", 409, "日期已变化，请重新生成今天的规划");
        for (const proposal of await this.repository.listAgentRecords<PlanningProposal>(AGENT_NAMESPACES.proposal)) {
          if (proposal.lifecycle === "ready") await this.repository.putAgentRecord(AGENT_NAMESPACES.proposal, proposal.proposalId, { ...proposal, lifecycle: "superseded" });
        }
        const run: AgentRun = {
          runId: randomUUID(), requestId: request.requestId, snapshotId: snapshot.id, status: "running",
          modelId: this.model.modelId, promptVersion: AGENT_PROMPT_VERSION, schemaVersion: AGENT_SCHEMA_VERSION,
          callCount: 0, clarificationRound: 0, latencyMs: 0, usage: { kind: "known", inputTokens: 0, outputTokens: 0 },
          createdAt: this.now(), updatedAt: this.now(), proposalId: null, error: null,
        };
        await this.repository.putAgentRecord(AGENT_NAMESPACES.run, run.runId, run);
        await this.repository.putAgentRecord(REQUESTS, request.requestId, { runId: run.runId });
        launch = true;
        return this.readResponse(run.runId);
      });
      if ("retiredRunId" in result) {
        this.jobs.get(result.retiredRunId)?.controller.abort();
        // Commit retirement before attempting snapshot creation. A subsequent
        // rejected create must not roll the stale run back into an active state.
        continue;
      }
      if (launch) this.launch(result.run.runId, []);
      return result;
    }
  }

  async get(runId: string): Promise<AgentRunResponse> {
    await this.initialize();
    return this.repository.transaction(() => this.readResponse(runId));
  }

  async answer(runId: string, input: AnswerRunRequest): Promise<AgentRunResponse> {
    await this.initialize();
    this.assertOpen();
    const request = answerRunRequestSchema.parse(input);
    const digest = createHash("sha256").update(JSON.stringify([...request.answers].sort((a, b) => a.questionId.localeCompare(b.questionId)))).digest("hex");
    let continuation: PlanningAnswers | undefined;
    const result = await this.repository.transaction(async () => {
      this.assertOpen();
      const key = `${runId}:${request.requestId}`;
      const previous = await this.repository.getAgentRecord<{ digest: string }>(ANSWERS, key);
      if (previous) {
        if (previous.digest !== digest) throw new AgentApiError("IDEMPOTENCY_CONFLICT", 409, "同一澄清请求标识对应了不同答案");
        return this.readResponse(runId);
      }
      const run = await this.repository.getAgentRecord<AgentRun>(AGENT_NAMESPACES.run, runId);
      if (run && active(run)) {
        const rejection = await this.retireIfStale(run);
        if (rejection) return { rejection };
      }
      const current = await this.readResponse(runId);
      if (current.run.status !== "needs_clarification" || current.run.clarificationRound !== 0 || current.proposal?.output.kind !== "needs_clarification")
        throw new AgentApiError("RUN_NOT_ACTIVE", 409, "本轮已不能提交澄清答案");
      const questions = current.proposal.output.questions;
      if (request.answers.length !== questions.length || new Set(request.answers.map((answer) => answer.questionId)).size !== questions.length ||
        request.answers.some((answer) => !questions.some((question) => question.id === answer.questionId)))
        throw new AgentApiError("INVALID_INPUT", 400, "请对本轮每个澄清问题各回答一次");
      continuation = request.answers.map((answer) => ({ ...answer, question: questions.find((question) => question.id === answer.questionId)!.question }));
      await this.repository.putAgentRecord(AGENT_NAMESPACES.proposal, current.proposal.proposalId, { ...current.proposal, lifecycle: "superseded" });
      await this.repository.putAgentRecord(AGENT_NAMESPACES.run, runId, { ...current.run, status: "running", clarificationRound: 1, proposalId: null, updatedAt: this.now() });
      await this.repository.putAgentRecord(ANSWERS, key, { digest });
      return this.readResponse(runId);
    });
    if ("rejection" in result) {
      this.jobs.get(runId)?.controller.abort();
      // Throw after the transaction commits the terminal state. Throwing from
      // its callback would silently restore needs_clarification on rollback.
      throw result.rejection;
    }
    if (continuation) this.launch(runId, continuation);
    return result;
  }

  async cancel(runId: string): Promise<AgentRunResponse> {
    await this.initialize();
    const result = await this.repository.transaction(async () => {
      const current = await this.readResponse(runId);
      if (active(current.run)) {
        await this.repository.putAgentRecord(AGENT_NAMESPACES.run, runId, { ...current.run, status: "cancelled", updatedAt: this.now(), error: null });
        if (current.proposal) await this.repository.putAgentRecord(AGENT_NAMESPACES.proposal, current.proposal.proposalId, { ...current.proposal, lifecycle: "superseded" });
      }
      return this.readResponse(runId);
    });
    if (result.run.status === "cancelled") this.jobs.get(runId)?.controller.abort();
    return result;
  }

  /** Shutdown stops local waits promptly even if a provider ignores AbortSignal.
   * The upstream may still charge for work; restart never resumes it implicitly. */
  async close(): Promise<void> {
    this.closed = true;
    await this.initialize();
    await this.repository.transaction(async () => {
      for (const run of await this.repository.listAgentRecords<AgentRun>(AGENT_NAMESPACES.run)) {
        if (active(run)) await this.repository.putAgentRecord(AGENT_NAMESPACES.run, run.runId, {
          ...run, status: "interrupted", updatedAt: this.now(),
          error: this.errorRecord(new AgentApiError("RUN_NOT_ACTIVE", 409, "服务停止，本次规划已中断，请重新开始", true), run.runId),
        });
      }
    });
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.settled));
  }

  /** Deterministic module/integration tests can await a local turn without
   * polling. This promise stops at clarification; it never implies acceptance. */
  async whenSettled(runId: string): Promise<void> { await this.jobs.get(runId)?.settled; }

  private launch(runId: string, answers: PlanningAnswers) {
    if (this.closed) return;
    const previous = this.jobs.get(runId);
    if (previous) {
      // A client may answer as soon as the clarification transaction commits,
      // before the previous local promise has run its finally callback.
      void previous.settled.then(() => this.launch(runId, answers));
      return;
    }
    const controller = new AbortController();
    const settled = this.execute(runId, answers, controller.signal).catch(async (error: unknown) => {
      // A persistence failure is not a success. A second failed write is left
      // interrupted on the next startup, without an unhandled background error.
      await this.fail(runId, error).catch(() => undefined);
    }).finally(() => this.jobs.delete(runId));
    this.jobs.set(runId, { controller, settled });
  }

  private async execute(runId: string, answers: PlanningAnswers, signal: AbortSignal): Promise<void> {
    const initial = await this.repository.transaction(() => this.readResponse(runId));
    const forced = forcedNoAction(initial.snapshot);
    if (forced) { await this.finish(runId, initial.snapshot, forced); return; }
    let repair: ModelRepair | undefined;
    for (;;) {
      const run = await this.repository.transaction(async () => {
        const current = await this.repository.getAgentRecord<AgentRun>(AGENT_NAMESPACES.run, runId);
        if (!current || current.status !== "running" || signal.aborted) return undefined;
        if (current.callCount >= 3) throw new AgentApiError("MODEL_INVALID_OUTPUT", 502, "本轮模型调用已达到上限");
        await this.assertSnapshotCurrent(initial.snapshot);
        const next = { ...current, callCount: current.callCount + 1, updatedAt: this.now() };
        // While a request is in flight its total usage is unknown. Keep the
        // previous completed-call total locally so a known response can add it.
        await this.repository.putAgentRecord(AGENT_NAMESPACES.run, runId, { ...next, usage: { kind: "unknown" } });
        return next;
      });
      if (!run) return;
      const started = this.clock();
      let generation: ModelGeneration | undefined;
      try {
        generation = await this.callModel(initial.snapshot, answers, signal, repair);
        await this.recordCall(runId, started, run.usage, generation);
        const output = validatePlanningOutput(generation.output, initial.snapshot, run.clarificationRound);
        await this.finish(runId, initial.snapshot, output);
        return;
      } catch (error) {
        if (!generation) await this.recordCall(runId, started, run.usage);
        const repairable = error instanceof InvalidPlanningOutputError ? error.repairable : error instanceof AgentApiError && error.code === "MODEL_INVALID_OUTPUT";
        if (!signal.aborted && repairable && !repair && run.callCount < 3) {
          repair = { issues: error instanceof InvalidPlanningOutputError ? error.issues : ["Return one complete JSON object matching the required schema."] };
          continue;
        }
        await this.fail(runId, error);
        return;
      }
    }
  }

  private async callModel(snapshot: PlanningSnapshot, answers: PlanningAnswers, parentSignal: AbortSignal, repair?: ModelRepair): Promise<ModelGeneration> {
    if (!this.model) throw new AgentApiError("MODEL_UNAVAILABLE", 503, "尚未配置规划模型");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { controller.abort(); reject(new AgentApiError("RUN_NOT_ACTIVE", 409, "本轮规划已停止")); };
      parentSignal.addEventListener("abort", onAbort, { once: true });
      if (parentSignal.aborted) { onAbort(); return; }
      timer = setTimeout(() => {
        reject(new AgentApiError("MODEL_TIMEOUT", 504, "模型响应超时，请重新开始一轮规划", true));
        controller.abort();
      }, this.timeoutMs);
    });
    try {
      // No repository transaction or PlannerService queue is held here.
      return await Promise.race([this.model.generate(snapshot, answers, controller.signal, repair), interrupted]);
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", onAbort);
    }
  }

  private async recordCall(runId: string, started: number, completedUsage: ModelUsage, generation?: ModelGeneration) {
    await this.repository.transaction(async () => {
      const run = await this.repository.getAgentRecord<AgentRun>(AGENT_NAMESPACES.run, runId);
      if (!run || run.status !== "running") return;
      const usage = generation ? modelUsageSchema.parse(generation.usage) : { kind: "unknown" as const };
      await this.repository.putAgentRecord(AGENT_NAMESPACES.run, runId, {
        ...run, modelId: generation?.modelId ?? run.modelId, usage: this.addUsage(completedUsage, usage),
        latencyMs: run.latencyMs + Math.max(0, this.clock() - started), updatedAt: this.now(),
      });
    });
  }

  private async finish(runId: string, snapshot: PlanningSnapshot, output: PlanningModelOutput) {
    await this.repository.transaction(async () => {
      const run = await this.repository.getAgentRecord<AgentRun>(AGENT_NAMESPACES.run, runId);
      if (!run || run.status !== "running") return;
      await this.assertSnapshotCurrent(snapshot);
      const proposal: PlanningProposal = {
        proposalId: randomUUID(), runId, snapshotId: snapshot.id, createdAt: this.now(),
        lifecycle: output.kind === "ready" ? "ready" : "not_applicable", output,
      };
      await this.repository.putAgentRecord(AGENT_NAMESPACES.proposal, proposal.proposalId, proposal);
      await this.repository.putAgentRecord(AGENT_NAMESPACES.run, runId, { ...run, status: output.kind, proposalId: proposal.proposalId, updatedAt: this.now(), error: null });
    });
  }

  private async fail(runId: string, error: unknown) {
    await this.repository.transaction(async () => {
      const run = await this.repository.getAgentRecord<AgentRun>(AGENT_NAMESPACES.run, runId);
      if (!run || run.status !== "running") return;
      await this.repository.putAgentRecord(AGENT_NAMESPACES.run, runId, { ...run, status: "failed", updatedAt: this.now(), error: this.errorRecord(error, runId) });
    });
  }

  private async assertSnapshotCurrent(snapshot: PlanningSnapshot) {
    if (dateInTimeZone(this.clock(), snapshot.timeZone) !== snapshot.date)
      throw new AgentApiError("DATE_EXPIRED", 409, "日期已变化，请重新生成今天的规划");
    const context = await this.repository.getAgentRecord<DailyContext>(AGENT_NAMESPACES.context, snapshot.context.id);
    const preferences = await this.repository.getAgentRecord<AgentPreferences>(AGENT_NAMESPACES.preferences, "current");
    const saved = await this.repository.getAgentRecord<PlanningSnapshot>(AGENT_NAMESPACES.snapshot, snapshot.id);
    const version = await this.repository.getPlanningVersion();
    if (!saved || !context || context.revision !== snapshot.context.revision || !preferences ||
      preferences.revision !== snapshot.preferences.revision || preferences.timeZone !== snapshot.timeZone || version.datasetEpoch !== snapshot.version.datasetEpoch ||
      (snapshot.agentGeneration ?? 0) !== await this.repository.getAgentGeneration())
      throw new AgentApiError("VERSION_CONFLICT", 409, "规划输入已变化，请重新生成建议");
  }

  /** Called only inside the caller's short transaction. Returning the rejection
   * lets the caller commit retirement before sending an error or retrying. */
  private async retireIfStale(run: AgentRun): Promise<AgentApiError | undefined> {
    try {
      const snapshot = await this.repository.getAgentRecord<PlanningSnapshot>(AGENT_NAMESPACES.snapshot, run.snapshotId);
      if (!snapshot) throw new AgentApiError("VERSION_CONFLICT", 409, "本轮规划的上下文已失效，请重新生成建议");
      await this.assertSnapshotCurrent(snapshot);
    } catch (error) {
      if (!(error instanceof AgentApiError) || !["VERSION_CONFLICT", "DATE_EXPIRED"].includes(error.code)) throw error;
      await this.repository.putAgentRecord(AGENT_NAMESPACES.run, run.runId, {
        ...run, status: "failed", updatedAt: this.now(), error: this.errorRecord(error, run.runId),
      });
      if (run.proposalId) {
        const proposal = await this.repository.getAgentRecord<PlanningProposal>(AGENT_NAMESPACES.proposal, run.proposalId);
        if (proposal && ["ready", "not_applicable"].includes(proposal.lifecycle))
          await this.repository.putAgentRecord(AGENT_NAMESPACES.proposal, proposal.proposalId, { ...proposal, lifecycle: "superseded" });
      }
      return error;
    }
  }

  private async readResponse(runId: string): Promise<AgentRunResponse> {
    const run = await this.repository.getAgentRecord<AgentRun>(AGENT_NAMESPACES.run, runId);
    if (!run) throw new AgentApiError("NOT_FOUND", 404, "这轮规划不存在或其历史已清理");
    const snapshot = await this.repository.getAgentRecord<PlanningSnapshot>(AGENT_NAMESPACES.snapshot, run.snapshotId);
    if (!snapshot) throw new AgentApiError("NOT_FOUND", 404, "本轮规划的上下文已清理");
    const proposal = run.proposalId ? await this.repository.getAgentRecord<PlanningProposal>(AGENT_NAMESPACES.proposal, run.proposalId) : undefined;
    return { run, snapshot, proposal: proposal ?? null };
  }

  private errorRecord(error: unknown, runId: string): AgentError {
    return error instanceof AgentApiError ? { code: error.code, status: error.statusCode, message: error.message, retryable: error.retryable, correlationId: runId } :
      { code: "INTERNAL_ERROR", status: 500, message: "本轮规划未能完成，请重新开始", retryable: true, correlationId: runId };
  }
  private addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
    return a.kind === "known" && b.kind === "known" ? { kind: "known", inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens } : { kind: "unknown" };
  }
  private assertOpen() { if (this.closed) throw new AgentApiError("MODEL_UNAVAILABLE", 503, "规划服务正在停止", true); }
  private now() { return new Date(this.clock()).toISOString(); }
}
