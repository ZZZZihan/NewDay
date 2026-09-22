import { applyCaptureRequestSchema, captureRunSchema, type CaptureRun } from "@newday/core/contracts/task-capture";
import { HttpError } from "@/shared/http/request";
import type { TaskCaptureApi } from "../api/task-capture-api";
import type { CaptureEdit, CaptureSession, CaptureSessionStore } from "./task-capture-session";

export type CaptureState = CaptureSession & {
  status: Awaited<ReturnType<TaskCaptureApi["status"]>> | null;
  run: CaptureRun | null; loading: boolean; busy: "starting" | "checking" | "applying" | "cancelling" | null;
  error: string | null; statusError: string | null; uncertainty: "start" | "apply" | null; canRetry: boolean;
};
const emptySession = (): CaptureSession => ({ mode: "direct", text: "", request: null, captureId: null, edits: [], pendingApply: null, notifiedOperationId: null });
const message = (error: unknown) => error instanceof Error ? error.message : "待办服务暂时不可用，请重试。";
const unknownOutcome = (error: unknown) => !(error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.code !== "RESULT_UNKNOWN");

/** Controls one capture independently of the date selected in the task list. */
export class TaskCaptureController {
  private state: CaptureState = { ...emptySession(), status: null, run: null, loading: true, busy: null, error: null, statusError: null, uncertainty: null, canRetry: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onApplied: () => void | Promise<void> = () => undefined;
  private writable = false;
  constructor(private readonly api: TaskCaptureApi, private readonly store: CaptureSessionStore) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setCallback(callback: () => void | Promise<void>) { this.onApplied = callback; }
  setWritable(value: boolean) { this.writable = value; }
  private publish(patch: Partial<CaptureState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private persist(): boolean {
    const { mode, text, request, captureId, edits, pendingApply, notifiedOperationId } = this.state;
    try { this.store.save({ mode, text, request, captureId, edits, pendingApply, notifiedOperationId }); return true; }
    catch { this.publish({ error: "浏览器无法保存本轮恢复信息。请允许会话存储后重试，内容仍保留在此页面。" }); return false; }
  }
  private current(generation: number) { return this.active && generation === this.generation; }
  private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  dispose() { this.active = false; this.generation += 1; this.clearTimer(); }

  async initialize() {
    this.active = true;
    const generation = ++this.generation;
    const saved = this.store.load();
    this.publish({ ...(saved ?? emptySession()), loading: true, busy: null, error: null, statusError: null, status: null });
    try {
      const status = await this.api.status();
      if (!this.current(generation)) return;
      this.publish({ status });
    } catch (error) {
      if (!this.current(generation)) return;
      this.publish({ statusError: message(error) });
    }
    if (!this.current(generation)) return;
    this.publish({ loading: false });
    if (this.state.captureId || this.state.request) await this.confirm();
  }

  async retryStatus() {
    if (!this.active || this.state.loading) return;
    const generation = this.generation;
    this.publish({ loading: true, statusError: null });
    try {
      const status = await this.api.status();
      if (this.current(generation)) this.publish({ status });
    } catch (error) { if (this.current(generation)) this.publish({ statusError: message(error) }); }
    finally { if (this.current(generation)) this.publish({ loading: false }); }
  }

  updateInput(patch: Partial<Pick<CaptureSession, "mode" | "text">>) {
    if (this.state.busy || this.state.request || this.state.captureId) return;
    this.publish({ ...patch, error: null }); this.persist();
  }
  updateEdit(id: string, patch: Partial<Omit<CaptureEdit, "draftId">>) {
    if (this.state.busy || this.state.pendingApply || this.state.run?.status !== "ready") return;
    this.publish({ edits: this.state.edits.map((edit) => edit.draftId === id ? { ...edit, ...patch } : edit), error: null });
    this.persist();
  }
  newCapture(clearText = true) {
    if (this.state.loading || this.state.busy || this.state.uncertainty || this.state.run?.status === "running") return;
    this.clearTimer();
    this.generation += 1;
    this.publish({ ...emptySession(), mode: this.state.mode, text: clearText ? "" : this.state.text, run: null, error: null, uncertainty: null, canRetry: false });
    this.persist();
  }

  async start() {
    if (!this.writable || !this.active || this.state.loading || this.state.busy || this.state.request || this.state.captureId || !this.state.text.trim()) return;
    const request = { requestId: crypto.randomUUID(), mode: this.state.mode, text: this.state.text.trim() };
    this.publish({ request, captureId: request.requestId, error: null, busy: "starting", canRetry: false });
    if (!this.persist()) { this.publish({ request: null, captureId: null, busy: null }); return; }
    await this.sendOriginal();
  }
  private async sendOriginal() {
    const request = this.state.request;
    if (!request) return;
    const generation = this.generation;
    this.publish({ busy: "starting", error: null, canRetry: false });
    try {
      const run = await this.api.create(request);
      if (!this.current(generation)) return;
      await this.accept(run);
    } catch (error) {
      if (!this.current(generation)) return;
      if (unknownOutcome(error)) this.publish({ error: message(error), uncertainty: "start" });
      else { this.publish({ error: message(error), request: null, captureId: null, uncertainty: null }); this.persist(); }
    } finally { if (this.current(generation)) this.publish({ busy: null }); }
  }

  async confirm() {
    const id = this.state.captureId ?? this.state.request?.requestId;
    if (!this.active || this.state.busy || !id) return;
    this.clearTimer();
    const generation = this.generation;
    this.publish({ busy: "checking", error: null, canRetry: false });
    try {
      const run = await this.api.run(id);
      if (!this.current(generation)) return;
      await this.accept(run);
      if (this.state.pendingApply && run.status === "ready") this.publish({ uncertainty: "apply", canRetry: true });
    } catch (error) {
      if (!this.current(generation)) return;
      const missing = error instanceof HttpError && error.status === 404;
      this.publish({ error: missing ? "服务端尚未找到这轮请求，可按原请求重试。" : message(error), uncertainty: this.state.pendingApply ? "apply" : "start", canRetry: missing && Boolean(this.state.request) && !this.state.pendingApply });
    } finally { if (this.current(generation)) this.publish({ busy: null }); }
  }

  async retryOriginal() {
    if (!this.writable || !this.active || this.state.busy || !this.state.canRetry) return;
    if (this.state.pendingApply) await this.sendApply();
    else if (this.state.request) await this.sendOriginal();
  }
  async apply() {
    if (!this.writable || !this.active || this.state.busy || this.state.pendingApply || this.state.run?.status !== "ready") return;
    const parsed = applyCaptureRequestSchema.safeParse({ operationId: crypto.randomUUID(), tasks: this.state.edits.filter((edit) => edit.selected).map(({ draftId, title, notes, startDate, endDate }) => ({ draftId, title, notes, startDate, endDate })) });
    if (!parsed.success) { this.publish({ error: "请至少选择一条待办，并填写标题、开始日期和结束日期；结束日期不能早于开始日期。" }); return; }
    this.publish({ pendingApply: parsed.data, error: null });
    if (!this.persist()) { this.publish({ pendingApply: null }); return; }
    await this.sendApply();
  }
  private async sendApply() {
    const { captureId, pendingApply } = this.state;
    if (!captureId || !pendingApply) return;
    const generation = this.generation;
    this.publish({ busy: "applying", error: null, canRetry: false });
    try {
      const run = await this.api.apply(captureId, pendingApply);
      if (!this.current(generation)) return;
      await this.accept(run);
      if (run.status === "running" || run.status === "ready") this.publish({ uncertainty: "apply", error: "尚未收到创建回执，请确认提交结果。" });
    } catch (error) {
      if (!this.current(generation)) return;
      if (unknownOutcome(error)) this.publish({ error: message(error), uncertainty: "apply" });
      else { this.publish({ error: message(error), pendingApply: null, uncertainty: null }); this.persist(); }
    } finally { if (this.current(generation)) this.publish({ busy: null }); }
  }
  async cancel() {
    const id = this.state.captureId;
    if (!this.active || this.state.busy || !id || this.state.run?.status !== "running") return;
    const generation = this.generation;
    this.clearTimer(); this.publish({ busy: "cancelling", error: null });
    try {
      const run = await this.api.cancel(id);
      if (this.current(generation)) await this.accept(run);
    } catch (error) { if (this.current(generation)) this.publish({ error: message(error), uncertainty: "start" }); }
    finally { if (this.current(generation)) this.publish({ busy: null }); }
  }

  private async accept(value: CaptureRun) {
    const generation = this.generation;
    const parsed = captureRunSchema.safeParse(value);
    if (!parsed.success || parsed.data.captureId !== this.state.captureId) throw new HttpError("服务端返回的请求标识不匹配，请确认原请求结果。", "RESULT_UNKNOWN", 0, true);
    const run = parsed.data;
    if (run.status === "applied" && (!run.receipt || run.receipt.captureId !== run.captureId)) throw new HttpError("尚未收到有效的创建回执，请确认提交结果。", "RESULT_UNKNOWN", 0, true);
    const terminal = ["applied", "failed", "interrupted", "details_deleted"].includes(run.status);
    const previousEdits = new Map(this.state.edits.map((edit) => [edit.draftId, edit]));
    const edits = run.drafts.map((draft) => previousEdits.get(draft.id) ?? ({ draftId: draft.id, selected: true, title: draft.title, notes: draft.notes, startDate: draft.startDate ?? "", endDate: draft.endDate ?? "" }));
    this.publish({ run, edits, error: run.status === "failed" ? run.error ?? "这轮提取失败，请重新发起。" : null, uncertainty: null, canRetry: false, ...(terminal ? { pendingApply: null } : {}), ...(run.status === "details_deleted" ? { text: "", request: null } : {}) });
    this.persist();
    if (run.status === "running") this.timer = setTimeout(() => { void this.confirm(); }, 1000);
    if (run.status === "applied" && run.receipt && run.receipt.operationId !== this.state.notifiedOperationId) {
      this.publish({ notifiedOperationId: run.receipt.operationId }); this.persist();
      try { await this.onApplied(); }
      catch { if (this.current(generation)) this.publish({ error: "待办已经加入，但清单刷新失败。请刷新页面查看已创建的待办。" }); }
    }
  }
}
