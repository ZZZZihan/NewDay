import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ZodError } from "zod";
import {
  AGENT_NAMESPACES, AGENT_PROMPT_VERSION, AGENT_SCHEMA_VERSION, agentBackupSchema,
  type AgentRun, type ExecutionReceipt, type PlanningProposal,
} from "@newday/core/contracts/agent-planning";
import { createPlannerBackup } from "@newday/core/application/planner-backup";
import { AgentApiError } from "../src/http/agent-error.js";
import { registerAgentHistoryRoutes } from "../src/http/agent-history-routes.js";
import { PlannerContextService } from "../src/services/planner-context-service.js";
import { PlannerHistoryService } from "../src/services/planner-history-service.js";
import { PlannerPreferencesService } from "../src/services/planner-preferences-service.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";
import { now, task, today } from "./fixtures.js";

const clock = () => Date.parse(now);
async function setup(store: SQLitePlannerStore) {
  const preferences = new PlannerPreferencesService(store, clock);
  await preferences.updatePreferences({ expectedRevision: 0, timeZone: "Asia/Shanghai", learningEnabled: true, explicitPreferences: [] });
  await store.putTask(task());
  const context = new PlannerContextService(store, clock);
  const snapshot = await context.createSnapshot();
  const proposal: PlanningProposal = {
    proposalId: "proposal-1", runId: "run-1", snapshotId: snapshot.id, createdAt: now, lifecycle: "ready",
    output: { kind: "ready", selections: [{ taskId: "task-1", reason: "已列入今日任务", factRefs: snapshot.candidates[0].factRefs.slice(0, 1) }], assumptions: [] },
  };
  await store.putAgentRecord(AGENT_NAMESPACES.proposal, proposal.proposalId, proposal);
  return { preferences, context, snapshot, proposal, history: new PlannerHistoryService(store, clock) };
}

async function recordSuccessfulApply(store: SQLitePlannerStore, proposal: PlanningProposal): Promise<ExecutionReceipt> {
  return store.withEventContext({ date: today, at: now, source: "agent", proposalId: proposal.proposalId, operationId: "operation-1" }, async () => {
    const beforeVersion = await store.getPlanningVersion();
    await store.putFocusRecord({ id: "focus-1", taskId: "task-1", date: today, focusedAt: now });
    const receipt: ExecutionReceipt = {
      operationId: "operation-1", proposalId: proposal.proposalId, action: "apply", status: "applied", beforeVersion,
      afterVersion: await store.getPlanningVersion(), date: today, timeZone: "Asia/Shanghai",
      beforeFocusTaskIds: [], finalFocusTaskIds: ["task-1"], addedTaskIds: ["task-1"], removedTaskIds: [], retainedTaskIds: [], executedAt: now, canRevert: true,
    };
    await store.putAgentRecord(AGENT_NAMESPACES.proposal, proposal.proposalId, { ...proposal, lifecycle: "applied" });
    await store.putExecutionReceipt("test-request-digest", receipt);
    return receipt;
  });
}

test("feedback is idempotent and rejection invalidates a proposal without task writes", async (context) => {
  const store = new SQLitePlannerStore(":memory:");
  context.after(() => store.close());
  const { history, proposal, preferences } = await setup(store);
  const version = await store.getPlanningVersion();
  const input = { feedbackId: "feedback-1", proposalId: proposal.proposalId, decision: "rejected" as const, reason: "今天不想做" };
  const feedback = await history.feedback(input);
  assert.deepEqual(await history.feedback(input), feedback);
  assert.equal((await store.listAgentRecords(AGENT_NAMESPACES.feedback)).length, 1);
  assert.equal((await store.getAgentRecord<PlanningProposal>(AGENT_NAMESPACES.proposal, proposal.proposalId))?.lifecycle, "rejected");
  assert.deepEqual(await store.getPlanningVersion(), version);
  assert.deepEqual(await store.listAllFocusRecords(), []);
  assert.deepEqual((await preferences.getPreferences()).explicitPreferences, []);
  await assert.rejects(history.feedback({ ...input, reason: "不同的反馈" }), (error) => error instanceof AgentApiError && error.code === "IDEMPOTENCY_CONFLICT");
});

