import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureRun, CreateCaptureRequest } from "@newday/core/contracts/task-capture";
import { HttpError } from "@/shared/http/request";
import type { TaskCaptureApi } from "../api/task-capture-api";
import { TaskCaptureController } from "./task-capture-controller";
import type { CaptureSession, CaptureSessionStore } from "./task-capture-session";

const controllers: TaskCaptureController[] = [];
const lost = new HttpError("响应丢失", "RESULT_UNKNOWN", 0, true);
const date = "2026-09-22";
const run = (request: CreateCaptureRequest): CaptureRun => ({
  captureId: request.requestId, mode: request.mode, status: "ready", today: date, timeZone: "Asia/Shanghai", datasetEpoch: "dataset-a", createdAt: `${date}T01:00:00.000Z`,
  drafts: [{ id: "draft-a", title: "整理资料", notes: "下午 3 点", startDate: date, endDate: date, sourceText: "今天下午整理资料", needsReview: false }],
  message: "", receipt: null, error: null,
});
const applied = (value: CaptureRun, operationId = "direct-operation"): CaptureRun => ({
  ...value, status: "applied", receipt: { operationId, captureId: value.captureId, createdAt: `${date}T01:00:01.000Z`, tasks: [{ id: "created-task", title: "整理资料", notes: "下午 3 点", startDate: date, endDate: date }] },
});
function setup(initial: CaptureSession | null = null) {
  let saved = structuredClone(initial);
  const store: CaptureSessionStore = { load: () => structuredClone(saved), save: (value) => { saved = structuredClone(value); } };
  const api = {
    status: vi.fn<TaskCaptureApi["status"]>().mockResolvedValue({ configured: true, modelId: "test" }),
    create: vi.fn<TaskCaptureApi["create"]>().mockImplementation(async (request) => run(request)),
    run: vi.fn<TaskCaptureApi["run"]>(),
    apply: vi.fn<TaskCaptureApi["apply"]>().mockImplementation(async (captureId, request) => applied(run({ requestId: captureId, mode: "transcript", text: "待办" }), request.operationId)),
    cancel: vi.fn<TaskCaptureApi["cancel"]>(),
  };
  const refresh = vi.fn(async () => undefined);
  const controller = new TaskCaptureController(api, store);
  controller.setCallback(refresh); controller.setWritable(true); controllers.push(controller);
  return { controller, api, store, refresh };
}
async function start(value: ReturnType<typeof setup>, mode: "direct" | "transcript" = "transcript") {
  await value.controller.initialize();
  value.controller.updateInput({ mode, text: "今天下午整理资料" });
  await value.controller.start();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { controllers.splice(0).forEach((controller) => controller.dispose()); vi.useRealTimers(); });

