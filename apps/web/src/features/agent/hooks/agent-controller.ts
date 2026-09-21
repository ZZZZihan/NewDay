import {
  type AgentPreferences, type AgentRunResponse, type AgentStatus, type ApplyProposalResponse,
  type ExecutionReceipt, type ExplicitConstraint, type FeedbackRequest, type PlanningHistoryResponse,
  type TodayContextResponse,
} from "@newday/core/contracts/agent-planning";
import type { AgentApi } from "../api/agent-api";
import { operationId, type AgentSession, type PendingOperation, type SessionStore } from "./agent-session";

export type AgentDraft = {
  goals: string; energy: "" | "low" | "normal" | "high"; capacity: string;
  limitations: string; rest: boolean; timeZone: string; preferences: string; learningEnabled: boolean;
  taskConstraints: ExplicitConstraint[];
};
export type AgentView = {
  loading: boolean; busy: string | null; status: AgentStatus | null; preferences: AgentPreferences | null;
  context: TodayContextResponse | null; draft: AgentDraft; run: AgentRunResponse | null;
  selectedTaskIds: string[]; history: PlanningHistoryResponse | null; pending: PendingOperation | null;
  receipt: ExecutionReceipt | null; detailsDeleted: boolean; error: string | null; errorCode: string | null; notice: string | null;
  answerPending: boolean;
  canRetryPending: boolean;
};
const emptyDraft = (): AgentDraft => ({ goals: "", energy: "", capacity: "", limitations: "", rest: false, timeZone: "", preferences: "", learningEnabled: false, taskConstraints: [] });
const initialView = (): AgentView => ({ loading: true, busy: null, status: null, preferences: null, context: null, draft: emptyDraft(), run: null, selectedTaskIds: [], history: null, pending: null, receipt: null, detailsDeleted: false, error: null, errorCode: null, notice: null, answerPending: false, canRetryPending: false });
const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "RESULT_UNKNOWN";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "规划服务暂时不可用，请重试";
const definiteRejection = (error: unknown) => ["INVALID_INPUT", "VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "DATE_EXPIRED", "PROPOSAL_NOT_EXECUTABLE", "RESTORE_CONFLICT", "NOT_FOUND"].includes(errorCode(error));

/** One view owns its responses. A changed input, date or disposed view invalidates
 * every outstanding response without guessing whether a write committed. */
export class AgentController {
  private state = initialView();
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private session: AgentSession | null = null;
  private publishedReceipts = new Set<string>();
  private feedbackRequests = new Map<string, FeedbackRequest>();
  constructor(
    readonly date: string,
    private readonly api: AgentApi,
    private readonly store: SessionStore,
    private onApplied: () => void | Promise<void>,
    private onPreferencesChanged: () => void = () => undefined,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}
  setCallbacks(onApplied: () => void | Promise<void>, onPreferencesChanged: () => void) { this.onApplied = onApplied; this.onPreferencesChanged = onPreferencesChanged; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(patch: Partial<AgentView>) { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }
  private current(token: number) { return !this.disposed && token === this.generation; }
  private fail(error: unknown) { this.patch({ error: errorMessage(error), errorCode: errorCode(error) }); }
  private persist(session: AgentSession | null) {
    try { this.store.save(session); this.session = session; return true; }
    catch { this.patch({ error: "浏览器无法保存请求恢复标识，请允许本地存储后重试。尚未提交操作。", errorCode: "LOCAL_STORAGE_UNAVAILABLE" }); return false; }
  }
  private stopPolling() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  dispose() { this.disposed = true; this.generation++; this.stopPolling(); this.listeners.clear(); }
  activate() { this.disposed = false; }

  async initialize() {
    this.activate();
    const token = ++this.generation;
    this.patch({ loading: true });
    this.session = this.store.load();
    this.patch({ answerPending: Boolean(this.session?.answer) });
    if (this.session?.pending) this.patch({ pending: this.session.pending });
    try {
      const [status, preferences, history] = await Promise.all([this.api.status(), this.api.preferences(), this.api.history(this.date)]);
      if (!this.current(token)) return;
      const context = preferences.timeZone ? await this.api.context() : null;
      if (!this.current(token)) return;
      this.patch({ status, preferences, context, history, draft: this.draftFrom(preferences, context), loading: false, error: null, errorCode: null });
      if (this.session?.pending) await this.confirmOperation();
      if (!this.current(token)) return;
      if (this.session?.date === this.date && (this.session.runId || this.session.requestId)) await this.restoreRun(token);
    } catch (error) { if (this.current(token)) { this.fail(error); this.patch({ loading: false }); } }
  }
  private draftFrom(preferences: AgentPreferences, context: TodayContextResponse | null): AgentDraft {
    return {
      goals: context?.context.goals.join("\n") ?? "", energy: context?.context.energy ?? "", capacity: context?.context.capacity?.toString() ?? "",
      limitations: context?.context.constraints.filter((constraint) => constraint.kind === "other").map((constraint) => constraint.sourceText).join("\n") ?? "",
      rest: context?.context.constraints.some((constraint) => constraint.kind === "rest") ?? false,
      timeZone: preferences.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      preferences: preferences.explicitPreferences.map((preference) => preference.text).join("\n"), learningEnabled: preferences.learningEnabled,
      taskConstraints: context?.context.constraints.filter((constraint) => !["other", "rest"].includes(constraint.kind)) ?? [],
    };
  }
  updateDraft(patch: Partial<AgentDraft>) {
    if (this.state.pending) return;
    const previousRun = this.state.run;
    ++this.generation;
    this.stopPolling();
    this.patch({ draft: { ...this.state.draft, ...patch }, run: null, selectedTaskIds: [], receipt: null, detailsDeleted: false, busy: null, error: null, errorCode: null, answerPending: false, notice: previousRun ? "输入已修改，请重新生成建议。" : null });
    this.abandonCurrentRun();
    if (previousRun && ["running", "needs_clarification"].includes(previousRun.run.status)) void this.api.cancel(previousRun.run.runId).catch(() => undefined);
  }
  setTaskConstraint(taskId: string, kind: "blocked_task" | "must_include" | "hard_deadline", value: string | null) {
    const existing = this.state.draft.taskConstraints.find((constraint) => constraint.taskId === taskId && constraint.kind === kind);
    const next = this.state.draft.taskConstraints.filter((constraint) => !(constraint.taskId === taskId && constraint.kind === kind));
    if (value?.trim()) next.push({ id: existing?.id ?? this.newId(), kind, taskId, value, source: "user", sourceText: value });
    this.updateDraft({ taskConstraints: next });
  }
  private abandonCurrentRun() {
    const session = this.session;
    if (!session) return;
    const abandonedRun = session.requestId ? { requestId: session.requestId, runId: session.runId } : session.abandonedRun;
    this.persist(abandonedRun ? { date: this.date, abandonedRun } : null);
  }
  private async cancelAbandonedRun(token: number) {
    const abandoned = this.session?.abandonedRun;
    if (!abandoned) return;
    const response = abandoned.runId ? await this.api.run(abandoned.runId) : await this.api.createRun({ requestId: abandoned.requestId });
    await this.api.cancel(response.run.runId);
    if (this.current(token) && this.session?.abandonedRun?.requestId === abandoned.requestId) this.persist({ ...this.session, abandonedRun: undefined });
  }
  async savePreferences() {
    if (this.state.busy || this.state.pending || !this.state.preferences) return;
    const token = this.generation;
    this.patch({ busy: "preferences", error: null, notice: null });
    try { await this.persistPreferences(token); if (this.current(token)) this.patch({ notice: "规划时区和明确偏好已保存。" }); }
    catch (error) { if (this.current(token)) this.fail(error); }
    finally { if (this.current(token)) this.patch({ busy: null }); }
  }
  private async persistPreferences(token: number) {
    const { preferences, draft } = this.state;
    if (!preferences) throw new Error("请先读取规划偏好");
    const texts = lines(draft.preferences);
    if (draft.timeZone === preferences.timeZone && draft.learningEnabled === preferences.learningEnabled && texts.join("\n") === preferences.explicitPreferences.map((preference) => preference.text).join("\n")) return;
    const saved = await this.api.savePreferences({ expectedRevision: preferences.revision, timeZone: draft.timeZone, learningEnabled: draft.learningEnabled, explicitPreferences: texts.map((text) => ({ id: preferences.explicitPreferences.find((preference) => preference.text === text)?.id ?? this.newId(), text, source: "user" })) });
    if (!this.current(token)) return;
    const [status, context] = await Promise.all([this.api.status(), this.api.context()]);
    if (!this.current(token)) return;
    this.patch({ preferences: saved, status, context });
    this.onPreferencesChanged();
  }
  async start() {
    if (this.state.busy || this.state.pending || !this.state.preferences) return;
    const token = ++this.generation;
    this.stopPolling();
    const oldRun = this.state.run;
    this.patch({ busy: "starting", run: null, selectedTaskIds: [], error: null, errorCode: null, notice: null, receipt: null, detailsDeleted: false });
    try {
      await this.cancelAbandonedRun(token);
      if (!this.current(token)) return;
      if (this.session?.requestId && !this.session.runId) { await this.restoreRun(token); return; }
      if (!this.state.status?.configured) throw Object.assign(new Error("尚未配置规划模型，请先在 API 服务中配置模型。"), { code: "MODEL_UNAVAILABLE" });
      if (oldRun && ["running", "needs_clarification"].includes(oldRun.run.status)) await this.api.cancel(oldRun.run.runId);
      if (!this.current(token)) return;
      await this.persistPreferences(token);
      if (!this.current(token)) return;
      const status = await this.api.status();
      if (!this.current(token)) return;
      this.patch({ status });
      const { context, draft } = this.state;
      if (!context || context.context.date !== this.date || status.today !== this.date || status.timeZone !== draft.timeZone)
        throw Object.assign(new Error("请选择规划时区的今天，再生成今日建议。"), { code: "DATE_EXPIRED" });
      const limitations: ExplicitConstraint[] = lines(draft.limitations).map((value) => ({ id: this.newId(), kind: "other", value, source: "user", sourceText: value }));
      if (draft.rest) limitations.push({ id: this.newId(), kind: "rest", value: "今天休息", source: "user", sourceText: "今天休息" });
      const saved = await this.api.saveContext({ expectedRevision: context.context.revision, goals: lines(draft.goals), energy: draft.energy || null, capacity: draft.capacity ? Number(draft.capacity) : null, constraints: [...draft.taskConstraints, ...limitations] });
      if (!this.current(token)) return;
      this.patch({ context: saved });
      const session = { date: this.date, requestId: this.newId() };
      if (!this.persist(session)) return;
      const response = await this.api.createRun({ requestId: session.requestId });
      if (!this.current(token)) { void this.api.cancel(response.run.runId).catch(() => undefined); return; }
      this.acceptRun(response, token);
    } catch (error) { if (this.current(token)) this.fail(error); }
    finally { if (this.current(token)) this.patch({ busy: null }); }
  }
  private acceptRun(response: AgentRunResponse, token: number) {
    if (!this.current(token)) return;
    const answer = response.run.status === "needs_clarification" ? this.session?.answer : undefined;
    this.persist({ ...this.session, date: this.date, requestId: response.run.requestId, runId: response.run.runId, answer });
    const sameProposal = this.state.run?.proposal?.proposalId === response.proposal?.proposalId;
    const selectedTaskIds = sameProposal ? this.state.selectedTaskIds : response.proposal?.output.kind === "ready" ? response.proposal.output.selections.map((selection) => selection.taskId) : [];
    this.patch({ run: response, selectedTaskIds, answerPending: Boolean(answer), error: response.run.error?.message ?? null, errorCode: response.run.error?.code ?? null });
    if (response.run.status === "running") {
      this.stopPolling();
      this.timer = setTimeout(() => { void this.restoreRun(token); }, 900);
    }
  }
  async restoreRun(token = this.generation) {
    const session = this.session;
    if (!session || session.date !== this.date) return;
    try {
      const response = session.runId ? await this.api.run(session.runId) : session.requestId ? await this.api.createRun({ requestId: session.requestId }) : null;
      if (response) this.acceptRun(response, token);
    } catch (error) { if (this.current(token)) this.fail(error); }
  }
  async cancel() {
    if (this.state.pending) return;
    const token = ++this.generation;
    this.stopPolling();
    this.abandonCurrentRun();
    this.patch({ run: null, selectedTaskIds: [], busy: "cancelling", notice: null, error: null, errorCode: null, answerPending: false });
    try { await this.cancelAbandonedRun(token); if (this.current(token)) this.patch({ notice: "已停止这轮规划。" }); }
    catch (error) { if (this.current(token)) this.fail(error); }
    finally { if (this.current(token)) this.patch({ busy: null }); }
  }
  async answer(answers: Record<string, string>) {
    const response = this.state.run;
    if (!response || this.state.busy || response.proposal?.output.kind !== "needs_clarification") return;
    const token = this.generation;
    this.patch({ busy: "answer", error: null });
    try {
      const request = this.session?.answer?.request ?? { requestId: this.newId(), answers: response.proposal.output.questions.map((question) => ({ questionId: question.id, answer: answers[question.id]?.trim() || "不知道" })) };
      if (!this.persist({ ...this.session, date: this.date, answer: { runId: response.run.runId, request } })) return;
      this.patch({ answerPending: true });
      const answered = await this.api.answer(response.run.runId, request);
      this.acceptRun(answered, token);
    } catch (error) { if (this.current(token)) { this.fail(error); await this.restoreRun(token); } }
    finally { if (this.current(token)) this.patch({ busy: null }); }
  }
  selectTask(taskId: string) {
    if (this.state.pending || this.state.busy) return;
    const candidate = this.state.run?.snapshot.candidates.find((candidate) => candidate.task.id === taskId);
    if (!candidate?.executable || candidate.blocked || candidate.task.status !== "open") return;
    const current = this.state.selectedTaskIds;
    if (current.includes(taskId)) this.patch({ selectedTaskIds: current.filter((id) => id !== taskId) });
    else if (current.length < 3) this.patch({ selectedTaskIds: [...current, taskId] });
  }
  async apply() {
    const { run, selectedTaskIds, busy, pending } = this.state;
    if (busy || pending || run?.run.status !== "ready" || !run.snapshot.scope.complete || !run.proposal || run.proposal.lifecycle !== "ready" || run.proposal.output.kind !== "ready" || selectedTaskIds.length < 1 || selectedTaskIds.length > 3) return;
    const token = this.generation;
    this.patch({ busy: "validating", error: null });
    try {
      const status = await this.api.status();
      if (!this.current(token)) return;
      this.patch({ status });
      if (status.today !== run.snapshot.date || status.timeZone !== run.snapshot.timeZone) {
        this.patch({ error: "日期或时区已经变化，请重新生成今天的建议。", errorCode: "DATE_EXPIRED" });
        return;
      }
    } catch (error) { if (this.current(token)) this.fail(error); return; }
    finally { if (this.current(token)) this.patch({ busy: null }); }
    if (!this.current(token)) return;
    const request = { proposalId: run.proposal.proposalId, operationId: this.newId(), expectedVersion: run.snapshot.version, taskIds: [...selectedTaskIds] };
    const operation: PendingOperation = { kind: "apply", request };
    if (!this.persist({ ...this.session, date: this.date, pending: operation })) return;
    await this.submitOperation(operation);
  }
  async revert(receipt: ExecutionReceipt) {
    if (this.state.busy || this.state.pending || !receipt.canRevert) return;
    const operation: PendingOperation = { kind: "revert", operationId: this.newId(), targetOperationId: receipt.operationId };
    if (!this.persist({ ...this.session, date: this.date, pending: operation })) return;
    await this.submitOperation(operation);
  }
  private async submitOperation(pending: PendingOperation) {
    const token = this.generation;
    this.patch({ busy: "applying", pending, canRetryPending: false, error: null, errorCode: null, notice: null });
    try {
      const response = pending.kind === "apply" ? await this.api.apply(pending.request) : await this.api.revert(pending.targetOperationId, pending.operationId);
      if (this.current(token)) await this.finishOperation(response);
    } catch (error) {
      if (!this.current(token)) return;
      if (definiteRejection(error)) {
        this.persist(this.session ? { ...this.session, pending: undefined } : null);
        this.patch({ pending: null, canRetryPending: false });
        if (["VERSION_CONFLICT", "DATE_EXPIRED", "PROPOSAL_NOT_EXECUTABLE"].includes(errorCode(error)) && this.state.run?.proposal)
          this.patch({ run: { ...this.state.run, proposal: { ...this.state.run.proposal, lifecycle: "expired" } } });
        this.fail(error);
      } else {
        this.patch({ error: "执行结果待确认，请查询原请求结果。请勿重复采纳。", errorCode: "RESULT_UNKNOWN" });
        await this.confirmOperation();
      }
    } finally { if (this.current(token)) this.patch({ busy: null }); }
  }
  async confirmOperation() {
    const pending = this.state.pending ?? this.session?.pending;
    if (!pending) return;
    const token = this.generation;
    this.patch({ busy: "confirming", pending });
    try {
      const result = await this.api.operation(operationId(pending));
      if (!this.current(token)) return;
      if (result.status === "found") await this.finishOperation(result.receipt);
      else if (result.status === "details_deleted") await this.finishOperation(result);
      else this.patch({ canRetryPending: true, error: "执行结果待确认：服务端尚未查到这个请求的回执。保留原请求标识，请稍后再次查询，或按原请求重试。", errorCode: "RESULT_UNKNOWN" });
    } catch (error) { if (this.current(token)) this.patch({ error: `执行结果待确认：${errorMessage(error)}`, errorCode: "RESULT_UNKNOWN" }); }
    finally { if (this.current(token)) this.patch({ busy: null }); }
  }
  /** A deliberate retry retains both the operation identity and the exact
   * original payload. Recheck first so a newly committed receipt wins. */
  async retryPendingOperation() {
    const pending = this.state.pending;
    if (!pending || this.state.busy || !this.state.canRetryPending) return;
    const token = this.generation;
    this.patch({ busy: "confirming" });
    try {
      const result = await this.api.operation(operationId(pending));
      if (!this.current(token)) return;
      if (result.status === "found") await this.finishOperation(result.receipt);
      else if (result.status === "details_deleted") await this.finishOperation(result);
      else await this.submitOperation(pending);
    } catch (error) { if (this.current(token)) this.patch({ error: `执行结果待确认：${errorMessage(error)}`, errorCode: "RESULT_UNKNOWN" }); }
    finally { if (this.current(token)) this.patch({ busy: null }); }
  }
  private async finishOperation(response: ApplyProposalResponse) {
    this.persist(this.session ? { ...this.session, pending: undefined } : null);
    this.patch({ canRetryPending: false });
    if (response.status === "details_deleted") { this.patch({ pending: null, detailsDeleted: true, receipt: null, error: null, errorCode: null, notice: "已确认该请求执行完成；历史详情已清理，无法展示或恢复原重点。" }); return; }
    this.patch({ pending: null, receipt: response, error: null, errorCode: null, notice: response.action === "revert" ? "已恢复采纳前的今日重点。" : response.status === "no_change" ? "已确认：今日重点与所选集合相同，无需更改。" : "今日重点已更新。" });
    if (this.state.run?.proposal) this.patch({ run: { ...this.state.run, proposal: { ...this.state.run.proposal, lifecycle: "applied" } } });
    if (!this.publishedReceipts.has(response.operationId)) {
      this.publishedReceipts.add(response.operationId);
      try { await this.onApplied(); }
      catch { this.patch({ notice: "执行已完成，但任务列表刷新失败。请刷新页面查看已保存的结果。" }); }
    }
    await this.refreshHistory();
  }
  async refreshHistory() {
    const token = this.generation;
    try { const history = await this.api.history(this.date); if (this.current(token)) this.patch({ history }); }
    catch (error) { if (this.current(token)) this.fail(error); }
  }
  async feedback(proposalId: string, decision: FeedbackRequest["decision"], reason: string, receipt?: ExecutionReceipt) {
    if (this.state.busy || this.state.pending) return;
    const token = this.generation;
    const key = JSON.stringify([proposalId, decision, reason, receipt?.operationId]);
    const request = this.feedbackRequests.get(key) ?? { feedbackId: this.newId(), proposalId, decision, reason: reason.trim() || undefined, operationId: receipt?.operationId };
    this.feedbackRequests.set(key, request);
    this.patch({ busy: "feedback", error: null });
    try {
      await this.api.feedback(request);
      if (!this.current(token)) return;
      if (decision === "rejected" && this.state.run?.proposal?.proposalId === proposalId) this.patch({ run: { ...this.state.run, proposal: { ...this.state.run.proposal, lifecycle: "rejected" } }, notice: "已记录拒绝，今日重点保持原样。" });
      else this.patch({ notice: "反馈已记录。" });
      await this.refreshHistory();
    } catch (error) { if (this.current(token)) this.fail(error); }
    finally { if (this.current(token)) this.patch({ busy: null }); }
  }
}
