import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AGENT_NAMESPACES, type ExecutionReceipt, type PlanningProposal, type PlanningSnapshot } from "@newday/core/contracts/agent-planning";
import { createPlannerBackup, restorePlannerBackup } from "@newday/core/application/planner-backup";
import { ScriptedPlanningModel } from "../src/agent/scripted-planning-model.js";
import type { ModelGeneration } from "../src/agent/planning-model.js";
import { AgentApiError } from "../src/http/agent-error.js";
import { AgentExecutionService } from "../src/services/agent-execution-service.js";
import { AgentRunService } from "../src/services/agent-run-service.js";
import { PlannerContextService } from "../src/services/planner-context-service.js";
import { PlannerHistoryService } from "../src/services/planner-history-service.js";
import { PlannerPreferencesService } from "../src/services/planner-preferences-service.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";
import { now, task, today } from "./fixtures.js";

const clock = () => Date.parse(now);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
function output(snapshot: PlanningSnapshot): ModelGeneration {
  return { output: { kind: "ready", selections: [{ taskId: "task-1", reason: "用户安排的任务", factRefs: snapshot.candidates[0].factRefs.slice(0, 1) }], assumptions: [] },
    modelId: "scripted-import-test", usage: { kind: "known", inputTokens: 1, outputTokens: 1 } };
}
const isError = (code: string) => (error: unknown) => error instanceof AgentApiError && error.code === code;
async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "newday-agent-generation-"));
  const path = join(directory, "planner.sqlite");
  const store = new SQLitePlannerStore(path);
  const beforeClose: Array<() => Promise<void>> = [];
  t.after(async () => { for (const close of beforeClose) await close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  await new PlannerPreferencesService(store, clock).updatePreferences({ expectedRevision: 0, timeZone: "Asia/Shanghai", learningEnabled: true, explicitPreferences: [] });
  await store.putTask(task());
  return { store, path, beforeClose, context: new PlannerContextService(store, clock), history: new PlannerHistoryService(store, clock), execution: new AgentExecutionService(store, clock) };
}
async function proposal(h: Awaited<ReturnType<typeof setup>>, id: string) {
  const snapshot = await h.context.createSnapshot();
  const candidate: PlanningProposal = { proposalId: id, runId: `run-${id}`, snapshotId: snapshot.id, lifecycle: "ready", createdAt: now,
    output: output(snapshot).output as PlanningProposal["output"] };
  await h.store.putAgentRecord(AGENT_NAMESPACES.proposal, id, candidate);
  return { snapshot, candidate, request: { proposalId: id, operationId: `operation-${id}`, expectedVersion: snapshot.version, taskIds: ["task-1"] } };
}

test("ND-QA-02: old Agent generations stay read-only while new snapshots can execute, with durable dedupe", async (t) => {
  const h = await setup(t);
  const old = await proposal(h, "old");
  // Existing databases have v1 snapshots and receipts without the new field.
  const legacySnapshot = { ...old.snapshot };
  delete legacySnapshot.agentGeneration;
  await h.store.putAgentRecord(AGENT_NAMESPACES.snapshot, old.snapshot.id, legacySnapshot);
  const applied = await h.execution.apply(old.request) as ExecutionReceipt;
  assert.equal(applied.status, "applied");
  assert.equal((await h.execution.operation(applied.operationId)).status, "found");
  const backup = await h.history.backup();
  const version = await h.store.getPlanningVersion();
  const tasks = await h.store.listAllTasks();
  const focus = await h.store.listAllFocusRecords();
  await h.history.importBackup(JSON.stringify(backup), false);
  assert.deepEqual(await h.store.getPlanningVersion(), version);
  assert.equal(await h.store.getAgentGeneration(), 1);
  assert.deepEqual(await h.store.listAllTasks(), tasks);
  assert.deepEqual(await h.store.listAllFocusRecords(), focus);
  assert.ok((await h.history.history(today)).entries.every((entry) => entry.readOnly && entry.receipt?.canRevert === false));
  const result = await h.execution.operation(applied.operationId);
  assert.equal(result.status, "found");
  if (result.status === "found") assert.equal(result.receipt.canRevert, false);
  const replay = await h.execution.apply(old.request) as ExecutionReceipt;
  assert.equal(replay.operationId, applied.operationId);
  assert.equal(replay.canRevert, false);
  await assert.rejects(h.execution.revert(applied.operationId, { operationId: "old-restore" }), isError("RESTORE_CONFLICT"));
  await assert.rejects(h.history.feedback({ feedbackId: "old-review", proposalId: "old", decision: "reviewed" }), isError("VERSION_CONFLICT"));
  assert.deepEqual(await h.store.getPlanningVersion(), version, "replaying old IDs cannot execute again");
  const fresh = await proposal(h, "fresh");
  assert.equal(fresh.snapshot.agentGeneration, 1);
  const freshReceipt = await h.execution.apply(fresh.request) as ExecutionReceipt;
  assert.equal(freshReceipt.agentGeneration, 1);
  assert.equal(freshReceipt.status, "no_change");
  await h.history.clearHistory();
  assert.equal(await h.store.getAgentGeneration(), 1);
  assert.equal((await h.execution.apply(old.request)).status, "details_deleted");
  await h.history.importBackup(JSON.stringify(backup), false);
  assert.equal(await h.store.getAgentGeneration(), 2);
  assert.equal((await h.execution.apply(old.request)).status, "details_deleted");
  await assert.rejects(h.execution.apply({ ...fresh.request, operationId: "imported-must-not-execute" }), isError("NOT_FOUND"));
  const reopened = new SQLitePlannerStore(h.path);
  try { assert.equal(await reopened.getAgentGeneration(), 2); }
  finally { reopened.close(); }
});

test("ND-QA-02: generation fences superseded and legacy ready proposals independently of task revision", async (t) => {
  const h = await setup(t);
  const old = await proposal(h, "ready");
  const source = await h.history.backup();
  await h.history.importBackup(JSON.stringify(source), false);
  await assert.rejects(h.execution.apply(old.request), isError("PROPOSAL_NOT_EXECUTABLE"));
  // Even a stale ready lifecycle cannot bypass the generation check.
  await h.store.putAgentRecord(AGENT_NAMESPACES.proposal, old.candidate.proposalId, old.candidate);
  await assert.rejects(h.execution.apply(old.request), isError("VERSION_CONFLICT"));
  assert.deepEqual(await h.store.listAllFocusRecords(), []);
  const localBackup = await createPlannerBackup(h.store, now);
  const before = await h.store.getPlanningVersion();
  await restorePlannerBackup(h.store, JSON.stringify(localBackup));
  assert.notEqual((await h.store.getPlanningVersion()).datasetEpoch, before.datasetEpoch, "task replacement must retain its separate epoch fence");
  assert.equal(await h.store.getAgentGeneration(), 1);
  await assert.rejects(h.execution.apply(old.request), isError("VERSION_CONFLICT"));
});

test("ND-QA-02: an Agent import atomically resets local context and excludes old feedback without losing task outcome evidence", async (t) => {
  const h = await setup(t);
  await h.context.updateTodayContext({ expectedRevision: 0, goals: ["Old goal"], energy: "low", capacity: 1, constraints: [] });
  const old = await proposal(h, "feedback");
  await h.history.feedback({ feedbackId: "prior-feedback", proposalId: old.candidate.proposalId, decision: "rejected", reason: "old generation reason" });
  await h.store.withEventContext({ date: today, at: now, source: "manual" }, () => h.store.putTask(task("task-1", { status: "completed", completedAt: now, completedOn: today })));
  await h.store.withEventContext({ date: today, at: now, source: "manual" }, () => h.store.putTask(task()));
  const before = await h.context.createSnapshot();
  assert.ok(before.facts.some((fact) => fact.text.includes("old generation reason")));
  await h.history.importBackup(JSON.stringify(await h.history.backup()), false);
  const after = await h.context.createSnapshot();
  assert.notEqual(after.context.id, old.snapshot.context.id);
  assert.deepEqual(after.context.goals, []);
  assert.ok(after.facts.every((fact) => !fact.text.includes("old generation reason")));
  assert.ok(after.recentOutcomes.some((outcome) => outcome.taskId === "task-1" && outcome.status === "reopened"));
});

for (const phase of ["model", "clarification"] as const) {
  test(`ND-QA-02: Agent import fences an in-flight ${phase} and allows a fresh run`, async (t) => {
    const h = await setup(t);
    const entered = deferred<PlanningSnapshot>();
    const released = deferred<ModelGeneration>();
    let first = true;
    const model = new ScriptedPlanningModel(async (snapshot) => {
      if (first) {
        first = false;
        entered.resolve(snapshot);
        if (phase === "model") return released.promise;
        return { output: { kind: "needs_clarification", questions: [{ id: "q", question: "今天有什么限制？" }], assumptions: [] }, modelId: "scripted-import-test", usage: { kind: "unknown" } };
      }
      return output(snapshot);
    });
    const runs = new AgentRunService(h.store, h.context, model, { clock });
    h.beforeClose.push(() => runs.close());
    const run = await runs.create({ requestId: `old-${phase}` });
    const snapshot = await entered.promise;
    if (phase === "clarification") await runs.whenSettled(run.run.runId);
    await h.history.importBackup(JSON.stringify(await h.history.backup()), false);
    if (phase === "model") {
      released.resolve(output(snapshot));
      await runs.whenSettled(run.run.runId);
      assert.equal((await runs.get(run.run.runId)).proposal, null);
    } else {
      await assert.rejects(runs.answer(run.run.runId, { requestId: "stale-answer", answers: [{ questionId: "q", answer: "none" }] }), isError("VERSION_CONFLICT"));
    }
    assert.equal((await runs.get(run.run.runId)).run.error?.code, "VERSION_CONFLICT");
    const fresh = await runs.create({ requestId: `fresh-${phase}` });
    await runs.whenSettled(fresh.run.runId);
    assert.equal((await runs.get(fresh.run.runId)).proposal?.lifecycle, "ready");
    assert.equal(model.calls.length, 2);
  });
}

test("ND-QA-02: failed import rolls back generation, preferences, proposal lifecycle and archive together", async (t) => {
  const h = await setup(t);
  const old = await proposal(h, "rollback");
  const before = await h.history.backup();
  h.store.setFailureInjector((point) => { if (point === "before_commit") throw new Error("injected commit failure"); });
  await assert.rejects(h.history.importBackup(JSON.stringify(before), true), /injected commit failure/);
  h.store.setFailureInjector(undefined);
  assert.equal(await h.store.getAgentGeneration(), 0);
  assert.deepEqual(await h.history.backup(), before);
  assert.equal((await h.execution.apply(old.request) as ExecutionReceipt).status, "applied");
});
