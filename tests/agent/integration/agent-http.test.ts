import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  agentBackupSchema, agentErrorSchema, agentRunResponseSchema, operationResultSchema,
  planningFeedbackSchema, planningHistoryResponseSchema, todayContextResponseSchema,
} from "@newday/core/contracts/agent-planning";
import { fakeModel, harness, ready, testDate } from "./harness.js";

/** Real TCP HTTP + disposable SQLite. Fake outputs establish engineering behavior only. */
test("generation and repeated run requests do not mutate planner data or versions", async (context) => {
  const model = fakeModel();
  const h = await harness(context, { model });
  await h.addTask("a"); await h.addTask("b");
  await h.command({ type: "setTodayFocus", input: { taskId: "b", date: testDate, now: h.now() } });
  const before = await h.businessState();
  const beforeExecution = h.executionState();
  const first = await h.startRun("same-request");
  const second = await h.startRun("same-request");
  assert.equal(first.run.runId, second.run.runId);
  await h.waitForRun(first.run.runId);
  assert.equal(model.calls, 1);
  assert.deepEqual(h.executionState(), beforeExecution);
  assert.deepEqual(await h.businessState(), before);
});

test("slow model work stays outside the manual planner queue", async (context) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const model = fakeModel(async (snapshot) => { await gate; return ready(snapshot); });
  const h = await harness(context, { model });
  context.after(release);
  await h.addTask("a");
  const run = await h.startRun();
  try {
    await Promise.race([h.addTask("manual-during-inference"), delay(1_500).then(() => assert.fail("Manual work was blocked by model inference"))]);
  } finally { release(); }
  await h.waitForRun(run.run.runId);
  assert.equal((await h.businessState()).tasks.length, 2);
});

test("apply commits once; duplicate delivery and restart return the same durable receipt", async (context) => {
  const h = await harness(context);
  await h.addTask("a"); await h.addTask("b");
  const proposal = await h.proposal();
  const body = h.applyBody(proposal, "stable-operation");
  const receipt = await h.apply(proposal, body.operationId);
  const after = await h.businessState();
  assert.equal(receipt.afterVersion.plannerRevision, receipt.beforeVersion.plannerRevision + 1);
  const duplicate = await h.json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body);
  assert.deepEqual(duplicate, receipt);
  assert.deepEqual(await h.businessState(), after);
  await h.restart();
  const found = operationResultSchema.parse(await h.json("GET", `/api/agent/operations/${body.operationId}`));
  assert.equal(found.status, "found");
  if (found.status === "found") assert.deepEqual(found.receipt, receipt);
  assert.deepEqual(await h.json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body), receipt);
  assert.deepEqual(await h.businessState(), after);
});

test("same operation ID with a different final selection is an idempotency conflict", async (context) => {
  const h = await harness(context);
  await h.addTask("a"); await h.addTask("b");
  const proposal = await h.proposal();
  await h.apply(proposal, "same-op", ["a"]);
  const after = await h.businessState();
  const conflict = agentErrorSchema.parse(await h.json("POST", `/api/agent/proposals/${proposal.proposal!.proposalId}/apply`, h.applyBody(proposal, "same-op", ["b"]), 409));
  assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(await h.businessState(), after);
});

test("two concurrent deliveries of one operation produce one mutation", async (context) => {
  const h = await harness(context);
  await h.addTask("a");
  const proposal = await h.proposal();
  const body = h.applyBody(proposal, "concurrent-op");
  const [one, two] = await Promise.all([
    h.json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body),
    h.json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body),
  ]);
  assert.deepEqual(one, two);
  assert.equal((await h.version()).plannerRevision, body.expectedVersion.plannerRevision + 1);
});

test("manual changes make a proposal stale without overwriting those changes", async (context) => {
  const h = await harness(context);
  await h.addTask("a");
  const proposal = await h.proposal();
  await h.addTask("later-manual-task");
  const before = await h.businessState();
  const body = h.applyBody(proposal);
  const error = agentErrorSchema.parse(await h.json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body, 409));
  assert.equal(error.code, "VERSION_CONFLICT");
  assert.deepEqual(await h.businessState(), before);
});

