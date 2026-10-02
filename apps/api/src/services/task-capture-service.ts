import { createHash, randomUUID } from "node:crypto";
import { AGENT_NAMESPACES, dateInTimeZone, modelUsageSchema, type AgentPreferences, type ModelUsage } from "@newday/core/contracts/agent-planning";
import {
  CAPTURE_NAMESPACES, CAPTURE_SCHEMA_VERSION, applyCaptureRequestSchema, captureModelOutputSchema,
  captureRunSchema, createCaptureRequestSchema,
  type ApplyCaptureRequest, type CaptureDraft, type CaptureModelInput, type CaptureRun, type CreateCaptureRequest,
} from "@newday/core/contracts/task-capture";
import { executePlannerCommandsWithoutUndo } from "@newday/core/application/planner-command";
import type { TaskCaptureModel } from "../agent/task-capture-model.js";
import { AgentApiError } from "../http/agent-error.js";
import { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";

type StoredCapture = {
  requestId: string; requestDigest: string; source: string; run: CaptureRun;
  schemaVersion: string; modelId: string; usage: ModelUsage; callStarted: boolean;
};
type CaptureOperation = { operationId: string; requestDigest: string; run: CaptureRun };

/** Extraction never holds a transaction. A successful execution records the
 * created tasks and its durable replay receipt in the same SQLite transaction. */
export class TaskCaptureService {
  private initialization?: Promise<void>;
  private closed = false;
  private readonly jobs = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  private readonly clock: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly store: SQLitePlannerStore,
    private readonly model?: TaskCaptureModel | null,
    options: { clock?: () => number; timeoutMs?: number } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000)
      throw new Error("Capture model timeout must be between 1 and 30000 milliseconds");
  }

  isConfigured() { return this.model != null; }
  get modelId() { return this.model?.modelId ?? null; }

  initialize(): Promise<void> {
    this.initialization ??= this.store.transaction(async () => {
      for (const record of await this.store.listAgentRecords<StoredCapture>(CAPTURE_NAMESPACES.runs)) {
        if (record.run.status === "running") await this.save({ ...record, run: {
          ...record.run, status: "interrupted", error: "服务已重启，本次提取已中断，请重新开始",
        } });
      }
    });
    return this.initialization;
  }

  async create(input: CreateCaptureRequest): Promise<CaptureRun> {
    await this.initialize();
    this.assertOpen();
    const request = createCaptureRequestSchema.parse(input);
    const requestDigest = digest(request);
    let launch = false;
    const record = await this.store.transaction(async () => {
      this.assertOpen();
      const prior = await this.store.getAgentRecord<StoredCapture>(CAPTURE_NAMESPACES.runs, request.requestId);
      if (prior) {
        if (prior.requestDigest !== requestDigest) throw conflict();
        launch = prior.run.status === "running" && !prior.callStarted && !this.jobs.has(prior.run.captureId);
        return prior;
      }
      if (!this.model) throw new AgentApiError("MODEL_UNAVAILABLE", 503, "尚未配置对话提取模型");
      const prefs = await this.preferences();
      if (!prefs?.timeZone) throw new AgentApiError("TIME_ZONE_REQUIRED", 409, "请先设置你的时区");
      const running = (await this.store.listAgentRecords<StoredCapture>(CAPTURE_NAMESPACES.runs))
        .find((entry) => entry.run.status === "running");
      if (running) throw new AgentApiError("RUN_ACTIVE", 409, "已有一段对话正在提取，请等待完成或取消", false, running.run.captureId);
      const now = this.clock();
      const created: StoredCapture = {
        requestId: request.requestId, requestDigest, source: request.text,
        schemaVersion: CAPTURE_SCHEMA_VERSION, modelId: this.model.modelId, usage: { kind: "unknown" }, callStarted: false,
        run: {
          captureId: request.requestId, mode: request.mode, status: "running", today: dateInTimeZone(now, prefs.timeZone),
          timeZone: prefs.timeZone, datasetEpoch: (await this.store.getPlanningVersion()).datasetEpoch,
          createdAt: new Date(now).toISOString(), drafts: [], message: "", receipt: null, error: null,
        },
      };
      await this.save(created);
      launch = true;
      return created;
    });
    if (launch) this.launch(record.run.captureId);
    return this.response(record);
  }

  async get(captureId: string): Promise<CaptureRun> {
    await this.initialize();
    return this.store.transaction(async () => this.response(await this.requireCapture(captureId)));
  }

  async apply(captureId: string, input: ApplyCaptureRequest): Promise<CaptureRun> {
    await this.initialize();
    this.assertOpen();
    const request = applyCaptureRequestSchema.parse(input);
    return this.store.transaction(() => this.applyInTransaction(captureId, request));
  }

  async cancel(captureId: string): Promise<CaptureRun> {
    await this.initialize();
    const run = await this.store.transaction(async () => {
      const record = await this.requireCapture(captureId);
      if (record.run.status === "running" || record.run.status === "ready") {
        record.run = { ...record.run, status: "interrupted", error: "已取消本次提取" };
        await this.save(record);
      }
      return this.response(record);
    });
    this.jobs.get(captureId)?.controller.abort();
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.initialize();
    await this.store.transaction(async () => {
      for (const record of await this.store.listAgentRecords<StoredCapture>(CAPTURE_NAMESPACES.runs)) {
        if (record.run.status === "running") await this.save({ ...record, run: {
          ...record.run, status: "interrupted", error: "服务停止，本次提取已中断，请重新开始",
        } });
      }
    });
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.settled));
  }

  async whenSettled(captureId: string) { await this.jobs.get(captureId)?.settled; }

  private launch(captureId: string) {
    if (this.closed || this.jobs.has(captureId)) return;
    const controller = new AbortController();
    const settled = this.execute(captureId, controller.signal).catch(async (error: unknown) => {
      await this.fail(captureId, error).catch(() => undefined);
    }).finally(() => this.jobs.delete(captureId));
    this.jobs.set(captureId, { controller, settled });
  }

  private async execute(captureId: string, signal: AbortSignal): Promise<void> {
    const record = await this.store.transaction(async () => {
      const current = await this.requireCapture(captureId);
      if (current.run.status !== "running" || signal.aborted) return undefined;
      await this.assertCurrent(current.run);
      current.callStarted = true;
      await this.save(current);
      return current;
    });
    if (!record) return;
    const generated = await this.callModel({ text: record.source, mode: record.run.mode,
      today: record.run.today, timeZone: record.run.timeZone }, signal);
    const output = captureModelOutputSchema.parse(generated.output);
    const usage = modelUsageSchema.parse(generated.usage);
    await this.store.transaction(async () => {
      const current = await this.findCapture(captureId);
      if (!current || current.run.status !== "running" || signal.aborted || this.closed) return;
      await this.assertCurrent(current.run);
      const seen = new Set<string>();
      const existingTasks = await this.store.listAllTasks();
      const drafts: CaptureDraft[] = [];
      let duplicateFound = false;
      for (const draft of output.drafts) {
        if (!current.source.includes(draft.sourceText))
          throw new AgentApiError("MODEL_INVALID_OUTPUT", 502, "提取结果的来源文字与对话不一致，请重试");
        if (draft.startDate !== null && draft.endDate !== null && draft.endDate < draft.startDate)
          throw new AgentApiError("MODEL_INVALID_OUTPUT", 502, "提取结果的结束日期早于开始日期，请重试");
        const key = taskKey(draft);
        const exactKey = JSON.stringify([contentKey(draft), draft.sourceText]);
        if (seen.has(exactKey)) {
          duplicateFound = true;
          drafts.find((entry) => contentKey(entry) === contentKey(draft) && entry.sourceText === draft.sourceText)!.needsReview = true;
          continue;
        }
        seen.add(exactKey);
        const sameTitleAndDate = drafts.filter((entry) => taskKey(entry) === key);
        if (sameTitleAndDate.length) {
          duplicateFound = true;
          for (const entry of sameTitleAndDate) entry.needsReview = true;
        }
        const duplicate = existingTasks.some((task) => !task.archived && task.status === "open" && taskKey(task) === key);
        duplicateFound ||= duplicate;
        drafts.push({ ...draft, id: randomUUID(), needsReview: draft.needsReview || duplicate || sameTitleAndDate.length > 0 ||
          draft.startDate === null || draft.endDate === null || capturedNotes(draft).length > 10_000 });
      }
      current.modelId = generated.modelId;
      current.usage = usage;
      current.run = { ...current.run, drafts, message: duplicateFound
        ? `${output.message}${output.message ? " " : ""}发现同名同日期的事项，请核对后选择是否加入。` : output.message, status: "ready" };
      await this.save(current);
      if (current.run.mode === "direct" && drafts.length > 0 && drafts.every((draft) => !draft.needsReview && draft.startDate && draft.endDate)) {
        await this.applyInTransaction(captureId, { operationId: `capture-auto:${digest(captureId)}`, tasks: drafts.map((draft) => ({
          draftId: draft.id, title: draft.title, notes: capturedNotes(draft), startDate: draft.startDate!, endDate: draft.endDate!,
        })) });
      }
    });
  }

  private async applyInTransaction(captureId: string, request: ApplyCaptureRequest): Promise<CaptureRun> {
    const requestDigest = digest({ captureId, ...request, tasks: [...request.tasks].sort((a, b) => a.draftId.localeCompare(b.draftId)) });
    const previous = await this.store.getAgentRecord<CaptureOperation>(CAPTURE_NAMESPACES.operations, request.operationId);
    if (previous) {
      if (previous.requestDigest !== requestDigest) throw conflict();
      return captureRunSchema.parse(previous.run);
    }
    this.assertOpen();
    const record = await this.requireCapture(captureId);
    if (record.run.status !== "ready") throw new AgentApiError("PROPOSAL_NOT_EXECUTABLE", 409, "本次提取已处理或还未完成，不能重复加入待办");
    await this.assertCurrent(record.run);
    if (request.tasks.some((task) => !record.run.drafts.some((draft) => draft.id === task.draftId)))
      throw new AgentApiError("INVALID_INPUT", 400, "提交中包含不属于本次提取的事项");
    if (new Set(request.tasks.map(contentKey)).size !== request.tasks.length)
      throw new AgentApiError("INVALID_INPUT", 400, "同一批次包含重复事项，请保留一条后重试");
    const createdAt = new Date(this.clock()).toISOString();
    if (dateInTimeZone(new Date(createdAt), record.run.timeZone) !== record.run.today)
      throw new AgentApiError("DATE_EXPIRED", 409, "日期已变化，请重新提取这段对话");
    const tasks = request.tasks.map(({ title, notes, startDate, endDate }) => ({ id: randomUUID(), title, notes, startDate, endDate }));
    await this.store.withEventContext({ date: record.run.today, at: createdAt, source: "agent", operationId: request.operationId }, () =>
      executePlannerCommandsWithoutUndo(this.store, tasks.map((task) => ({ type: "createTask", input: { ...task, now: createdAt } }))));
    record.run = { ...record.run, status: "applied", receipt: { operationId: request.operationId, captureId, createdAt, tasks }, error: null };
    await this.save(record);
    // The independent operation namespace survives clearing display history.
    await this.store.putAgentRecord<CaptureOperation>(CAPTURE_NAMESPACES.operations, request.operationId,
      { operationId: request.operationId, requestDigest, run: this.response(record) });
    return this.response(record);
  }

  private async callModel(input: CaptureModelInput, parentSignal: AbortSignal) {
    if (!this.model) throw new AgentApiError("MODEL_UNAVAILABLE", 503, "尚未配置对话提取模型");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { controller.abort(); reject(new AgentApiError("RUN_NOT_ACTIVE", 409, "本次提取已停止")); };
      parentSignal.addEventListener("abort", onAbort, { once: true });
      if (parentSignal.aborted) { onAbort(); return; }
      timer = setTimeout(() => {
        controller.abort();
        reject(new AgentApiError("MODEL_TIMEOUT", 504, "模型响应超时，请重新提取", true));
      }, this.timeoutMs);
    });
    try { return await Promise.race([this.model.generate(input, controller.signal), interrupted]); }
    finally { if (timer) clearTimeout(timer); parentSignal.removeEventListener("abort", onAbort); }
  }

  private async fail(captureId: string, error: unknown) {
    await this.store.transaction(async () => {
      const record = await this.findCapture(captureId);
      if (!record || record.run.status !== "running") return;
      record.run = { ...record.run, status: "failed", error: error instanceof AgentApiError ? error.message : "未能完成提取，请重新尝试" };
      await this.save(record);
    });
  }

  private async assertCurrent(run: CaptureRun) {
    const prefs = await this.preferences();
    if (prefs?.timeZone !== run.timeZone || dateInTimeZone(this.clock(), run.timeZone) !== run.today)
      throw new AgentApiError("DATE_EXPIRED", 409, "日期或时区已变化，请重新提取这段对话");
    if ((await this.store.getPlanningVersion()).datasetEpoch !== run.datasetEpoch)
      throw new AgentApiError("VERSION_CONFLICT", 409, "数据集已恢复或导入，请重新提取这段对话");
  }
  private preferences() { return this.store.getAgentRecord<AgentPreferences>(AGENT_NAMESPACES.preferences, "current"); }
  private findCapture(captureId: string) {
    return this.store.getAgentRecord<StoredCapture>(CAPTURE_NAMESPACES.runs, captureId);
  }
  private async requireCapture(captureId: string) {
    const record = await this.findCapture(captureId);
    if (!record) throw new AgentApiError("NOT_FOUND", 404, "找不到本次对话提取，请重新开始");
    return record;
  }
  private save(record: StoredCapture) { return this.store.putAgentRecord(CAPTURE_NAMESPACES.runs, record.requestId, record); }
  private response(record: StoredCapture) { return captureRunSchema.parse(record.run); }
  private assertOpen() { if (this.closed) throw new AgentApiError("RUN_NOT_ACTIVE", 503, "服务正在停止，请稍后重试"); }
}

