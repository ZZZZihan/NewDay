import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_NAMESPACES, type AgentPreferences } from "@newday/core/contracts/agent-planning";
import { CAPTURE_NAMESPACES, type ApplyCaptureRequest, type CaptureModelOutput, type CaptureRun } from "@newday/core/contracts/task-capture";
import type { CaptureModelGeneration, TaskCaptureModel } from "../src/agent/task-capture-model.js";
import { TaskCaptureService, clearTaskCaptureHistory } from "../src/services/task-capture-service.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";
import { createApp } from "../src/app.js";
import { now, task, today } from "./fixtures.js";

const clock = () => Date.parse(now);
const source = "今天整理项目，明天交报告。";
const draft = (overrides: Partial<CaptureModelOutput["drafts"][number]> = {}): CaptureModelOutput["drafts"][number] => ({
  title: "整理项目", notes: "", startDate: today, endDate: today, sourceText: "今天整理项目", needsReview: false, ...overrides,
});
const generation = (output: unknown): CaptureModelGeneration => ({ output, modelId: "capture-test", usage: { kind: "unknown" } });
const model = (drafts = [draft()]): TaskCaptureModel => ({ modelId: "capture-test", generate: async () => generation({ drafts, message: "提取完成" }) });
const code = (expected: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === expected;
async function seed(store: SQLitePlannerStore, timeZone = "Asia/Shanghai") {
  const preferences: AgentPreferences = { revision: 1, timeZone, learningEnabled: false, explicitPreferences: [], updatedAt: now };
  await store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", preferences);
}
function applyRequest(run: CaptureRun, operationId = "operation"): ApplyCaptureRequest {
  return { operationId, tasks: run.drafts.map((entry) => ({ draftId: entry.id, title: entry.title, notes: entry.notes,
    startDate: entry.startDate ?? today, endDate: entry.endDate ?? today })) };
}
async function ready(service: TaskCaptureService, requestId = "request", mode: "direct" | "transcript" = "transcript") {
  const run = await service.create({ requestId, mode, text: source });
  await service.whenSettled(run.captureId);
  return service.get(run.captureId);
}
function deferredModel() {
  let finish!: (value: CaptureModelGeneration) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise<CaptureModelGeneration>((resolve) => { finish = resolve; });
  const captureModel: TaskCaptureModel = { modelId: "deferred", generate: async () => { started(); return pending; } };
  return { model: captureModel, started: startedPromise, finish: () => finish(generation({ drafts: [draft()], message: "" })) };
}

test("direct capture creates multiple tasks atomically with source events and replayable results", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const service = new TaskCaptureService(store, model([draft(), draft({ title: "交报告", startDate: "2026-09-09", endDate: "2026-09-09", sourceText: "明天交报告" })]), { clock });
  try {
    await seed(store);
    const run = await ready(service, "batch", "direct");
    assert.equal(run.captureId, "batch");
    assert.equal(run.status, "applied");
    assert.equal(run.receipt?.tasks.length, 2);
    assert.equal((await store.listAllTasks()).length, 2);
    assert.ok((await store.listPlannerEvents()).every((event) => event.source === "agent" && event.operationId === run.receipt?.operationId));
    assert.deepEqual(await service.create({ requestId: "batch", mode: "direct", text: source }), run);
    assert.equal((await store.listAllTasks()).length, 2);
    assert.equal("source" in run, false);
  } finally { await service.close(); store.close(); }
});

test("transcript always requires reviewed apply; selected edited drafts use one durable operation", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const service = new TaskCaptureService(store, model([draft(), draft({ title: "交报告", sourceText: "明天交报告" })]), { clock });
  try {
    await seed(store);
    const run = await ready(service);
    assert.equal(run.status, "ready");
    assert.equal((await store.listAllTasks()).length, 0);
    const request = applyRequest(run);
    request.tasks = [{ ...request.tasks[1], title: "提交最终报告", notes: "下午三点", startDate: "2026-09-10", endDate: "2026-09-10" }];
    const applied = await service.apply(run.captureId, request);
    assert.equal(applied.status, "applied");
    assert.equal(applied.receipt?.tasks[0].title, "提交最终报告");
    assert.deepEqual(await service.apply(run.captureId, request), applied);
    await assert.rejects(service.apply(run.captureId, { ...request, tasks: [{ ...request.tasks[0], title: "different" }] }), code("IDEMPOTENCY_CONFLICT"));
    await assert.rejects(service.apply(run.captureId, { ...request, operationId: "new-id" }), code("PROPOSAL_NOT_EXECUTABLE"));
    assert.equal((await store.listAllTasks()).length, 1);
  } finally { await service.close(); store.close(); }
});