test("changing context invalidates a proposal without changing task revision", async (context) => {
  const h = await harness(context);
  await h.addTask("a");
  const proposal = await h.proposal();
  const beforeVersion = await h.version();
  const current = todayContextResponseSchema.parse(await h.json("GET", "/api/agent/context/today")).context;
  await h.json("PUT", "/api/agent/context/today", { expectedRevision: current.revision, goals: ["新的目标"], energy: "low", capacity: 1, constraints: [] });
  assert.deepEqual(await h.version(), beforeVersion);
  const before = await h.businessState();
  const refreshed = agentRunResponseSchema.parse(await h.json("GET", `/api/agent/runs/${proposal.run.runId}`));
  assert.equal(refreshed.proposal?.lifecycle, "superseded");
  const body = h.applyBody(proposal);
  const error = agentErrorSchema.parse(await h.json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body, 409));
  assert.equal(error.code, "PROPOSAL_NOT_EXECUTABLE");
  assert.deepEqual(await h.businessState(), before);
});

test("rejected and superseded proposals remain terminal and cannot be applied later", async (context) => {
  const h = await harness(context);
  await h.addTask("a");
  const rejected = await h.proposal();
  await h.json("POST", "/api/agent/feedback", { feedbackId: "reject-feedback", proposalId: rejected.proposal!.proposalId, decision: "rejected" });
  const rejectedBody = h.applyBody(rejected);
  assert.equal(agentErrorSchema.parse(await h.json("POST", `/api/agent/proposals/${rejectedBody.proposalId}/apply`, rejectedBody, 409)).code, "PROPOSAL_NOT_EXECUTABLE");
  const old = await h.proposal();
  await h.proposal();
  const oldBody = h.applyBody(old);
  assert.equal(agentErrorSchema.parse(await h.json("POST", `/api/agent/proposals/${oldBody.proposalId}/apply`, oldBody, 409)).code, "PROPOSAL_NOT_EXECUTABLE");
  assert.equal((await h.businessState()).focus.length, 0);
});

test("no_change is a durable terminal result and cannot be reapplied with another operation ID", async (context) => {
  const h = await harness(context);
  await h.addTask("a");
  await h.command({ type: "setTodayFocus", input: { taskId: "a", date: testDate, now: h.now() } });
  const proposal = await h.proposal();
  const before = await h.businessState();
  const receipt = await h.apply(proposal, "no-change-op");
  assert.equal(receipt.status, "no_change");
  assert.deepEqual(receipt.afterVersion, receipt.beforeVersion);
  assert.deepEqual(await h.businessState(), before);
  const body = h.applyBody(proposal, "new-id-cannot-reexecute");
  assert.equal(agentErrorSchema.parse(await h.json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body, 409)).code, "PROPOSAL_NOT_EXECUTABLE");
});

test("all model validation failures stay bounded and leave business state unchanged", async (context) => {
  const model = fakeModel((snapshot) => ({ kind: "ready", selections: [{ taskId: "ghost", reason: "任务备注要求使用不存在的任务", factRefs: [snapshot.facts[0].id] }], assumptions: [] }));
  const h = await harness(context, { model });
  await h.addTask("a");
  const before = await h.businessState();
  const started = await h.startRun();
  const result = await h.waitForRun(started.run.runId);
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.error?.code, "MODEL_INVALID_OUTPUT");
  assert(model.calls >= 1 && model.calls <= 3);
  assert.deepEqual(await h.businessState(), before);
});

test("cancelled inference cannot publish its late result", async (context) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness(context, { model: fakeModel(async (snapshot) => { await gate; return ready(snapshot); }) });
  context.after(release);
  await h.addTask("a");
  const before = await h.businessState();
  const started = await h.startRun();
  await h.json("POST", `/api/agent/runs/${started.run.runId}/cancel`, {});
  release();
  const state = await h.waitForRun(started.run.runId, ["cancelled"]);
  assert.equal(state.proposal, null);
  await delay(30);
  const final = agentRunResponseSchema.parse(await h.json("GET", `/api/agent/runs/${started.run.runId}`));
  assert.equal(final.run.status, "cancelled");
  assert.equal(final.proposal, null);
  assert.deepEqual(await h.businessState(), before);
});