test("feedback failure rolls back both rejection and feedback record", async (context) => {
  const store = new SQLitePlannerStore(":memory:");
  context.after(() => store.close());
  const { history, proposal } = await setup(store);
  store.setFailureInjector((point) => { if (point === "before_commit") throw new Error("feedback commit fault"); });
  await assert.rejects(history.feedback({ feedbackId: "feedback-1", proposalId: proposal.proposalId, decision: "rejected" }), /feedback commit fault/);
  store.setFailureInjector(undefined);
  assert.equal((await store.getAgentRecord<PlanningProposal>(AGENT_NAMESPACES.proposal, proposal.proposalId))?.lifecycle, "ready");
  assert.deepEqual(await store.listAgentRecords(AGENT_NAMESPACES.feedback), []);
});

test("accepted feedback requires a committed matching execution receipt", async (context) => {
  const store = new SQLitePlannerStore(":memory:");
  context.after(() => store.close());
  const { history, proposal } = await setup(store);
  const input = { feedbackId: "feedback-1", proposalId: proposal.proposalId, decision: "accepted" as const };
  await assert.rejects(history.feedback(input), (error) => error instanceof AgentApiError && error.code === "PROPOSAL_NOT_EXECUTABLE");
  await recordSuccessfulApply(store, proposal);
  const feedback = await history.feedback({ ...input, operationId: "operation-1" });
  assert.equal(feedback.decision, "accepted");
  await assert.rejects(history.feedback({ ...input, feedbackId: "feedback-modified", operationId: "operation-1", decision: "modified" }), (error) => error instanceof AgentApiError && error.code === "INVALID_INPUT");
  await assert.rejects(history.feedback({ ...input, feedbackId: "feedback-reject", decision: "rejected" }), (error) => error instanceof AgentApiError && error.code === "PROPOSAL_NOT_EXECUTABLE");
});

test("history follows recorded completion, reopen, reschedule, deletion and restoration", async (context) => {
  const store = new SQLitePlannerStore(":memory:");
  context.after(() => store.close());
  const { history, proposal } = await setup(store);
  await recordSuccessfulApply(store, proposal);
  const outcome = async () => (await history.history(today)).entries[0].outcomes[0];
  assert.equal((await outcome()).status, "unknown");
  await store.appendPlannerEvent({ id: "apply-choice-snapshot", ...await store.getPlanningVersion(), date: today, at: now, source: "agent", kind: "proposal_applied", taskId: "task-1", taskBefore: task(), operationId: "operation-1", proposalId: proposal.proposalId });
  assert.equal((await outcome()).status, "unknown");
  await store.withEventContext({ date: today, at: now, source: "manual" }, () => store.putTask(task("task-1", { status: "completed", completedAt: now, completedOn: today })));
  assert.equal((await outcome()).status, "completed");
  await store.withEventContext({ date: today, at: now, source: "manual" }, () => store.putTask(task()));
  assert.equal((await outcome()).status, "reopened");
  await store.withEventContext({ date: today, at: now, source: "manual" }, () => store.putTask(task("task-1", { startDate: "2026-09-09", endDate: "2026-09-10" })));
  assert.equal((await outcome()).status, "rescheduled");
  await store.withEventContext({ date: today, at: now, source: "manual" }, () => store.deleteTask("task-1"));
  assert.equal((await outcome()).status, "deleted");
  assert.equal((await outcome()).title, "整理项目");
  assert.equal((await history.history(today)).entries[0].snapshot?.candidates[0].task.id, "task-1");
  await store.withEventContext({ date: today, at: now, source: "manual", kind: "undo" }, () => store.putTask(task()));
  assert.equal((await outcome()).status, "restored");
});

test("next snapshot uses recorded recent outcomes only while learning is enabled", async (context) => {
  const store = new SQLitePlannerStore(":memory:");
  context.after(() => store.close());
  const { preferences, context: plannerContext, history, proposal } = await setup(store);
  await history.feedback({ feedbackId: "feedback-next-day", proposalId: proposal.proposalId, decision: "rejected", reason: "今天必须留时间陪家人" });
  await store.withEventContext({ date: today, at: now, source: "manual" }, () => store.putTask(task("task-1", { status: "completed", completedAt: now, completedOn: today })));
  await store.withEventContext({ date: today, at: now, source: "manual" }, () => store.putTask(task()));
  const learning = await plannerContext.createSnapshot();
  assert.deepEqual(learning.recentOutcomes.map(({ status }) => status), ["reopened"]);
  assert.ok(learning.facts.some(({ source, text }) => source === "history" && text.includes("今天必须留时间陪家人")));
  assert.deepEqual(learning.preferences.explicitPreferences, []);
  await preferences.updatePreferences({ expectedRevision: 1, timeZone: "Asia/Shanghai", learningEnabled: false, explicitPreferences: [] });
  const disabled = await plannerContext.createSnapshot();
  assert.deepEqual(disabled.recentOutcomes, []);
  assert.equal(disabled.facts.some(({ source }) => source === "history"), false);
});

