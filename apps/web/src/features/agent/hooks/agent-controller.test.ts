import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResponse, ApplyProposalResponse } from "@newday/core/contracts/agent-planning";
import { HttpError } from "@/shared/http/request";
import { AgentController } from "./agent-controller";
import { operationId } from "./agent-session";
import {
  clarificationProposalFixture, deferred, fixtureDate, fixtureNow, makeApi,
  operationDetailsDeletedFixture, receiptFixture, runResponseFixture, sessionStore,
} from "../__tests__/fixtures";

const controllers: AgentController[] = [];
function setup(initial?: Parameters<typeof sessionStore>[0]) {
  const api = makeApi();
  const store = sessionStore(initial);
  const refresh = vi.fn(async () => undefined);
  const changed = vi.fn();
  let id = 0;
  const controller = new AgentController(fixtureDate, api, store, refresh, changed, () => `client-id-${++id}`);
  controllers.push(controller);
  return { api, store, refresh, changed, controller };
}
beforeEach(() => { vi.setSystemTime(new Date(fixtureNow)); });
afterEach(() => { controllers.splice(0).forEach((controller) => controller.dispose()); vi.useRealTimers(); });

describe("AgentController reliable request ownership", () => {
  it("does not write preferences, context, tasks or call the model on initial load", async () => {
    const { api, controller } = setup();
    await controller.initialize();
    expect(api.savePreferences).not.toHaveBeenCalled();
    expect(api.saveContext).not.toHaveBeenCalled();
    expect(api.createRun).not.toHaveBeenCalled();
    expect(api.apply).not.toHaveBeenCalled();
  });
  it("generates suggestions without task writes and refreshes only after a committed receipt", async () => {
    const { api, store, refresh, controller } = setup();
    await controller.initialize(); await controller.start();
    expect(api.apply).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
    const pending = deferred<ApplyProposalResponse>(); api.apply.mockReturnValue(pending.promise);
    const applying = controller.apply();
    await vi.waitFor(() => expect(api.apply).toHaveBeenCalled());
    expect(store.load()?.pending?.kind).toBe("apply");
    expect(refresh).not.toHaveBeenCalled();
    await controller.apply(); expect(api.apply).toHaveBeenCalledTimes(1);
    const request = api.apply.mock.calls[0]![0];
    pending.resolve({ ...receiptFixture, operationId: request.operationId }); await applying;
    expect(refresh).toHaveBeenCalledTimes(1); expect(store.load()?.pending).toBeUndefined();
  });
  it("preserves the submitted operation ID on timeout, never creates another apply, and reconciles after reload", async () => {
    const { api, store, refresh, controller } = setup();
    await controller.initialize(); await controller.start();
    api.apply.mockRejectedValue(new HttpError("lost response", "RESULT_UNKNOWN", 0, true));
    await controller.apply();
    const original = api.apply.mock.calls[0]![0];
    expect(api.operation).toHaveBeenCalledWith(original.operationId);
    expect(controller.getSnapshot().errorCode).toBe("RESULT_UNKNOWN");
    expect(refresh).not.toHaveBeenCalled();
    await controller.apply(); expect(api.apply).toHaveBeenCalledTimes(1);
    controller.dispose();
    const afterReload = setup(store.load());
    afterReload.api.operation.mockResolvedValue({ status: "found", receipt: { ...receiptFixture, operationId: original.operationId } });
    await afterReload.controller.initialize();
    expect(afterReload.api.operation).toHaveBeenCalledWith(original.operationId);
    expect(afterReload.api.apply).not.toHaveBeenCalled();
    expect(afterReload.refresh).toHaveBeenCalledTimes(1);
    expect(afterReload.controller.getSnapshot().pending).toBeNull();
  });
  it("treats a known version conflict as rejection and invalidates the stale proposal", async () => {
    const { api, refresh, controller } = setup();
    await controller.initialize(); await controller.start();
    api.apply.mockRejectedValue(new HttpError("任务已经变化", "VERSION_CONFLICT", 409, false));
    await controller.apply();
    expect(controller.getSnapshot().pending).toBeNull();
    expect(controller.getSnapshot().run?.proposal?.lifecycle).toBe("expired");
    expect(api.operation).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
    await controller.apply(); expect(api.apply).toHaveBeenCalledTimes(1);
  });
  it("ignores an old generation response after input changes and cancels the late run", async () => {
    const { api, controller } = setup(); await controller.initialize();
    const pending = deferred<AgentRunResponse>(); api.createRun.mockReturnValue(pending.promise);
    const starting = controller.start();
    await vi.waitFor(() => expect(api.createRun).toHaveBeenCalled());
    controller.updateDraft({ goals: "新的目标" });
    pending.resolve(runResponseFixture); await starting;
    expect(controller.getSnapshot().draft.goals).toBe("新的目标");
    expect(controller.getSnapshot().run).toBeNull();
    expect(api.cancel).toHaveBeenCalledWith(runResponseFixture.run.runId);
  });
  it("ignores run responses belonging to a disposed date view", async () => {
    const { api, controller } = setup(); await controller.initialize();
    const pending = deferred<AgentRunResponse>(); api.createRun.mockReturnValue(pending.promise);
    const starting = controller.start(); await vi.waitFor(() => expect(api.createRun).toHaveBeenCalled());
    controller.dispose(); pending.resolve(runResponseFixture); await starting;
    expect(controller.getSnapshot().run).toBeNull();
  });
  it("restores a run by stable run ID and a lost create response by original request ID", async () => {
    const existing = setup({ date: fixtureDate, requestId: "request-original", runId: "run-original" });
    await existing.controller.initialize();
    expect(existing.api.run).toHaveBeenCalledWith("run-original");
    expect(existing.api.createRun).not.toHaveBeenCalled();
    const lost = setup({ date: fixtureDate, requestId: "request-lost" });
    await lost.controller.initialize();
    expect(lost.api.createRun).toHaveBeenCalledWith({ requestId: "request-lost" });
  });
  it("limits selection to one through three executable tasks and sends the final chosen set", async () => {
    const { api, controller } = setup(); await controller.initialize(); await controller.start();
    controller.selectTask("task-blocked"); expect(controller.getSnapshot().selectedTaskIds).not.toContain("task-blocked");
    controller.selectTask("task-other"); expect(controller.getSnapshot().selectedTaskIds).toHaveLength(3);
    controller.selectTask("task-report"); controller.selectTask("task-check"); controller.selectTask("task-other");
    await controller.apply(); expect(api.apply).not.toHaveBeenCalled();
    controller.selectTask("task-other"); await controller.apply();
    expect(api.apply.mock.calls[0]?.[0].taskIds).toEqual(["task-other"]);
  });
  it("does not apply across midnight in the configured planning timezone", async () => {
    const { api, controller } = setup(); await controller.initialize(); await controller.start();
    api.status.mockResolvedValue({ configured: true, modelId: "scripted-fake", today: "2026-09-09", timeZone: "Asia/Shanghai" });
    await controller.apply(); expect(api.apply).not.toHaveBeenCalled();
    expect(controller.getSnapshot().errorCode).toBe("DATE_EXPIRED");
  });
  it("records rejection without applying and keeps it rejected after reading the run again", async () => {
    const { api, refresh, controller } = setup(); await controller.initialize(); await controller.start();
    await controller.feedback("proposal-fixture", "rejected", "今天更想处理别的事");
    expect(api.feedback.mock.calls[0]?.[0].decision).toBe("rejected");
    expect(controller.getSnapshot().run?.proposal?.lifecycle).toBe("rejected");
    expect(api.apply).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });
  it("passes unknown answers explicitly for the single clarification round", async () => {
    const { api, controller } = setup();
    api.createRun.mockResolvedValue({ ...runResponseFixture, run: { ...runResponseFixture.run, status: "needs_clarification" }, proposal: clarificationProposalFixture });
    await controller.initialize(); await controller.start(); await controller.answer({});
    expect(api.answer.mock.calls[0]?.[1].answers).toEqual([{ questionId: "question-priority", answer: "不知道" }]);
    expect(api.apply).not.toHaveBeenCalled();
  });
  it("does not invent details or offer recovery when only the execution terminal remains", async () => {
    const { api, refresh, controller } = setup(); await controller.initialize(); await controller.start();
    api.apply.mockResolvedValue(operationDetailsDeletedFixture); await controller.apply();
    expect(controller.getSnapshot().detailsDeleted).toBe(true);
    expect(controller.getSnapshot().receipt).toBeNull(); expect(refresh).not.toHaveBeenCalled();
  });
  it("persists and reconciles a revert as a new operation without resubmitting it", async () => {
    const { api, store, controller } = setup(); await controller.initialize();
    api.revert.mockRejectedValue(new HttpError("timeout", "RESULT_UNKNOWN", 0, true));
    await controller.revert(receiptFixture);
    const pending = store.load()!.pending!;
    expect(pending.kind).toBe("revert"); expect(operationId(pending)).not.toBe(receiptFixture.operationId);
    expect(api.operation).toHaveBeenCalledWith(operationId(pending));
    await controller.revert(receiptFixture); expect(api.revert).toHaveBeenCalledTimes(1);
  });
  it("does not submit writes when the recovery identity cannot be persisted", async () => {
    const { api, store, controller } = setup(); await controller.initialize(); await controller.start();
    store.save = () => { throw new Error("quota exceeded"); };
    await controller.apply(); expect(api.apply).not.toHaveBeenCalled();
    expect(controller.getSnapshot().errorCode).toBe("LOCAL_STORAGE_UNAVAILABLE");
  });
  it("does not call a fake model when configuration is missing", async () => {
    const { api, controller } = setup();
    api.status.mockResolvedValue({ configured: false, modelId: null, today: fixtureDate, timeZone: "Asia/Shanghai" });
    await controller.initialize(); await controller.start();
    expect(controller.getSnapshot().errorCode).toBe("MODEL_UNAVAILABLE");
    expect(api.createRun).not.toHaveBeenCalled(); expect(api.saveContext).not.toHaveBeenCalled();
  });
  it("recovers and cancels an unknown create by original request before starting after edited input", async () => {
    const { api, controller, store } = setup(); await controller.initialize();
    api.createRun.mockRejectedValueOnce(new HttpError("lost create", "RESULT_UNKNOWN", 0, true));
    await controller.start();
    const originalId = api.createRun.mock.calls[0]![0].requestId;
    controller.updateDraft({ goals: "新的目标" });
    expect(store.load()?.abandonedRun?.requestId).toBe(originalId);
    await controller.start();
    expect(api.createRun.mock.calls[1]![0].requestId).toBe(originalId);
    expect(api.cancel).toHaveBeenCalledWith(runResponseFixture.run.runId);
    expect(api.createRun.mock.calls[2]![0].requestId).not.toBe(originalId);
    expect(api.saveContext.mock.calls.at(-1)?.[0].goals).toEqual(["新的目标"]);
  });
  it("keeps the exact clarification request on timeout and recovers it on reload", async () => {
    const clarification: AgentRunResponse = { ...runResponseFixture, run: { ...runResponseFixture.run, status: "needs_clarification" }, proposal: clarificationProposalFixture };
    const { api, store, controller } = setup();
    api.createRun.mockResolvedValue(clarification); api.run.mockResolvedValue(clarification);
    await controller.initialize(); await controller.start();
    api.answer.mockRejectedValue(new HttpError("lost answer", "RESULT_UNKNOWN", 0, true));
    await controller.answer({ "question-priority": "先整理材料" });
    const original = api.answer.mock.calls[0]![1];
    expect(store.load()?.answer?.request).toEqual(original);
    await controller.answer({ "question-priority": "changed after timeout" });
    expect(api.answer.mock.calls[1]![1]).toEqual(original);
    const reloaded = setup(store.load());
    await reloaded.controller.initialize();
    expect(reloaded.api.run).toHaveBeenCalled();
    expect(reloaded.controller.getSnapshot().answerPending).toBe(false);
    expect(reloaded.api.answer).not.toHaveBeenCalled();
  });
  it("lets explicit task constraints be added and removed and sends their exact user source", async () => {
    const { api, controller } = setup(); await controller.initialize();
    controller.setTaskConstraint("task-blocked", "blocked_task", null);
    controller.setTaskConstraint("task-report", "must_include", "今天必须纳入项目汇报");
    controller.setTaskConstraint("task-check", "hard_deadline", "今天18点前交核对结果");
    await controller.start();
    expect(api.saveContext.mock.calls[0]?.[0].constraints).toEqual([
      expect.objectContaining({ taskId: "task-report", kind: "must_include", source: "user", sourceText: "今天必须纳入项目汇报" }),
      expect.objectContaining({ taskId: "task-check", kind: "hard_deadline", source: "user", sourceText: "今天18点前交核对结果" }),
    ]);
  });
  it("uses server today even when the browser clock is wrong", async () => {
    const { api, controller } = setup(); await controller.initialize();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    await controller.start(); await controller.apply();
    expect(api.apply).toHaveBeenCalledTimes(1);
  });
  it("rechecks an unknown outcome before deliberately retrying the exact original operation", async () => {
    const { api, controller } = setup(); await controller.initialize(); await controller.start();
    api.apply.mockRejectedValueOnce(new HttpError("not delivered", "RESULT_UNKNOWN", 0, true));
    await controller.apply();
    const original = api.apply.mock.calls[0]![0];
    expect(controller.getSnapshot().canRetryPending).toBe(true);
    controller.selectTask("task-other");
    await controller.retryPendingOperation();
    expect(api.operation).toHaveBeenCalledTimes(2);
    expect(api.apply.mock.calls[1]![0]).toEqual(original);
    expect(controller.getSnapshot().pending).toBeNull();
  });
  it("consumes a late receipt instead of resubmitting when the deliberate retry first finds it", async () => {
    const { api, controller, refresh } = setup(); await controller.initialize(); await controller.start();
    api.apply.mockRejectedValueOnce(new HttpError("lost", "RESULT_UNKNOWN", 0, true));
    await controller.apply();
    api.operation.mockResolvedValue({ status: "found", receipt: receiptFixture });
    await controller.retryPendingOperation();
    expect(api.apply).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1);
  });
});