describe("TaskCaptureController request recovery", () => {
  it("only reads status on a fresh load and never submits input automatically", async () => {
    const value = setup(); await value.controller.initialize();
    expect(value.api.status).toHaveBeenCalledOnce(); expect(value.api.create).not.toHaveBeenCalled(); expect(value.api.apply).not.toHaveBeenCalled();
  });
  it("keeps the exact original creation request across a lost response and retries only that identity", async () => {
    const value = setup(); value.api.create.mockRejectedValueOnce(lost);
    await start(value, "direct");
    const original = value.api.create.mock.calls[0]![0];
    expect(value.store.load()?.request).toEqual(original);
    expect(value.controller.getSnapshot().uncertainty).toBe("start");
    value.controller.updateInput({ text: "different" }); await value.controller.start();
    expect(value.api.create).toHaveBeenCalledOnce(); expect(value.controller.getSnapshot().text).toBe("今天下午整理资料");
    value.api.run.mockRejectedValueOnce(new HttpError("未找到", "NOT_FOUND", 404, false));
    await value.controller.confirm(); await value.controller.retryOriginal();
    expect(value.api.run).toHaveBeenCalledWith(original.requestId);
    expect(value.api.create).toHaveBeenNthCalledWith(2, original);
  });
  it("recovers a committed direct creation after refresh without another POST or duplicate refresh callbacks", async () => {
    const value = setup(); value.api.create.mockRejectedValueOnce(lost); await start(value, "direct");
    const original = value.api.create.mock.calls[0]![0]; value.controller.dispose();
    const restored = setup(value.store.load()); restored.api.run.mockResolvedValue(applied(run(original)));
    await restored.controller.initialize();
    expect(restored.api.run).toHaveBeenCalledWith(original.requestId); expect(restored.api.create).not.toHaveBeenCalled(); expect(restored.refresh).toHaveBeenCalledOnce();
    expect(restored.controller.getSnapshot().text).toBe(original.text);
    await restored.controller.confirm(); expect(restored.refresh).toHaveBeenCalledOnce();
    const remounted = setup(restored.store.load()); remounted.api.run.mockResolvedValue(applied(run(original))); await remounted.controller.initialize();
    expect(remounted.refresh).not.toHaveBeenCalled();
  });
  it("persists editable draft changes across refresh using only fresh server authority for the run", async () => {
    const value = setup(); await start(value);
    value.controller.updateEdit("draft-a", { title: "核对资料", selected: false, startDate: "2026-09-24", endDate: "2026-09-25" });
    const restored = setup(value.store.load()); restored.api.run.mockResolvedValue(value.controller.getSnapshot().run!); await restored.controller.initialize();
    expect(restored.controller.getSnapshot().edits[0]).toMatchObject({ title: "核对资料", selected: false, startDate: "2026-09-24", endDate: "2026-09-25" });
    expect(restored.api.apply).not.toHaveBeenCalled();
  });
  it("recovers a failed status lookup without losing restored ready edits or replaying writes", async () => {
    const value = setup(); await start(value); value.controller.updateEdit("draft-a", { title: "保留编辑" });
    const restored = setup(value.store.load());
    restored.api.status.mockRejectedValueOnce(new HttpError("稍后重试", "UNAVAILABLE", 503, true));
    restored.api.run.mockResolvedValue(value.controller.getSnapshot().run!); await restored.controller.initialize();
    expect(restored.controller.getSnapshot().run?.status).toBe("ready"); expect(restored.controller.getSnapshot().statusError).toBe("稍后重试");
    await restored.controller.retryStatus();
    expect(restored.controller.getSnapshot().status?.configured).toBe(true); expect(restored.controller.getSnapshot().statusError).toBeNull();
    expect(restored.controller.getSnapshot().edits[0]?.title).toBe("保留编辑"); expect(restored.api.create).not.toHaveBeenCalled(); expect(restored.api.apply).not.toHaveBeenCalled();
  });
  it("freezes the exact apply body during uncertainty and recovers the receipt after refresh", async () => {
    const value = setup(); await start(value);
    value.controller.updateEdit("draft-a", { title: "核对资料" }); value.api.apply.mockRejectedValueOnce(lost);
    await value.controller.apply(); const [captureId, original] = value.api.apply.mock.calls[0]!;
    value.controller.updateEdit("draft-a", { title: "不要改动待确认的提交" }); await value.controller.apply();
    expect(value.api.apply).toHaveBeenCalledOnce(); expect(value.store.load()?.pendingApply).toEqual(original);
    expect(value.controller.getSnapshot().edits[0]?.title).toBe("核对资料"); expect(value.refresh).not.toHaveBeenCalled();
    value.controller.dispose();
    const restored = setup(value.store.load()); restored.api.run.mockResolvedValue(applied(run({ requestId: captureId, mode: "transcript", text: "待办" }), original.operationId)); await restored.controller.initialize();
    expect(restored.api.apply).not.toHaveBeenCalled(); expect(restored.refresh).toHaveBeenCalledOnce(); expect(restored.store.load()?.pendingApply).toBeNull();
  });
  it("retries an uncertain apply using its exact operation and edited task body after GET returns ready", async () => {
    const value = setup(); await start(value); value.api.apply.mockRejectedValueOnce(lost);
    await value.controller.apply(); const original = value.api.apply.mock.calls[0]!;
    value.api.run.mockResolvedValue(value.controller.getSnapshot().run!); await value.controller.confirm(); await value.controller.retryOriginal();
    expect(value.api.apply.mock.calls[1]).toEqual(original); expect(value.refresh).toHaveBeenCalledOnce();
  });
  it("unlocks editable drafts when the server definitively rejects a write", async () => {
    const value = setup(); await start(value); value.api.apply.mockRejectedValueOnce(new HttpError("日期有误", "INVALID_REQUEST", 400, false));
    await value.controller.apply();
    expect(value.controller.getSnapshot().pendingApply).toBeNull(); expect(value.controller.getSnapshot().uncertainty).toBeNull();
    value.controller.updateEdit("draft-a", { title: "修改后的资料" }); expect(value.controller.getSnapshot().edits[0]?.title).toBe("修改后的资料");
    await value.controller.apply(); expect(value.api.apply.mock.calls[0]![1].operationId).not.toBe(value.api.apply.mock.calls[1]![1].operationId);
  });
  it("never treats a model success message or malformed receipt as proof of creation", async () => {
    const value = setup(); value.api.create.mockImplementation(async (request) => ({ ...run(request), message: "已经成功添加了待办" })); await start(value);
    expect(value.refresh).not.toHaveBeenCalled();
    value.api.apply.mockResolvedValue({ ...value.controller.getSnapshot().run!, status: "applied", receipt: null }); await value.controller.apply();
    expect(value.refresh).not.toHaveBeenCalled(); expect(value.controller.getSnapshot().uncertainty).toBe("apply");
  });
  it("blocks all writes when session recovery cannot be saved", async () => {
    const value = setup(); await value.controller.initialize(); value.controller.updateInput({ text: "今天整理资料" });
    value.store.save = () => { throw new Error("quota"); }; await value.controller.start();
    expect(value.api.create).not.toHaveBeenCalled(); expect(value.controller.getSnapshot().error).toContain("恢复信息");
  });
  it("ignores a creation response after the date-keyed component is disposed", async () => {
    const value = setup(); await value.controller.initialize(); value.controller.updateInput({ text: "今天整理资料" });
    const pending = deferred<CaptureRun>(); value.api.create.mockReturnValueOnce(pending.promise); const sending = value.controller.start();
    const original = value.api.create.mock.calls[0]![0]; value.controller.dispose(); pending.resolve(applied(run(original))); await sending;
    expect(value.refresh).not.toHaveBeenCalled(); expect(value.store.load()?.notifiedOperationId).toBeNull();
  });
  it("requires an explicit new request after a failed model run", async () => {
    const value = setup(); value.api.create.mockImplementationOnce(async (request) => ({ ...run(request), status: "failed", error: "模型超时" })); await start(value);
    await value.controller.start(); expect(value.api.create).toHaveBeenCalledOnce();
    value.controller.newCapture(false); await value.controller.start();
    expect(value.api.create.mock.calls[0]![0].requestId).not.toBe(value.api.create.mock.calls[1]![0].requestId);
  });
  it("keeps cleared operation replay terminal and removes persisted input and pending writes", async () => {
    const value = setup(); await start(value);
    value.api.apply.mockResolvedValue({ ...value.controller.getSnapshot().run!, status: "details_deleted", drafts: [], receipt: null, message: "记录已清理" }); await value.controller.apply();
    expect(value.controller.getSnapshot().uncertainty).toBeNull(); expect(value.store.load()).toMatchObject({ text: "", request: null, pendingApply: null });
    value.controller.newCapture(); expect(value.controller.getSnapshot().run).toBeNull();
  });
  it("polls running captures and accepts the persisted receipt", async () => {
    vi.useFakeTimers(); const value = setup(); value.api.create.mockImplementationOnce(async (request) => ({ ...run(request), status: "running", drafts: [] })); await start(value, "direct");
    value.api.run.mockResolvedValue(applied(run(value.api.create.mock.calls[0]![0]))); await vi.advanceTimersByTimeAsync(1000);
    expect(value.api.run).toHaveBeenCalledOnce(); expect(value.refresh).toHaveBeenCalledOnce();
  });
});