test("events before adoption in the same millisecond are not post-adoption outcomes", async (context) => {
  const store = new SQLitePlannerStore(":memory:");
  context.after(() => store.close());
  const fixture = await setup(store);
  await store.withEventContext({ date: today, at: now, source: "manual" }, () => store.putTask(task("task-1", { status: "completed", completedAt: now, completedOn: today })));
  await store.withEventContext({ date: today, at: now, source: "manual" }, () => store.putTask(task()));
  const snapshot = await fixture.context.createSnapshot();
  const proposal = { ...fixture.proposal, snapshotId: snapshot.id };
  await store.putAgentRecord(AGENT_NAMESPACES.proposal, proposal.proposalId, proposal);
  await recordSuccessfulApply(store, proposal);
  assert.equal((await fixture.history.history(today)).entries[0].outcomes[0].status, "unknown");
});

test("next-day completion stays on its recorded date and does not backfill yesterday's result", async (context) => {
  const store = new SQLitePlannerStore(":memory:");
  context.after(() => store.close());
  const fixture = await setup(store);
  await recordSuccessfulApply(store, fixture.proposal);
  const nextDay = "2026-09-09";
  const nextInstant = "2026-09-09T08:00:00.000Z";
  await store.withEventContext({ date: nextDay, at: nextInstant, source: "manual" }, () => store.putTask(task("task-1", { status: "completed", completedAt: nextInstant, completedOn: nextDay, updatedAt: nextInstant })));
  assert.equal((await fixture.history.history(today)).entries[0].outcomes[0].status, "unknown");
  const nextSnapshot = await new PlannerContextService(store, () => Date.parse(nextInstant)).createSnapshot();
  assert.ok(nextSnapshot.recentOutcomes.some(({ date, status }) => date === nextDay && status === "completed"));
});

test("clearing history preserves task data, preferences and the minimal execution ledger", async (context) => {
  const store = new SQLitePlannerStore(":memory:");
  context.after(() => store.close());
  const { history, proposal, preferences } = await setup(store);
  const receipt = await recordSuccessfulApply(store, proposal);
  await history.feedback({ feedbackId: "review", proposalId: proposal.proposalId, operationId: receipt.operationId, decision: "reviewed" });
  await store.putAgentRecord("agent.run-request", "request", { runId: "run-1" });
  const tasks = await store.listAllTasks();
  const focus = await store.listAllFocusRecords();
  const beforePreferences = await preferences.getPreferences();
  await history.clearHistory();
  assert.deepEqual(await store.listAllTasks(), tasks);
  assert.deepEqual(await store.listAllFocusRecords(), focus);
  assert.deepEqual(await preferences.getPreferences(), beforePreferences);
  assert.deepEqual((await history.history(today)).entries, []);
  assert.deepEqual(await store.listPlannerEvents(), []);
  assert.deepEqual(await store.listAgentRecords("agent.run-request"), []);
  assert.equal((await store.getOperationResult(receipt.operationId)).status, "details_deleted");
  const ledger = await store.getExecutionLedger(receipt.operationId);
  assert.equal(ledger?.requestDigest, "test-request-digest");
  assert.equal(ledger?.terminalStatus, "applied");
  assert.equal(ledger?.receipt, null);
});