test("same create request ID with changed source or mode conflicts without another model call", async () => {
  const store = new SQLitePlannerStore(":memory:");
  let calls = 0;
  const service = new TaskCaptureService(store, { modelId: "counted", generate: async () => { calls++; return generation({ drafts: [], message: "没有待办" }); } }, { clock });
  try {
    await seed(store);
    const run = await ready(service);
    assert.equal(run.status, "ready");
    assert.deepEqual(run.drafts, []);
    await assert.rejects(service.create({ requestId: "request", mode: "direct", text: source }), code("IDEMPOTENCY_CONFLICT"));
    await assert.rejects(service.create({ requestId: "request", mode: "transcript", text: "different" }), code("IDEMPOTENCY_CONFLICT"));
    assert.equal(calls, 1);
  } finally { await service.close(); store.close(); }
});

for (const scenario of ["missing-date", "review", "existing", "repeated"] as const) {
  test(`direct extraction remains reviewable for ${scenario}`, async () => {
    const store = new SQLitePlannerStore(":memory:");
    const drafts = scenario === "missing-date" ? [draft({ startDate: null, endDate: null })]
      : scenario === "review" ? [draft({ needsReview: true })]
      : scenario === "repeated" ? [draft(), draft({ title: " 整理项目 " })] : [draft()];
    const service = new TaskCaptureService(store, model(drafts), { clock });
    try {
      await seed(store);
      if (scenario === "existing") await store.putTask(task("existing"));
      const run = await ready(service, "request", "direct");
      assert.equal(run.status, "ready");
      assert.equal(run.drafts.length, 1);
      assert.equal(run.drafts[0].needsReview, true);
      assert.equal((await store.listAllTasks()).length, scenario === "existing" ? 1 : 0);
    } finally { await service.close(); store.close(); }
  });
}

for (const output of [
  { drafts: [draft({ sourceText: "编造的原文" })], message: "" },
  { drafts: [draft({ startDate: "2026-09-10", endDate: today })], message: "" },
  { drafts: [draft({ startDate: "2026-02-30" })], message: "" },
  { drafts: [draft()], message: "", executableCommand: "create" },
]) {
  test("invalid model data fails without any task write", async () => {
    const store = new SQLitePlannerStore(":memory:");
    const service = new TaskCaptureService(store, { modelId: "invalid", generate: async () => generation(output) }, { clock });
    try {
      await seed(store);
      const run = await ready(service, "request", "direct");
      assert.equal(run.status, "failed");
      assert.equal(run.receipt, null);
      assert.equal((await store.listAllTasks()).length, 0);
    } finally { await service.close(); store.close(); }
  });
}

test("date, timezone and imported dataset changes reject apply and fence late automatic execution", async () => {
  for (const change of ["date", "timezone", "epoch"] as const) {
    for (const late of [false, true]) {
      const store = new SQLitePlannerStore(":memory:");
      const deferred = deferredModel();
      let time = clock();
      const service = new TaskCaptureService(store, late ? deferred.model : model(), { clock: () => time });
      try {
        await seed(store);
        const run = late ? await service.create({ requestId: "request", mode: "direct", text: source }) : await ready(service);
        if (late) await deferred.started;
        if (change === "date") time += 86_400_000;
        if (change === "timezone") await seed(store, "UTC");
        if (change === "epoch") await store.replaceAllData({ tasks: [] });
        if (late) {
          deferred.finish();
          await service.whenSettled(run.captureId);
          assert.equal((await service.get(run.captureId)).status, "failed");
        } else await assert.rejects(service.apply(run.captureId, applyRequest(run)), code(change === "epoch" ? "VERSION_CONFLICT" : "DATE_EXPIRED"));
        assert.equal((await store.listAllTasks()).length, 0);
      } finally { await service.close(); store.close(); }
    }
  }
});

test("model waiting does not hold SQLite transaction and cancellation fences ignored abort", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const deferred = deferredModel();
  const service = new TaskCaptureService(store, deferred.model, { clock });
  try {
    await seed(store);
    const run = await service.create({ requestId: "request", mode: "direct", text: source });
    await deferred.started;
    await store.putTask(task("manual"));
    await assert.rejects(service.create({ requestId: "other", mode: "direct", text: source }), code("RUN_ACTIVE"));
    assert.equal((await service.cancel(run.captureId)).status, "interrupted");
    await service.whenSettled(run.captureId);
    deferred.finish();
    assert.equal((await service.get(run.captureId)).status, "interrupted");
    assert.equal((await store.listAllTasks()).length, 1);
  } finally { await service.close(); store.close(); }
});