function taskKey(task: { title: string; startDate: string | null; endDate: string | null }) {
  return JSON.stringify([task.title.trim().replace(/\s+/g, " ").toLocaleLowerCase(), task.startDate, task.endDate]);
}
function contentKey(task: { title: string; notes: string; startDate: string | null; endDate: string | null }) {
  return JSON.stringify([taskKey(task), task.notes.trim()]);
}
function capturedNotes(draft: { notes: string; sourceText: string }) {
  return draft.notes.includes(draft.sourceText) ? draft.notes : `${draft.notes}${draft.notes ? "\n" : ""}${draft.sourceText}`;
}
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function conflict() { return new AgentApiError("IDEMPOTENCY_CONFLICT", 409, "这个请求标识已用于不同内容，请查询原操作结果"); }

/** Clear private display content while retaining replay tombstones. The caller
 * may compose this with other history cleanup in its existing transaction. */
export async function clearTaskCaptureHistory(store: SQLitePlannerStore): Promise<void> {
  await store.transaction(async () => {
    const clear = (run: CaptureRun): CaptureRun => ({ ...run, status: "details_deleted",
      drafts: [], receipt: null, error: null, message: "对话记录已清除，已有任务保留。" });
    for (const record of await store.listAgentRecords<StoredCapture>(CAPTURE_NAMESPACES.runs)) {
      await store.putAgentRecord(CAPTURE_NAMESPACES.runs, record.requestId, { ...record, source: "",
        usage: { kind: "unknown" }, callStarted: true, run: clear(record.run) });
    }
    for (const record of await store.listAgentRecords<CaptureOperation>(CAPTURE_NAMESPACES.operations)) {
      await store.putAgentRecord(CAPTURE_NAMESPACES.operations, record.operationId,
        { ...record, run: clear(record.run) });
    }
  });
}