test("agent backup imports read-only history without tasks or execution IDs and preserves raw failed runs on re-export", async (context) => {
  const sourceStore = new SQLitePlannerStore(":memory:");
  const targetStore = new SQLitePlannerStore(":memory:");
  context.after(() => { sourceStore.close(); targetStore.close(); });
  const source = await setup(sourceStore);
  await recordSuccessfulApply(sourceStore, source.proposal);
  await sourceStore.withEventContext({ date: today, at: now, source: "manual" }, () => sourceStore.putTask(task("task-1", { status: "completed", completedAt: now, completedOn: today })));
  const failedRun: AgentRun = {
    runId: "failed-run", requestId: "failed-request", snapshotId: source.snapshot.id, status: "failed", modelId: "scripted-fake",
    promptVersion: AGENT_PROMPT_VERSION, schemaVersion: AGENT_SCHEMA_VERSION, callCount: 1, clarificationRound: 0,
    latencyMs: 15, usage: { kind: "unknown" }, createdAt: now, updatedAt: now, proposalId: null,
    error: { code: "MODEL_TIMEOUT", status: 504, message: "模型响应超时", retryable: true },
  };
  await sourceStore.putAgentRecord(AGENT_NAMESPACES.run, failedRun.runId, failedRun);
  const exported = await source.history.backup();
  assert.equal(agentBackupSchema.safeParse(exported).success, true);
  const target = await setup(targetStore);
  const currentVersion = await targetStore.getPlanningVersion();
  const taskBackup = await createPlannerBackup(targetStore, now);
  const currentPreferences = await target.preferences.getPreferences();
  await target.history.importBackup(JSON.stringify(exported), false);
  assert.notEqual((await targetStore.getPlanningVersion()).datasetEpoch, currentVersion.datasetEpoch);
  assert.deepEqual(await createPlannerBackup(targetStore, now), taskBackup);
  assert.equal(taskBackup.version, 4);
  assert.equal("agent" in taskBackup, false);
  assert.deepEqual(await target.preferences.getPreferences(), currentPreferences);
  assert.equal((await targetStore.getOperationResult("operation-1")).status, "not_found");
  assert.equal((await targetStore.getAgentRecord<PlanningProposal>(AGENT_NAMESPACES.proposal, target.proposal.proposalId))?.lifecycle, "superseded");
  assert.deepEqual((await target.context.getTodayContext()).context.goals, []);
  const history = await target.history.history(today);
  assert.ok(history.entries.every((entry) => entry.readOnly));
  assert.ok(history.entries.some((entry) => entry.outcomes[0]?.status === "completed" && entry.receipt?.canRevert === false));
  const roundtrip = await target.history.backup();
  const imported = roundtrip.importedHistories[0];
  assert.deepEqual(imported.archive?.runs, exported.runs);
  assert.deepEqual(imported.archive?.events, exported.events);
  assert.deepEqual(imported.archive?.receipts, exported.receipts);
  assert.deepEqual(imported.archive?.snapshots, exported.snapshots);
});

test("failed agent import leaves current epoch, preferences and imported history unchanged", async (context) => {
  const store = new SQLitePlannerStore(":memory:");
  context.after(() => store.close());
  const { history, preferences } = await setup(store);
  const backup = await history.backup();
  const version = await store.getPlanningVersion();
  const beforePreferences = await preferences.getPreferences();
  store.setFailureInjector((point) => { if (point === "before_commit") throw new Error("import commit fault"); });
  await assert.rejects(history.importBackup(JSON.stringify(backup), true), /import commit fault/);
  store.setFailureInjector(undefined);
  assert.deepEqual(await store.getPlanningVersion(), version);
  assert.deepEqual(await preferences.getPreferences(), beforePreferences);
  assert.deepEqual(await store.listAgentRecords(AGENT_NAMESPACES.imported), []);
});

test("history HTTP validates dates and feedback bodies and exposes separate agent backup", async (context) => {
  const store = new SQLitePlannerStore(":memory:");
  const app = Fastify();
  context.after(async () => { await app.close(); store.close(); });
  const { history, proposal } = await setup(store);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AgentApiError) return reply.code(error.statusCode).send({ code: error.code });
    if (error instanceof ZodError) return reply.code(400).send({ code: "INVALID_INPUT" });
    return reply.code(500).send({ message: "failed" });
  });
  registerAgentHistoryRoutes(app, history);
  assert.equal((await app.inject("/api/agent/history?date=2026-02-30")).statusCode, 400);
  assert.equal((await app.inject(`/api/agent/history?date=${today}`)).json().entries.length, 1);
  assert.equal((await app.inject({ method: "POST", url: "/api/agent/feedback", payload: { feedbackId: "reject", proposalId: proposal.proposalId, decision: "rejected", commands: [] } })).statusCode, 400);
  assert.equal((await app.inject("/api/agent/backup")).json().format, "newday-agent");
  assert.equal((await app.inject({ method: "POST", url: "/api/agent/backup", payload: { source: "{}", importPreferences: false } })).statusCode, 400);
});
