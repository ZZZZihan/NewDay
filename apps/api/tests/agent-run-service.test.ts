import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import { ZodError } from "zod";
import {
  AGENT_NAMESPACES, agentRunResponseSchema, type AgentRun, type PlanningProposal, type PlanningSnapshot,
} from "@newday/core/contracts/agent-planning";
import { clarificationOutputFixture, fixtureNow, readyOutputFixture, runFixture, snapshotFixture } from "../../../tests/agent/fixtures/contracts.js";
import { AgentApiError } from "../src/http/agent-error.js";
import { registerAgentRunRoutes } from "../src/http/agent-run-routes.js";
import { ScriptedPlanningModel } from "../src/agent/scripted-planning-model.js";
import type { ModelGeneration, PlanningModel } from "../src/agent/planning-model.js";
import { AgentRunService } from "../src/services/agent-run-service.js";
import { PlannerService } from "../src/services/planner-service.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";
import { createTask } from "./fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
const generation = (output: unknown = readyOutputFixture): ModelGeneration => ({ output, modelId: "actual-model-id", usage: { kind: "known", inputTokens: 10, outputTokens: 20 } });

async function setup(t: TestContext, model: PlanningModel | null, options: { snapshot?: PlanningSnapshot; timeoutMs?: number } = {}) {
  const store = new SQLitePlannerStore(":memory:");
  const snapshot = structuredClone(options.snapshot ?? snapshotFixture);
  let time = Date.parse(fixtureNow);
  let snapshots = 0;
  await store.transaction(async () => {
    for (const candidate of snapshot.candidates) await store.putTask(candidate.task);
    for (const taskId of snapshot.currentFocusTaskIds) await store.putFocusRecord({ id: `focus-${taskId}`, date: snapshot.date, taskId, focusedAt: fixtureNow });
    await store.putAgentRecord(AGENT_NAMESPACES.context, snapshot.context.id, snapshot.context);
    await store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", snapshot.preferences);
  });
  const source = { createSnapshot: () => store.transaction(async () => {
    const result = { ...structuredClone(snapshot), id: `snapshot-${++snapshots}`, version: await store.getPlanningVersion() };
    await store.putAgentRecord(AGENT_NAMESPACES.snapshot, result.id, result);
    return result;
  }) };
  const service = new AgentRunService(store, source, model, { clock: () => time, timeoutMs: options.timeoutMs });
  t.after(async () => { await service.close(); store.close(); });
  const businessState = async () => ({ tasks: await store.listAllTasks(), focus: await store.listAllFocusRecords(), version: await store.getPlanningVersion(), events: await store.listPlannerEvents() });
  return { store, service, snapshot, source, businessState, setTime: (next: number) => { time = next; }, snapshotCount: () => snapshots };
}

test("generation persists run and proposal without changing business data; duplicate requests recover the same run", async (t) => {
  const model = new ScriptedPlanningModel(() => generation());
  const h = await setup(t, model);
  const before = await h.businessState();
  const [first, duplicate] = await Promise.all([h.service.create({ requestId: "same" }), h.service.create({ requestId: "same" })]);
  assert.equal(first.run.runId, duplicate.run.runId);
  await h.service.whenSettled(first.run.runId);
  const result = await h.service.get(first.run.runId);
  agentRunResponseSchema.parse(result);
  assert.equal(result.run.status, "ready");
  assert.equal(result.run.modelId, "actual-model-id");
  assert.deepEqual(result.run.usage, { kind: "known", inputTokens: 10, outputTokens: 20 });
  assert.equal(result.proposal?.lifecycle, "ready");
  assert.equal(model.calls.length, 1);
  assert.equal(h.snapshotCount(), 1);
  assert.deepEqual(await h.businessState(), before);
});

test("a slow model does not hold the planner queue or SQLite transaction; only one active run is allowed", async (t) => {
  const entered = deferred<void>();
  const gate = deferred<ModelGeneration>();
  const model = new ScriptedPlanningModel(async () => { entered.resolve(); return gate.promise; });
  const h = await setup(t, model);
  const run = await h.service.create({ requestId: "slow" });
  await entered.promise;
  await assert.rejects(h.service.create({ requestId: "other" }), (error: unknown) => error instanceof AgentApiError && error.code === "RUN_ACTIVE");
  const planner = new PlannerService(h.store, () => Date.parse(fixtureNow));
  await planner.commands([createTask("manual-during-model")], "test-client");
  assert.ok(await h.store.getTask("manual-during-model"));
  assert.equal((await h.service.get(run.run.runId)).run.status, "running");
  assert.deepEqual((await h.service.get(run.run.runId)).run.usage, { kind: "unknown" });
  gate.resolve(generation());
  await h.service.whenSettled(run.run.runId);
  assert.equal((await h.service.get(run.run.runId)).run.status, "ready");
});