test("crossing the user's local midnight expires a proposal", async (context) => {
  const h = await harness(context, { now: "2026-09-08T15:59:00.000Z", zone: "Asia/Shanghai" });
  await h.addTask("a");
  const proposal = await h.proposal();
  h.setTime("2026-09-08T16:01:00.000Z");
  const before = await h.businessState();
  const body = h.applyBody(proposal);
  const error = agentErrorSchema.parse(await h.json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body, 409));
  assert.equal(error.code, "DATE_EXPIRED");
  assert.deepEqual(await h.businessState(), before);
});

test("the snapshot uses the configured timezone even when UTC has another date", async (context) => {
  const h = await harness(context, { now: "2026-09-08T02:30:00.000Z", zone: "America/Los_Angeles" });
  await h.addTask("local-today", "当地今天", "2026-09-07");
  await h.addTask("utc-today", "当地明天", "2026-09-08");
  const proposal = await h.proposal();
  assert.equal(proposal.snapshot.date, "2026-09-07");
  assert.deepEqual(proposal.snapshot.candidates.filter((candidate) => candidate.executable).map((candidate) => candidate.task.id), ["local-today"]);
});

test("task replacement import changes epoch and prevents applying an old proposal with reused task IDs", async (context) => {
  const h = await harness(context);
  await h.addTask("a");
  const proposal = await h.proposal();
  const backup = await h.json("GET", "/api/planner/backup");
  await h.json("POST", "/api/planner/backup", { source: JSON.stringify(backup) });
  const before = await h.businessState();
  assert.notEqual(before.version.datasetEpoch, proposal.snapshot.version.datasetEpoch);
  const body = h.applyBody(proposal);
  const error = agentErrorSchema.parse(await h.json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body, 409));
  assert(["VERSION_CONFLICT", "PROPOSAL_NOT_EXECUTABLE"].includes(error.code));
  assert.deepEqual(await h.businessState(), before);
});

test("feedback is idempotent and completion, reopen, and deletion remain in decision history", async (context) => {
  const h = await harness(context);
  await h.addTask("a", "可追溯任务");
  const proposal = await h.proposal();
  const receipt = await h.apply(proposal);
  const initialHistory = planningHistoryResponseSchema.parse(await h.json("GET", `/api/agent/history?date=${testDate}`));
  const initialEntry = initialHistory.entries.find((entry) => entry.receipt?.operationId === receipt.operationId);
  assert(initialEntry);
  assert(initialEntry.outcomes.every((outcome) => outcome.status === "unknown"), "Saving an adoption snapshot must not invent a completion or deletion outcome");
  const feedback = { feedbackId: "review-feedback", proposalId: proposal.proposal!.proposalId, operationId: receipt.operationId, decision: "reviewed" };
  const first = planningFeedbackSchema.parse(await h.json("POST", "/api/agent/feedback", feedback));
  assert.deepEqual(await h.json("POST", "/api/agent/feedback", feedback), first);
  const changed = agentErrorSchema.parse(await h.json("POST", "/api/agent/feedback", { ...feedback, reason: "changed" }, 409));
  assert.equal(changed.code, "IDEMPOTENCY_CONFLICT");
  for (const command of [
    { type: "completeTask", input: { taskId: "a", completedOn: testDate, now: h.now() } },
    { type: "reopenTask", input: { taskId: "a", now: h.now() } },
    { type: "deleteTask", input: { taskId: "a", now: h.now() } },
  ]) await h.command(command);
  const history = planningHistoryResponseSchema.parse(await h.json("GET", `/api/agent/history?date=${testDate}`));
  const entry = history.entries.find((item) => item.receipt?.operationId === receipt.operationId);
  assert(entry);
  assert.equal(entry.feedback.filter((item) => item.feedbackId === feedback.feedbackId).length, 1);
  assert(entry.outcomes.some((item) => item.taskId === "a" && item.status === "deleted"));
  assert(entry.snapshot?.candidates.some((item) => item.task.id === "a" && item.task.title === "可追溯任务"));
});