test("timeouts and shutdown settle even when provider ignores abort", async () => {
  for (const shutdown of [false, true]) {
    const store = new SQLitePlannerStore(":memory:");
    const deferred = deferredModel();
    const service = new TaskCaptureService(store, deferred.model, { clock, timeoutMs: shutdown ? 30_000 : 10 });
    try {
      await seed(store);
      const run = await service.create({ requestId: "request", mode: "direct", text: source });
      await deferred.started;
      if (shutdown) await service.close();
      else await service.whenSettled(run.captureId);
      assert.equal((await service.get(run.captureId)).status, shutdown ? "interrupted" : "failed");
      assert.equal((await store.listAllTasks()).length, 0);
      deferred.finish();
    } finally { await service.close(); store.close(); }
  }
});

for (const point of ["before_event", "before_commit"] as const) {
  test(`${point} rolls back all created tasks, events, receipt and applied state`, async () => {
    const store = new SQLitePlannerStore(":memory:");
    const service = new TaskCaptureService(store, model([draft(), draft({ title: "交报告", sourceText: "明天交报告" })]), { clock });
    try {
      await seed(store);
      const run = await ready(service);
      const request = applyRequest(run);
      const before = await store.getPlanningVersion();
      store.setFailureInjector((at) => { if (at === point) throw new Error("injected capture failure"); });
      await assert.rejects(service.apply(run.captureId, request), /injected capture failure/);
      store.setFailureInjector();
      assert.equal((await store.listAllTasks()).length, 0);
      assert.deepEqual(await store.getPlanningVersion(), before);
      assert.equal((await store.listPlannerEvents()).length, 0);
      assert.equal((await store.listAgentRecords(CAPTURE_NAMESPACES.operations)).length, 0);
      assert.equal((await service.get(run.captureId)).status, "ready");
      assert.equal((await service.apply(run.captureId, request)).receipt?.tasks.length, 2);
    } finally { store.setFailureInjector(); await service.close(); store.close(); }
  });
}

test("lost commit acknowledgement and process restart replay the original receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-capture-test-"));
  const path = join(directory, "planner.sqlite");
  let store = new SQLitePlannerStore(path);
  let service = new TaskCaptureService(store, model(), { clock });
  try {
    await seed(store);
    const run = await ready(service);
    const request = applyRequest(run);
    store.setFailureInjector((point) => { if (point === "after_commit") throw new Error("lost response"); });
    await assert.rejects(service.apply(run.captureId, request), /lost response/);
    store.setFailureInjector();
    const receipt = (await service.get(run.captureId)).receipt;
    await service.close();
    store.close();
    store = new SQLitePlannerStore(path);
    service = new TaskCaptureService(store, model(), { clock });
    assert.deepEqual((await service.apply(run.captureId, request)).receipt, receipt);
    assert.equal((await store.listAllTasks()).length, 1);
  } finally { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("history clearing scrubs private source and receipts while preserving both replay fences", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const service = new TaskCaptureService(store, model(), { clock });
  try {
    await seed(store);
    const run = await ready(service);
    const request = applyRequest(run);
    await service.apply(run.captureId, request);
    await clearTaskCaptureHistory(store);
    await clearTaskCaptureHistory(store);
    const recovered = await service.create({ requestId: "request", mode: "transcript", text: source });
    assert.equal(recovered.status, "details_deleted");
    assert.deepEqual(recovered.drafts, []);
    assert.equal(recovered.receipt, null);
    assert.equal((await service.apply(run.captureId, request)).status, "details_deleted");
    await assert.rejects(service.apply(run.captureId, { ...request, operationId: "new" }), code("PROPOSAL_NOT_EXECUTABLE"));
    const records = JSON.stringify([await store.listAgentRecords(CAPTURE_NAMESPACES.runs), await store.listAgentRecords(CAPTURE_NAMESPACES.operations)]);
    assert.equal(records.includes("整理项目"), false);
    assert.equal((await store.listAllTasks()).length, 1);
  } finally { await service.close(); store.close(); }
});