test("cancellation is idempotent and late ignored output cannot create proposals or affect a newer run", async (t) => {
  const entered = deferred<void>();
  const gate = deferred<ModelGeneration>();
  const model = new ScriptedPlanningModel([async () => { entered.resolve(); return gate.promise; }, readyOutputFixture]);
  const h = await setup(t, model);
  const first = await h.service.create({ requestId: "old" });
  await entered.promise;
  assert.equal((await h.service.cancel(first.run.runId)).run.status, "cancelled");
  assert.deepEqual((await h.service.get(first.run.runId)).run.usage, { kind: "unknown" });
  assert.equal((await h.service.cancel(first.run.runId)).run.status, "cancelled");
  assert.equal(model.calls[0].signal.aborted, true);
  const next = await h.service.create({ requestId: "next" });
  await h.service.whenSettled(next.run.runId);
  gate.resolve(generation());
  await h.service.whenSettled(first.run.runId);
  assert.equal((await h.service.get(first.run.runId)).proposal, null);
  assert.equal((await h.service.get(next.run.runId)).run.status, "ready");
  assert.equal((await h.store.listAgentRecords(AGENT_NAMESPACES.proposal)).length, 1);
});

test("starting a new run supersedes the old proposal and GET reads lifecycle changes from storage", async (t) => {
  const h = await setup(t, new ScriptedPlanningModel(() => generation()));
  const first = await h.service.create({ requestId: "old" });
  await h.service.whenSettled(first.run.runId);
  const old = (await h.service.get(first.run.runId)).proposal!;
  const next = await h.service.create({ requestId: "new" });
  await h.service.whenSettled(next.run.runId);
  assert.equal((await h.service.get(first.run.runId)).proposal?.lifecycle, "superseded");
  await h.store.transaction(() => h.store.putAgentRecord(AGENT_NAMESPACES.proposal, old.proposalId, { ...old, lifecycle: "rejected" }));
  assert.equal((await h.service.get(first.run.runId)).proposal?.lifecycle, "rejected");
});

test("starting after history clearing aborts the orphaned local provider before a new run", async (t) => {
  const entered = deferred<void>();
  const gate = deferred<ModelGeneration>();
  const model = new ScriptedPlanningModel([async () => { entered.resolve(); return gate.promise; }, readyOutputFixture]);
  const h = await setup(t, model);
  const first = await h.service.create({ requestId: "cleared-old" });
  await entered.promise;
  await h.store.transaction(() => h.store.deleteAgentRecords(AGENT_NAMESPACES.run));
  const next = await h.service.create({ requestId: "after-clear" });
  assert.equal(model.calls[0].signal.aborted, true);
  await h.service.whenSettled(next.run.runId);
  gate.resolve(generation());
  await h.service.whenSettled(first.run.runId);
  assert.equal((await h.service.get(next.run.runId)).run.status, "ready");
  assert.equal((await h.store.listAgentRecords(AGENT_NAMESPACES.proposal)).length, 1);
});