test("history clearing retains minimal operation terminals and duplicate applies cannot replay", async (context) => {
  const h = await harness(context);
  await h.addTask("a");
  const proposal = await h.proposal();
  const body = h.applyBody(proposal, "retained-terminal");
  await h.apply(proposal, body.operationId);
  await h.json("DELETE", "/api/agent/history", {});
  const before = await h.businessState();
  const result = operationResultSchema.parse(await h.json("GET", `/api/agent/operations/${body.operationId}`));
  assert.equal(result.status, "details_deleted");
  assert.deepEqual(await h.json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body), result);
  assert.deepEqual(await h.businessState(), before);
});

test("agent backup import keeps failed runs and events as readonly source history without rehydrating execution IDs", async (context) => {
  let fail = false;
  const source = await harness(context, { model: fakeModel((snapshot) => fail ? { kind: "invalid-fixture-output" } : ready(snapshot)) });
  await source.addTask("a", "来源数据集任务");
  const proposal = await source.proposal();
  const receipt = await source.apply(proposal, "source-operation");
  fail = true;
  const failingRun = await source.startRun();
  assert.equal((await source.waitForRun(failingRun.run.runId)).run.status, "failed");
  const archive = agentBackupSchema.parse(await source.json("GET", "/api/agent/backup"));
  assert(archive.events.length > 0);
  assert(archive.runs.some((run) => run.runId === failingRun.run.runId && run.status === "failed"));

  const target = await harness(context);
  await target.addTask("a", "当前数据集中的同名 ID");
  const before = await target.businessState();
  const importedResult = await target.json("POST", "/api/agent/backup", { source: JSON.stringify(archive), importPreferences: false });
  const after = await target.businessState();
  assert.deepEqual(after.tasks, before.tasks);
  assert.deepEqual(after.focus, before.focus);
  assert.deepEqual(after.version, before.version, "Agent history import preserves task and Notion identity");
  assert.equal(importedResult.datasetEpoch, before.version.datasetEpoch);
  assert.equal(importedResult.agentGeneration, 1);
  const history = planningHistoryResponseSchema.parse(await target.json("GET", `/api/agent/history?date=${testDate}`));
  assert(history.entries.some((entry) => entry.readOnly && entry.datasetEpoch === archive.sourceDatasetEpoch && entry.receipt?.operationId === receipt.operationId));
  const oldOperation = operationResultSchema.parse(await target.json("GET", `/api/agent/operations/${receipt.operationId}`));
  assert.equal(oldOperation.status, "not_found");
  const roundTrip = agentBackupSchema.parse(await target.json("GET", "/api/agent/backup"));
  const imported = roundTrip.importedHistories.find((entry) => entry.sourceDatasetEpoch === archive.sourceDatasetEpoch);
  assert(imported?.archive);
  assert.deepEqual(imported.archive.runs, archive.runs);
  assert.deepEqual(imported.archive.events, archive.events);
  const body = source.applyBody(proposal, "cannot-replay-imported-proposal");
  const response = await target.response("POST", `/api/agent/proposals/${body.proposalId}/apply`, body);
  assert([404, 409].includes(response.status));
  assert(["NOT_FOUND", "VERSION_CONFLICT", "PROPOSAL_NOT_EXECUTABLE"].includes(agentErrorSchema.parse(await response.json()).code));
});

test("model-unconfigured errors preserve the manual task workflow", async (context) => {
  const h = await harness(context, { model: null });
  await h.addTask("a");
  const before = await h.businessState();
  const response = await h.response("POST", "/api/agent/runs", { requestId: "unconfigured" });
  assert.equal(response.status, 503);
  assert.equal(agentErrorSchema.parse(await response.json()).code, "MODEL_UNAVAILABLE");
  assert.deepEqual(await h.businessState(), before);
  await h.addTask("b");
  assert.equal((await h.businessState()).tasks.length, 2);
});