test("history clearing while a model call is pending prevents its late automatic write", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const deferred = deferredModel();
  const service = new TaskCaptureService(store, deferred.model, { clock });
  try {
    await seed(store);
    const run = await service.create({ requestId: "request", mode: "direct", text: source });
    await deferred.started;
    await clearTaskCaptureHistory(store);
    deferred.finish();
    await service.whenSettled(run.captureId);
    assert.equal((await service.get(run.captureId)).status, "details_deleted");
    assert.equal((await store.listAllTasks()).length, 0);
  } finally { await service.close(); store.close(); }
});

test("unknown draft IDs and duplicate selected content are rejected before writes", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const service = new TaskCaptureService(store, model([draft(), draft({ title: "交报告", sourceText: "明天交报告" })]), { clock });
  try {
    await seed(store);
    const run = await ready(service);
    const request = applyRequest(run);
    await assert.rejects(service.apply(run.captureId, { ...request, tasks: [{ ...request.tasks[0], draftId: "other" }] }), code("INVALID_INPUT"));
    await assert.rejects(service.apply(run.captureId, { ...request, tasks: [request.tasks[0], { ...request.tasks[0], draftId: request.tasks[1].draftId }] }), code("INVALID_INPUT"));
    assert.equal((await store.listAllTasks()).length, 0);
  } finally { await service.close(); store.close(); }
});

test("HTTP routes report configuration, require timezone and recover a capture by client request ID", async () => {
  const app = createApp({ databasePath: ":memory:", planningModel: null, captureModel: model(), clock, notionOAuth: null });
  try {
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/agent/captures/status" })).json(), { configured: true, modelId: "capture-test" });
    const input = { requestId: "http-request", mode: "transcript", text: source };
    assert.equal((await app.inject({ method: "POST", url: "/api/agent/captures", payload: input })).json().code, "TIME_ZONE_REQUIRED");
    const prefs = (await app.inject({ method: "GET", url: "/api/agent/preferences" })).json();
    assert.equal((await app.inject({ method: "PUT", url: "/api/agent/preferences", payload: {
      expectedRevision: prefs.revision, timeZone: "Asia/Shanghai", learningEnabled: false, explicitPreferences: [],
    } })).statusCode, 200);
    const response = await app.inject({ method: "POST", url: "/api/agent/captures", payload: input });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().captureId, input.requestId);
    const recovered = await app.inject({ method: "GET", url: `/api/agent/captures/${input.requestId}` });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().captureId, input.requestId);
    const cancelled = await app.inject({ method: "POST", url: `/api/agent/captures/${input.requestId}/cancel`, payload: {} });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().status, "interrupted");
  } finally { await app.close(); }
});

test("same-day same-title tasks with distinct time notes remain separate and can be explicitly added", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const service = new TaskCaptureService(store, model([
    draft({ notes: "09:00", sourceText: "今天整理项目" }),
    draft({ notes: "21:00", sourceText: "今天整理项目" }),
  ]), { clock });
  try {
    await seed(store);
    const run = await ready(service, "request", "direct");
    assert.equal(run.status, "ready");
    assert.equal(run.drafts.length, 2);
    assert.ok(run.drafts.every((entry) => entry.needsReview));
    assert.equal((await store.listAllTasks()).length, 0);
    const applied = await service.apply(run.captureId, applyRequest(run));
    assert.deepEqual(applied.receipt?.tasks.map((entry) => entry.notes), ["09:00", "21:00"]);
    assert.equal((await store.listAllTasks()).length, 2);
  } finally { await service.close(); store.close(); }
});

test("automatic creation preserves the exact source excerpt in task notes", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const timeSource = "今天15:00开会";
  const service = new TaskCaptureService(store, model([draft({ title: "开会", notes: "准备报告", sourceText: timeSource })]), { clock });
  try {
    await seed(store);
    const run = await service.create({ requestId: "time-source", mode: "direct", text: timeSource });
    await service.whenSettled(run.captureId);
    const result = await service.get(run.captureId);
    assert.equal(result.status, "applied");
    assert.equal(result.receipt?.tasks[0].notes, `准备报告\n${timeSource}`);
  } finally { await service.close(); store.close(); }
});

test("maximum length request IDs still produce valid bounded automatic operation IDs", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const service = new TaskCaptureService(store, model(), { clock });
  try {
    await seed(store);
    const run = await ready(service, "r".repeat(200), "direct");
    assert.equal(run.status, "applied");
    assert.ok(run.receipt!.operationId.length <= 200);
  } finally { await service.close(); store.close(); }
});