test("clarification accepts exactly the asked question once, preserves question text, and deduplicates answers", async (t) => {
  const model = new ScriptedPlanningModel([clarificationOutputFixture, (_snapshot: PlanningSnapshot, answers: { questionId: string; answer: string; question?: string }[]) => {
    assert.equal(answers[0].question, clarificationOutputFixture.questions[0].question);
    return generation();
  }]);
  const h = await setup(t, model);
  const first = await h.service.create({ requestId: "clarify" });
  await h.service.whenSettled(first.run.runId);
  await assert.rejects(h.service.answer(first.run.runId, { requestId: "bad", answers: [{ questionId: "invented", answer: "不知道" }] }), (error: unknown) => error instanceof AgentApiError && error.code === "INVALID_INPUT");
  const request = { requestId: "answer-once", answers: [{ questionId: "question-priority", answer: "不知道" }] };
  const [one, two] = await Promise.all([h.service.answer(first.run.runId, request), h.service.answer(first.run.runId, request)]);
  assert.equal(one.run.runId, two.run.runId);
  await h.service.whenSettled(first.run.runId);
  const result = await h.service.get(first.run.runId);
  assert.equal(result.run.status, "ready");
  assert.equal(result.run.clarificationRound, 1);
  assert.equal(result.run.callCount, 2);
  await assert.rejects(h.service.answer(first.run.runId, { ...request, answers: [{ questionId: "question-priority", answer: "核对" }] }), (error: unknown) => error instanceof AgentApiError && error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(model.calls.length, 2);
});

test("a second clarification round fails within two model calls", async (t) => {
  const model = new ScriptedPlanningModel([clarificationOutputFixture, clarificationOutputFixture]);
  const h = await setup(t, model);
  const first = await h.service.create({ requestId: "one-round" });
  await h.service.whenSettled(first.run.runId);
  await h.service.answer(first.run.runId, { requestId: "answer", answers: [{ questionId: "question-priority", answer: "不知道" }] });
  await h.service.whenSettled(first.run.runId);
  const result = await h.service.get(first.run.runId);
  assert.equal(result.run.error?.code, "CLARIFICATION_LIMIT");
  assert.equal(model.calls.length, 2);
});

type SnapshotInvalidation = "agent-import-without-preferences" | "context" | "preferences" | "midnight";
async function invalidateSnapshot(h: Awaited<ReturnType<typeof setup>>, change: SnapshotInvalidation) {
  if (change === "agent-import-without-preferences") {
    // Agent import(false) retains context/preferences but changes dataset epoch.
    await h.store.rotateDatasetEpoch();
  } else if (change === "context") {
    h.snapshot.context.revision++;
    await h.store.transaction(() => h.store.putAgentRecord(AGENT_NAMESPACES.context, h.snapshot.context.id, h.snapshot.context));
  } else if (change === "preferences") {
    h.snapshot.preferences.revision++;
    await h.store.transaction(() => h.store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", h.snapshot.preferences));
  } else {
    h.setTime(Date.parse("2026-09-08T16:00:00.000Z"));
    h.snapshot.date = "2026-09-09";
    h.snapshot.sampledAt = "2026-09-08T16:00:00.000Z";
    h.snapshot.context.id = "context-next-day";
    h.snapshot.context.date = h.snapshot.date;
    await h.store.transaction(() => h.store.putAgentRecord(AGENT_NAMESPACES.context, h.snapshot.context.id, h.snapshot.context));
  }
}

for (const change of ["agent-import-without-preferences", "context", "preferences", "midnight"] as const) {
  for (const recovery of ["answer-then-create", "direct-create"] as const) {
    test(`stale clarification after ${change} is retired by ${recovery} without blocking a new run`, async (t) => {
      const model = new ScriptedPlanningModel([clarificationOutputFixture, readyOutputFixture]);
      const h = await setup(t, model);
      const first = await h.service.create({ requestId: "old-clarification" });
      await h.service.whenSettled(first.run.runId);
      await invalidateSnapshot(h, change);
      const before = await h.businessState();
      const code = change === "midnight" ? "DATE_EXPIRED" : "VERSION_CONFLICT";
      if (recovery === "answer-then-create") {
        await assert.rejects(h.service.answer(first.run.runId, {
          requestId: "stale-answer", answers: [{ questionId: "question-priority", answer: "不知道" }],
        }), (error: unknown) => error instanceof AgentApiError && error.code === code);
        // The rejected HTTP request must not roll this terminal write back.
        assert.equal((await h.service.get(first.run.runId)).run.status, "failed");
      }
      const next = await h.service.create({ requestId: "new-round" });
      await h.service.whenSettled(next.run.runId);
      const previous = await h.service.get(first.run.runId);
      assert.equal(previous.run.status, "failed");
      assert.equal(previous.run.error?.code, code);
      assert.equal(previous.proposal?.lifecycle, "superseded");
      assert.equal((await h.service.get(next.run.runId)).run.status, "ready");
      assert.equal(model.calls.length, 2);
      assert.deepEqual(await h.businessState(), before);
    });
  }
}

test("a valid outstanding clarification remains active and cannot be replaced by another request", async (t) => {
  const model = new ScriptedPlanningModel([clarificationOutputFixture]);
  const h = await setup(t, model);
  const first = await h.service.create({ requestId: "valid-clarification" });
  await h.service.whenSettled(first.run.runId);
  await assert.rejects(h.service.create({ requestId: "new-round" }), (error: unknown) => error instanceof AgentApiError && error.code === "RUN_ACTIVE");
  assert.equal((await h.service.get(first.run.runId)).run.status, "needs_clarification");
  assert.equal(model.calls.length, 1);
});

test("stale run retirement survives a subsequent snapshot creation rejection", async (t) => {
  const model = new ScriptedPlanningModel([clarificationOutputFixture, readyOutputFixture]);
  const h = await setup(t, model);
  const first = await h.service.create({ requestId: "old" });
  await h.service.whenSettled(first.run.runId);
  await invalidateSnapshot(h, "context");
  h.snapshot.scope.complete = false;
  await assert.rejects(h.service.create({ requestId: "new" }), (error: unknown) => error instanceof AgentApiError && error.code === "CONTEXT_TOO_LARGE");
  assert.equal((await h.service.get(first.run.runId)).run.status, "failed");
  assert.equal((await h.service.get(first.run.runId)).proposal?.lifecycle, "superseded");
  h.snapshot.scope.complete = true;
  const next = await h.service.create({ requestId: "new" });
  await h.service.whenSettled(next.run.runId);
  assert.equal((await h.service.get(next.run.runId)).run.status, "ready");
});

test("replacing an invalidated running request aborts its local provider before starting a new run", async (t) => {
  const entered = deferred<void>();
  const gate = deferred<ModelGeneration>();
  const model = new ScriptedPlanningModel([async () => { entered.resolve(); return gate.promise; }, readyOutputFixture]);
  const h = await setup(t, model);
  const first = await h.service.create({ requestId: "old-running" });
  await entered.promise;
  await invalidateSnapshot(h, "preferences");
  const next = await h.service.create({ requestId: "new-round" });
  assert.equal(model.calls[0].signal.aborted, true);
  await h.service.whenSettled(next.run.runId);
  gate.resolve(generation());
  await h.service.whenSettled(first.run.runId);
  assert.equal((await h.service.get(first.run.runId)).run.status, "failed");
  assert.equal((await h.service.get(first.run.runId)).proposal, null);
  assert.equal((await h.service.get(next.run.runId)).run.status, "ready");
});

test("one format repair and one clarification continuation use at most three calls", async (t) => {
  const model = new ScriptedPlanningModel(["not json", clarificationOutputFixture, { bad: true }, readyOutputFixture]);
  const h = await setup(t, model);
  const first = await h.service.create({ requestId: "repair" });
  await h.service.whenSettled(first.run.runId);
  assert.ok(model.calls[1].repair);
  await h.service.answer(first.run.runId, { requestId: "answer", answers: [{ questionId: "question-priority", answer: "不知道" }] });
  await h.service.whenSettled(first.run.runId);
  const result = await h.service.get(first.run.runId);
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.callCount, 3);
  assert.equal(model.calls.length, 3);
});

test("unknown usage is preserved through a successful repair", async (t) => {
  const model = new ScriptedPlanningModel(["invalid", () => generation()]);
  const h = await setup(t, model);
  const run = await h.service.create({ requestId: "unknown-usage" });
  await h.service.whenSettled(run.run.runId);
  const result = await h.service.get(run.run.runId);
  assert.equal(result.run.status, "ready");
  assert.equal(result.run.callCount, 2);
  assert.deepEqual(result.run.usage, { kind: "unknown" });
});

test("close interrupts an active provider promptly and does not persist its late result", async (t) => {
  const entered = deferred<void>();
  const gate = deferred<ModelGeneration>();
  const model = new ScriptedPlanningModel(async () => { entered.resolve(); return gate.promise; });
  const h = await setup(t, model);
  const first = await h.service.create({ requestId: "shutdown" });
  await entered.promise;
  await h.service.close();
  const interrupted = await h.service.get(first.run.runId);
  assert.equal(interrupted.run.status, "interrupted");
  assert.deepEqual(interrupted.run.usage, { kind: "unknown" });
  assert.equal(model.calls[0].signal.aborted, true);
  gate.resolve(generation());
  await h.service.whenSettled(first.run.runId);
  assert.equal((await h.service.get(first.run.runId)).proposal, null);
  await assert.rejects(h.service.create({ requestId: "after-close" }), (error: unknown) => error instanceof AgentApiError && error.code === "MODEL_UNAVAILABLE");
});

for (const candidateState of ["completed", "future"] as const) {
  test(`a model cannot select a ${candidateState} task even if supplied as background`, async (t) => {
    const snapshot = structuredClone(snapshotFixture) as PlanningSnapshot;
    snapshot.candidates[0].executable = false;
    snapshot.scope.totalEligibleTasks = 2;
    snapshot.scope.includedTasks = 2;
    if (candidateState === "future") {
      snapshot.candidates[0].task.startDate = "2026-09-09";
      snapshot.candidates[0].task.endDate = "2026-09-09";
    } else {
      snapshot.candidates[0].task.status = "completed";
      snapshot.candidates[0].task.completedAt = fixtureNow;
      snapshot.candidates[0].task.completedOn = snapshot.date;
    }
    const model = new ScriptedPlanningModel([readyOutputFixture]);
    const h = await setup(t, model, { snapshot });
    const before = await h.businessState();
    const first = await h.service.create({ requestId: candidateState });
    await h.service.whenSettled(first.run.runId);
    assert.equal((await h.service.get(first.run.runId)).run.error?.code, "MODEL_INVALID_OUTPUT");
    assert.equal(model.calls.length, 1);
    assert.deepEqual(await h.businessState(), before);
  });
}

test("explicit hard deadlines require a corresponding context citation, and must-include tasks cannot be omitted", async (t) => {
  const snapshot = structuredClone(snapshotFixture) as PlanningSnapshot;
  snapshot.context.constraints.push({ id: "real-deadline", kind: "hard_deadline", taskId: "task-report", value: "今天提交", source: "user", sourceText: "今天必须提交汇报" });
  snapshot.facts.push({ id: "fact-deadline", source: "context", taskId: "task-report", constraintId: "real-deadline", text: "用户明确今天必须提交汇报" });
  const allowed = { ...readyOutputFixture, selections: [{ taskId: "task-report", reason: "用户明确今天必须提交汇报", factRefs: ["fact-report", "fact-deadline"] }] };
  const h = await setup(t, new ScriptedPlanningModel([allowed]), { snapshot });
  const first = await h.service.create({ requestId: "deadline" });
  await h.service.whenSettled(first.run.runId);
  assert.equal((await h.service.get(first.run.runId)).run.status, "ready");
  snapshot.context.constraints.push({ id: "required-other", kind: "must_include", taskId: "task-other", value: "必须纳入", source: "user", sourceText: "今天必须把整理桌面放进重点" });
  const missing = await setup(t, new ScriptedPlanningModel([readyOutputFixture]), { snapshot });
  const second = await missing.service.create({ requestId: "must-include" });
  await missing.service.whenSettled(second.run.runId);
  assert.equal((await missing.service.get(second.run.runId)).run.error?.code, "MODEL_INVALID_OUTPUT");
});

for (const [label, output] of [
  ["unknown task", { ...readyOutputFixture, selections: [{ ...readyOutputFixture.selections[0], taskId: "not-a-task" }] }],
  ["duplicate task", { ...readyOutputFixture, selections: [readyOutputFixture.selections[0], readyOutputFixture.selections[0]] }],
  ["blocked task", { ...readyOutputFixture, selections: [{ taskId: "task-blocked", reason: "处理待审核改动", factRefs: ["fact-blocked"] }] }],
  ["unknown fact", { ...readyOutputFixture, selections: [{ ...readyOutputFixture.selections[0], factRefs: ["made-up"] }] }],
  ["unrelated task fact", { ...readyOutputFixture, selections: [{ ...readyOutputFixture.selections[0], factRefs: ["fact-check"] }] }],
  ["forged deadline", { ...readyOutputFixture, selections: [{ ...readyOutputFixture.selections[0], reason: "今天必须完成，硬截止就是今天" }] }],
  ["capacity exceeded", { ...readyOutputFixture, selections: [...readyOutputFixture.selections, { taskId: "task-other", reason: "整理", factRefs: ["fact-other"] }] }],
  ["more than three", { ...readyOutputFixture, selections: [...readyOutputFixture.selections, ...readyOutputFixture.selections] }],
  ["unauthorized command", { ...readyOutputFixture, commands: [{ type: "deleteTask", id: "task-report" }] }],
  ["duplicate questions", { ...clarificationOutputFixture, questions: [clarificationOutputFixture.questions[0], clarificationOutputFixture.questions[0]] }],
] as const) {
  test(`invalid model output: ${label} is bounded and has zero business writes`, async (t) => {
    const model = new ScriptedPlanningModel([output, output]);
    const h = await setup(t, model);
    const before = await h.businessState();
    const first = await h.service.create({ requestId: label });
    await h.service.whenSettled(first.run.runId);
    const result = await h.service.get(first.run.runId);
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.error?.code, "MODEL_INVALID_OUTPUT");
    assert.equal(result.proposal, null);
    assert.ok(model.calls.length <= 2);
    assert.deepEqual(await h.businessState(), before);
  });
}