test("a failure while recording the applied event rolls back focus, version, ledger, and history together", async (context) => {
  const h = await harness(context);
  await h.addTask("a");
  const proposal = await h.proposal();
  const before = await h.businessState();
  const beforeExecution = h.executionState();
  const database = new DatabaseSync(h.databasePath);
  try {
    database.exec("CREATE TRIGGER acceptance_fail_event BEFORE INSERT ON planner_events BEGIN SELECT RAISE(ABORT, 'acceptance injected event failure'); END");
    const body = h.applyBody(proposal, "rolled-back-operation");
    const response = await h.response("POST", `/api/agent/proposals/${body.proposalId}/apply`, body);
    assert.equal(response.status, 500);
    assert.deepEqual(await h.businessState(), before);
    assert.deepEqual(h.executionState(), beforeExecution);
    assert.equal(operationResultSchema.parse(await h.json("GET", `/api/agent/operations/${body.operationId}`)).status, "not_found");
    database.exec("DROP TRIGGER acceptance_fail_event");
    const receipt = await h.apply(proposal, body.operationId);
    assert.equal(receipt.status, "applied");
  } finally { database.close(); }
});

test("a revert restores the previous set once and refuses to overwrite later focus changes", async (context) => {
  const h = await harness(context);
  await h.addTask("a"); await h.addTask("b"); await h.addTask("c");
  await h.command({ type: "setTodayFocus", input: { taskId: "c", date: testDate, now: h.now() } });
  const proposal = await h.proposal();
  const receipt = await h.apply(proposal);
  const reverted = await h.json("POST", `/api/agent/operations/${receipt.operationId}/revert`, { operationId: "revert-once" });
  assert.deepEqual(await h.json("POST", `/api/agent/operations/${receipt.operationId}/revert`, { operationId: "revert-once" }), reverted);
  const next = await h.proposal();
  const nextReceipt = await h.apply(next);
  await h.command({ type: "setTodayFocus", input: { taskId: "c", date: testDate, now: h.now() } });
  const before = await h.businessState();
  const error = agentErrorSchema.parse(await h.json("POST", `/api/agent/operations/${nextReceipt.operationId}/revert`, { operationId: "conflicting-revert" }, 409));
  assert.equal(error.code, "RESTORE_CONFLICT");
  assert.deepEqual(await h.businessState(), before);
});

test("a lost HTTP apply acknowledgement is resolved through the original durable operation", async (context) => {
  const h = await harness(context);
  await h.addTask("a");
  const proposal = await h.proposal();
  const body = h.applyBody(proposal, "lost-ack-operation");
  h.dropNextApplyResponse();
  await assert.rejects(h.response("POST", `/api/agent/proposals/${body.proposalId}/apply`, body));
  const found = operationResultSchema.parse(await h.json("GET", `/api/agent/operations/${body.operationId}`));
  assert.equal(found.status, "found");
  const after = await h.businessState();
  const afterExecution = h.executionState();
  if (found.status === "found") {
    assert.equal(found.receipt.status, "applied");
    assert.deepEqual(await h.json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body), found.receipt);
  }
  assert.deepEqual(await h.businessState(), after);
  assert.deepEqual(h.executionState(), afterExecution);
});

test("changing the configured timezone makes an old proposal unusable", async (context) => {
  const h = await harness(context);
  await h.addTask("a");
  const proposal = await h.proposal();
  const originalVersion = await h.version();
  await h.preferences("America/Los_Angeles");
  assert.deepEqual(await h.version(), originalVersion);
  const before = await h.businessState();
  const refreshed = agentRunResponseSchema.parse(await h.json("GET", `/api/agent/runs/${proposal.run.runId}`));
  assert.equal(refreshed.proposal?.lifecycle, "superseded");
  const body = h.applyBody(proposal);
  const error = agentErrorSchema.parse(await h.json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body, 409));
  assert.equal(error.code, "PROPOSAL_NOT_EXECUTABLE");
  assert.deepEqual(await h.businessState(), before);
});

test("a maximum-length valid operation ID still produces schema-valid feedback, history, and backup", async (context) => {
  const h = await harness(context);
  await h.addTask("a");
  const proposal = await h.proposal();
  const receipt = await h.apply(proposal, "o".repeat(200));
  const history = planningHistoryResponseSchema.parse(await h.json("GET", `/api/agent/history?date=${testDate}`));
  const entry = history.entries.find((item) => item.receipt?.operationId === receipt.operationId);
  assert(entry);
  assert(entry.feedback.every((item) => item.feedbackId.length <= 200));
  agentBackupSchema.parse(await h.json("GET", "/api/agent/backup"));
});