test("explicit rest and incompatible must-include constraints produce zero-call no_action and preserve focus", async (t) => {
  for (const constraint of [
    { id: "rest", kind: "rest" as const, value: "休息", source: "user" as const, sourceText: "今天休息" },
    { id: "required", kind: "must_include" as const, taskId: "task-blocked", value: "必须纳入", source: "user" as const, sourceText: "今天必须处理待审核改动" },
  ]) {
    const snapshot = structuredClone(snapshotFixture) as PlanningSnapshot;
    snapshot.context.constraints.push(constraint);
    const model = new ScriptedPlanningModel([readyOutputFixture]);
    const h = await setup(t, model, { snapshot });
    const before = await h.businessState();
    const first = await h.service.create({ requestId: constraint.id });
    await h.service.whenSettled(first.run.runId);
    assert.equal((await h.service.get(first.run.runId)).run.status, "no_action");
    assert.equal(model.calls.length, 0);
    assert.deepEqual(await h.businessState(), before);
  }
});

test("unconfigured provider and incomplete scope fail without a model request", async (t) => {
  const disabled = await setup(t, null);
  await assert.rejects(disabled.service.create({ requestId: "disabled" }), (error: unknown) => error instanceof AgentApiError && error.code === "MODEL_UNAVAILABLE");
  const snapshot = structuredClone(snapshotFixture) as PlanningSnapshot;
  snapshot.scope.complete = false;
  const model = new ScriptedPlanningModel([readyOutputFixture]);
  const h = await setup(t, model, { snapshot });
  await assert.rejects(h.service.create({ requestId: "large" }), (error: unknown) => error instanceof AgentApiError && error.code === "CONTEXT_TOO_LARGE");
  assert.equal(model.calls.length, 0);
});

test("429 is terminal for the run; timeout ignores a provider that does not honor abort", async (t) => {
  const limited = await setup(t, new ScriptedPlanningModel([new AgentApiError("MODEL_RATE_LIMITED", 429, "稍后再试", true)]));
  const limitedRun = await limited.service.create({ requestId: "429" });
  await limited.service.whenSettled(limitedRun.run.runId);
  assert.equal((await limited.service.get(limitedRun.run.runId)).run.error?.code, "MODEL_RATE_LIMITED");
  const gate = deferred<ModelGeneration>();
  const model = new ScriptedPlanningModel(() => gate.promise);
  const timed = await setup(t, model, { timeoutMs: 10 });
  const run = await timed.service.create({ requestId: "timeout" });
  await timed.service.whenSettled(run.run.runId);
  assert.equal((await timed.service.get(run.run.runId)).run.error?.code, "MODEL_TIMEOUT");
  assert.equal(model.calls[0].signal.aborted, true);
  gate.resolve(generation());
  assert.equal((await timed.service.get(run.run.runId)).proposal, null);
});

for (const change of ["context", "preferences", "midnight", "cleared", "dataset"] as const) {
  test(`late output after ${change} cannot become ready`, async (t) => {
    const entered = deferred<void>();
    const gate = deferred<ModelGeneration>();
    const h = await setup(t, new ScriptedPlanningModel(async () => { entered.resolve(); return gate.promise; }));
    const first = await h.service.create({ requestId: change });
    await entered.promise;
    if (change === "context") await h.store.transaction(() => h.store.putAgentRecord(AGENT_NAMESPACES.context, h.snapshot.context.id, { ...h.snapshot.context, revision: 99 }));
    if (change === "preferences") await h.store.transaction(() => h.store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", { ...h.snapshot.preferences, revision: 99 }));
    if (change === "midnight") h.setTime(Date.parse("2026-09-08T16:00:00.000Z"));
    if (change === "cleared") await h.store.transaction(() => h.store.deleteAgentRecords(AGENT_NAMESPACES.run));
    if (change === "dataset") await h.store.rotateDatasetEpoch();
    gate.resolve(generation());
    await h.service.whenSettled(first.run.runId);
    assert.equal((await h.store.listAgentRecords<PlanningProposal>(AGENT_NAMESPACES.proposal)).length, 0);
    if (change === "cleared") await assert.rejects(h.service.get(first.run.runId), (error: unknown) => error instanceof AgentApiError && error.code === "NOT_FOUND");
    else assert.equal((await h.service.get(first.run.runId)).run.error?.code, change === "midnight" ? "DATE_EXPIRED" : "VERSION_CONFLICT");
  });
}

test("startup marks persisted unfinished runs interrupted and never resumes or charges a model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-agent-run-"));
  const path = join(directory, "planner.sqlite");
  let store: SQLitePlannerStore | undefined;
  let service: AgentRunService | undefined;
  try {
    store = new SQLitePlannerStore(path);
    await store.transaction(async () => {
      await store!.putAgentRecord(AGENT_NAMESPACES.snapshot, snapshotFixture.id, snapshotFixture);
      for (const status of ["running", "needs_clarification"] as const) await store!.putAgentRecord(AGENT_NAMESPACES.run, status, { ...runFixture, runId: status, status, proposalId: null });
    });
    store.close();
    store = new SQLitePlannerStore(path);
    const model = new ScriptedPlanningModel([readyOutputFixture]);
    service = new AgentRunService(store, { createSnapshot: async () => structuredClone(snapshotFixture) }, model);
    await service.initialize();
    const runs = await store.listAgentRecords<AgentRun>(AGENT_NAMESPACES.run);
    assert.equal(runs.length, 2);
    assert.ok(runs.every((run) => run.status === "interrupted"));
    assert.equal(model.calls.length, 0);
    assert.equal((await service.get("running")).run.status, "interrupted");
  } finally {
    await service?.close();
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("run HTTP routes validate inputs and return the frozen response contract", async (t) => {
  const model = new ScriptedPlanningModel([clarificationOutputFixture, readyOutputFixture]);
  const h = await setup(t, model);
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AgentApiError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    if (error instanceof ZodError) return reply.code(400).send({ code: "INVALID_INPUT" });
    return reply.code(500).send({ message: "Unexpected error" });
  });
  registerAgentRunRoutes(app, h.service);
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "POST", url: "/api/agent/runs", payload: { requestId: "request", commands: [] } })).statusCode, 400);
  assert.equal(model.calls.length, 0);
  const create = await app.inject({ method: "POST", url: "/api/agent/runs", payload: { requestId: "request" } });
  assert.equal(create.statusCode, 202);
  const created = agentRunResponseSchema.parse(create.json());
  await h.service.whenSettled(created.run.runId);
  const read = await app.inject({ method: "GET", url: `/api/agent/runs/${created.run.runId}` });
  assert.equal(read.statusCode, 200);
  assert.equal(agentRunResponseSchema.parse(read.json()).run.status, "needs_clarification");
  const answer = await app.inject({ method: "POST", url: `/api/agent/runs/${created.run.runId}/answer`, payload: { requestId: "answer", answers: [{ questionId: "question-priority", answer: "整理材料" }] } });
  assert.equal(answer.statusCode, 202);
  agentRunResponseSchema.parse(answer.json());
  await h.service.whenSettled(created.run.runId);
  const cancelled = await app.inject({ method: "POST", url: `/api/agent/runs/${created.run.runId}/cancel`, payload: {} });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(agentRunResponseSchema.parse(cancelled.json()).run.status, "ready");
  assert.equal((await app.inject({ method: "GET", url: "/api/agent/runs/missing" })).statusCode, 404);
});
