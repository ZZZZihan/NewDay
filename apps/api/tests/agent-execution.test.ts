import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_NAMESPACES, type AgentPreferences, type ApplyProposalRequest, type DailyContext, type ExecutionReceipt, type PlanningProposal, type PlanningSnapshot } from "@newday/core/contracts/agent-planning";
import { AgentExecutionService } from "../src/services/agent-execution-service.js";
import { PlannerService } from "../src/services/planner-service.js";
import { SQLitePlannerStore, type StorageFailurePoint } from "../src/storage/sqlite-planner-store.js";
import { task, today, now } from "./fixtures.js";

async function seed(store: SQLitePlannerStore, focus: string[] = []): Promise<ApplyProposalRequest> {
  return store.transaction(async () => {
    for (const id of ["a", "b", "old"]) await store.putTask(task(id));
    for (const taskId of focus) await store.putFocusRecord({ id: `focus:${today}:${taskId}`, date: today, taskId, focusedAt: now });
    const preferences: AgentPreferences = { revision: 1, timeZone: "Asia/Shanghai", learningEnabled: true, explicitPreferences: [], updatedAt: now };
    await store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", preferences);
    const version = await store.getPlanningVersion();
    const context: DailyContext = { id: `context:${version.datasetEpoch}:${today}`, revision: 0, date: today, timeZone: "Asia/Shanghai", goals: [], energy: null, capacity: null, constraints: [], source: "user", updatedAt: now };
    const snapshot: PlanningSnapshot = { id: "snapshot", version, date: today, timeZone: "Asia/Shanghai", sampledAt: now, context, preferences,
      candidates: (await store.listAllTasks()).map((task) => ({ task, executable: true, blocked: false, factRefs: [`task:${task.id}`] })),
      currentFocusTaskIds: focus, facts: [{ id: "task:a", source: "task", text: "任务 a 可执行", taskId: "a" }], recentOutcomes: [], scope: { description: "全部今日任务", totalEligibleTasks: 3, includedTasks: 3, complete: true } };
    const proposal: PlanningProposal = { proposalId: "proposal", runId: "run", snapshotId: "snapshot", createdAt: now, lifecycle: "ready", output: { kind: "ready", selections: [{ taskId: "a", reason: "推进目标", factRefs: ["task:a"] }], assumptions: [] } };
    await store.putAgentRecord(AGENT_NAMESPACES.context, context.id, context);
    await store.putAgentRecord(AGENT_NAMESPACES.snapshot, snapshot.id, snapshot);
    await store.putAgentRecord(AGENT_NAMESPACES.proposal, proposal.proposalId, proposal);
    return { proposalId: "proposal", operationId: "operation", expectedVersion: version, taskIds: ["a"] };
  });
}
const clock = () => Date.parse(now);
const code = (expected: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === expected;
async function focusIds(store: SQLitePlannerStore) { return (await store.listFocusRecordsForDate(today)).map((record) => record.taskId).sort(); }

function receipt(value: Awaited<ReturnType<AgentExecutionService["apply"]>>): ExecutionReceipt {
  assert.ok("afterVersion" in value); return value;
}

test("apply replaces the final focus set atomically and operation dedup never executes twice", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    const request = await seed(store, ["old"]);
    const service = new AgentExecutionService(store, clock);
    const first = receipt(await service.apply({ ...request, taskIds: ["b", "a"] }));
    assert.deepEqual(await focusIds(store), ["a", "b"]);
    assert.deepEqual(first.addedTaskIds, ["a", "b"]);
    assert.deepEqual(first.removedTaskIds, ["old"]);
    assert.equal(first.afterVersion.plannerRevision, first.beforeVersion.plannerRevision + 1);
    const events = await store.listPlannerEvents();
    assert.deepEqual(await service.apply({ ...request, taskIds: ["a", "b"] }), first);
    assert.equal((await store.listPlannerEvents()).length, events.length);
    assert.equal((await store.listExecutionReceipts()).length, 1);
    assert.equal((await store.listAgentRecords(AGENT_NAMESPACES.feedback)).length, 1);
    await assert.rejects(service.apply({ ...request, taskIds: ["b"] }), code("IDEMPOTENCY_CONFLICT"));
  } finally { store.close(); }
});

test("no_change is terminal even with a new operationId and never advances planner revision", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    const request = await seed(store, ["a"]);
    const service = new AgentExecutionService(store, clock);
    const first = receipt(await service.apply(request));
    assert.equal(first.status, "no_change");
    assert.equal(first.canRevert, false);
    assert.deepEqual(first.beforeVersion, first.afterVersion);
    await assert.rejects(service.apply({ ...request, operationId: "second" }), code("PROPOSAL_NOT_EXECUTABLE"));
    assert.deepEqual(await service.apply(request), first);
    assert.equal((await store.listExecutionReceipts()).length, 1);
  } finally { store.close(); }
});

test("concurrent proposals compete against one revision and only one commits", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    const request = await seed(store);
    const original = (await store.getAgentRecord<PlanningProposal>(AGENT_NAMESPACES.proposal, "proposal"))!;
    await store.putAgentRecord(AGENT_NAMESPACES.proposal, "other", { ...original, proposalId: "other" });
    const service = new AgentExecutionService(store, clock);
    const results = await Promise.allSettled([service.apply(request), service.apply({ ...request, proposalId: "other", operationId: "other-operation", taskIds: ["b"] })]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await store.listExecutionReceipts()).length, 1);
    assert.deepEqual(await focusIds(store), ["a"]);
  } finally { store.close(); }
});

for (const lifecycle of ["rejected", "superseded", "expired", "not_applicable", "applied"] as const) {
  test(`${lifecycle} proposal cannot be applied`, async () => {
    const store = new SQLitePlannerStore(":memory:");
    try {
      const request = await seed(store);
      const proposal = (await store.getAgentRecord<PlanningProposal>(AGENT_NAMESPACES.proposal, "proposal"))!;
      await store.putAgentRecord(AGENT_NAMESPACES.proposal, "proposal", { ...proposal, lifecycle });
      await assert.rejects(new AgentExecutionService(store, clock).apply(request), code("PROPOSAL_NOT_EXECUTABLE"));
      assert.deepEqual(await focusIds(store), []);
    } finally { store.close(); }
  });
}

test("manual task changes, context updates, preference changes, cross-day and imports invalidate proposals", async () => {
  for (const scenario of ["task", "context", "preferences", "cross-day", "timezone", "import"] as const) {
    const store = new SQLitePlannerStore(":memory:");
    try {
      const request = await seed(store);
      const snapshot = (await store.getAgentRecord<PlanningSnapshot>(AGENT_NAMESPACES.snapshot, "snapshot"))!;
      if (scenario === "task") await store.putTask({ ...task("b"), title: "已修改" });
      if (scenario === "context") await store.putAgentRecord(AGENT_NAMESPACES.context, snapshot.context.id, { ...snapshot.context, revision: 1 });
      if (scenario === "preferences") await store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", { ...snapshot.preferences, revision: 2 });
      if (scenario === "timezone") await store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", { ...snapshot.preferences, timeZone: "UTC" });
      if (scenario === "import") await store.replaceAllData({ tasks: [task("a")] });
      const service = new AgentExecutionService(store, scenario === "cross-day" ? () => Date.parse(now) + 86_400_000 : clock);
      await assert.rejects(service.apply(request), code(scenario === "cross-day" || scenario === "timezone" ? "DATE_EXPIRED" : "VERSION_CONFLICT"));
      assert.equal((await store.listExecutionReceipts()).length, 0);
      assert.deepEqual(await focusIds(store), []);
    } finally { store.close(); }
  }
});

test("final selections enforce candidate, open-task, blocking, capacity, rest and must-include constraints", async () => {
  for (const scenario of ["unknown", "blocked", "capacity", "rest", "must-include", "incomplete"] as const) {
    const store = new SQLitePlannerStore(":memory:");
    try {
      const request = await seed(store);
      const snapshot = (await store.getAgentRecord<PlanningSnapshot>(AGENT_NAMESPACES.snapshot, "snapshot"))!;
      if (scenario === "blocked") snapshot.candidates.find((value) => value.task.id === "a")!.blocked = true;
      if (scenario === "capacity") snapshot.context.capacity = 1;
      if (scenario === "rest") snapshot.context.constraints = [{ id: "rest", kind: "rest", value: "今天休息", source: "user", sourceText: "今天休息" }];
      if (scenario === "must-include") snapshot.context.constraints = [{ id: "must", kind: "must_include", taskId: "b", value: "必须完成b", source: "user", sourceText: "必须完成b" }];
      if (scenario === "incomplete") snapshot.scope.complete = false;
      await store.putAgentRecord(AGENT_NAMESPACES.snapshot, "snapshot", snapshot);
      await store.putAgentRecord(AGENT_NAMESPACES.context, snapshot.context.id, snapshot.context);
      await assert.rejects(new AgentExecutionService(store, clock).apply({ ...request, taskIds: scenario === "unknown" ? ["missing"] : scenario === "capacity" ? ["a", "b"] : ["a"] }));
      assert.deepEqual(await focusIds(store), []);
      assert.equal((await store.listExecutionReceipts()).length, 0);
    } finally { store.close(); }
  }
});

for (const failurePoint of ["before_event", "before_receipt", "before_commit"] as StorageFailurePoint[]) {
  test(`${failurePoint} failure rolls back focus, lifecycle, feedback, events and version`, async () => {
    const store = new SQLitePlannerStore(":memory:");
    try {
      const request = await seed(store, ["old"]);
      const service = new AgentExecutionService(store, clock);
      store.setFailureInjector((point) => { if (point === failurePoint) throw new Error("injected failure"); });
      await assert.rejects(service.apply(request), /injected failure/);
      store.setFailureInjector();
      assert.deepEqual(await focusIds(store), ["old"]);
      assert.deepEqual(await store.getPlanningVersion(), request.expectedVersion);
      assert.equal((await store.getAgentRecord<PlanningProposal>(AGENT_NAMESPACES.proposal, "proposal"))?.lifecycle, "ready");
      assert.deepEqual(await store.listPlannerEvents(), []);
      assert.deepEqual(await store.listAgentRecords(AGENT_NAMESPACES.feedback), []);
      assert.deepEqual(await store.listExecutionReceipts(), []);
      assert.equal(receipt(await service.apply(request)).status, "applied");
    } finally { store.close(); }
  });
}

test("revert restores only the previous focus set and is itself idempotent", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    const request = await seed(store, ["old"]);
    const service = new AgentExecutionService(store, clock);
    await service.apply(request);
    const reverted = receipt(await service.revert("operation", { operationId: "revert" }));
    assert.equal(reverted.action, "revert");
    assert.equal(reverted.revertsOperationId, "operation");
    assert.deepEqual(await focusIds(store), ["old"]);
    assert.deepEqual(await service.revert("operation", { operationId: "revert" }), reverted);
    await assert.rejects(service.revert("operation", { operationId: "revert-again" }), code("RESTORE_CONFLICT"));
    assert.deepEqual((await store.listAllTasks()).map((value) => value.id), ["a", "b", "old"]);
  } finally { store.close(); }
});

test("revert refuses subsequent manual changes and lookup reports current eligibility", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    const request = await seed(store, ["old"]);
    const service = new AgentExecutionService(store, clock);
    await service.apply(request);
    await store.putTask({ ...task("b"), title: "人工修改" });
    await assert.rejects(service.revert("operation", { operationId: "revert" }), code("RESTORE_CONFLICT"));
    const found = await service.operation("operation");
    assert.equal(found.status, "found");
    if (found.status === "found") assert.equal(found.receipt.canRevert, false);
    assert.deepEqual(await focusIds(store), ["a"]);
  } finally { store.close(); }
});

test("cleaned history keeps operation terminal replay without reconstructing deleted details", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    const request = await seed(store);
    const service = new AgentExecutionService(store, clock);
    await service.apply(request);
    await store.transaction(async () => { await store.clearExecutionDetails(); await store.deleteAgentRecords(AGENT_NAMESPACES.proposal); await store.rotateDatasetEpoch(); });
    const replay = await service.apply(request);
    assert.equal(replay.status, "details_deleted");
    assert.deepEqual(await service.operation(request.operationId), replay);
    await assert.rejects(service.apply({ ...request, taskIds: ["b"] }), code("IDEMPOTENCY_CONFLICT"));
    assert.deepEqual(await focusIds(store), ["a"]);
  } finally { store.close(); }
});

for (const point of ["before_commit", "after_commit"] as const) {
  test(`process exit ${point} is resolved by the durable operationId after restart`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "newday-agent-crash-"));
    const path = join(directory, "planner.sqlite");
    let store = new SQLitePlannerStore(path);
    try {
      const request = await seed(store, ["old"]);
      store.close();
      const script = `import {SQLitePlannerStore} from './src/storage/sqlite-planner-store.ts'; import {AgentExecutionService} from './src/services/agent-execution-service.ts'; const store=new SQLitePlannerStore(${JSON.stringify(path)}); store.setFailureInjector(point=>{if(point===${JSON.stringify(point)})process.exit(73)}); await new AgentExecutionService(store,()=>${Date.parse(now)}).apply(${JSON.stringify(request)});`;
      const processResult = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8" });
      assert.equal(processResult.status, 73, processResult.stderr);
      store = new SQLitePlannerStore(path);
      const service = new AgentExecutionService(store, clock);
      const result = await service.operation(request.operationId);
      assert.equal(result.status, point === "before_commit" ? "not_found" : "found");
      assert.deepEqual(await focusIds(store), point === "before_commit" ? ["old"] : ["a"]);
      const applied = receipt(await service.apply(request));
      assert.equal(applied.status, "applied");
      assert.equal((await store.listExecutionReceipts()).length, 1);
      assert.deepEqual(await focusIds(store), ["a"]);
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("manual completion and focus use the same configured date as the Agent", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await seed(store);
    const at = "2026-09-08T18:00:00.000Z"; // Sept 9 in Shanghai, Sept 8 in UTC.
    const planner = new PlannerService(store, () => Date.parse(at));
    await planner.commands([{ type: "completeTask", input: { taskId: "a", now, completedOn: today } }], "client");
    assert.equal((await store.getTask("a"))?.completedOn, "2026-09-09");
    assert.equal((await store.getTask("a"))?.completedAt, at);
    await assert.rejects(planner.commands([{ type: "setTodayFocus", input: { taskId: "b", date: today, now } }], "client"), code("DATE_EXPIRED"));
    await planner.commands([{ type: "setTodayFocus", input: { taskId: "b", date: "2026-09-09", now: at } }], "client");
    const day = await planner.day({ selectedDate: "2026-09-09", asOfDate: today });
    assert.equal(day.asOfDate, "2026-09-09");
    assert.equal(day.focus[0].task.id, "b");
    const events = await store.listPlannerEvents();
    assert.ok(events.every((event) => event.date === "2026-09-09"));
    assert.ok(events.some((event) => event.kind === "completed" && event.source === "manual"));
  } finally { store.close(); }
});

test("repeated daily recurrence materialization changes revision once and the second read is a no-op", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    const planner = new PlannerService(store, clock);
    await planner.commands([{ type: "createRecurrenceSeries", input: { id: "daily", title: "每日事项", startDate: today, pattern: { kind: "daily" }, end: { kind: "never" }, now } }], "client");
    const before = await store.getPlanningVersion();
    await planner.day({ selectedDate: today, asOfDate: today });
    const materialized = await store.getPlanningVersion();
    assert.equal(materialized.plannerRevision, before.plannerRevision + 1);
    assert.equal((await store.listAllTasks()).length, 32);
    await planner.day({ selectedDate: today, asOfDate: today });
    assert.deepEqual(await store.getPlanningVersion(), materialized);
    assert.equal((await store.listAllTasks()).length, 32);
  } finally { store.close(); }
});

async function executionState(store: SQLitePlannerStore) {
  return {
    version: await store.getPlanningVersion(), tasks: await store.listAllTasks(), focus: await store.listAllFocusRecords(),
    events: await store.listPlannerEvents(), receipts: await store.listExecutionReceipts(),
    proposals: await store.listAgentRecords(AGENT_NAMESPACES.proposal), feedback: await store.listAgentRecords(AGENT_NAMESPACES.feedback),
  };
}

const beforeMidnight = "2026-09-08T15:59:59.999Z";
const afterMidnight = "2026-09-08T16:00:00.000Z";
for (const action of ["apply", "revert"] as const) {
  for (const crossedBeforeValidation of [false, true]) {
    test(`${action} rejects midnight ${crossedBeforeValidation ? "before validation" : "between validation and execution"} without writes`, async () => {
      const store = new SQLitePlannerStore(":memory:");
      try {
        const request = await seed(store, ["old"]);
        if (action === "revert") await new AgentExecutionService(store, clock).apply(request);
        const before = await executionState(store);
        let reads = 0;
        const sequentialClock = () => Date.parse(reads++ === 0 && !crossedBeforeValidation ? beforeMidnight : afterMidnight);
        const service = new AgentExecutionService(store, sequentialClock);
        const operation = action === "apply" ? service.apply(request) : service.revert(request.operationId, { operationId: "midnight-revert" });
        await assert.rejects(operation, code(action === "apply" ? "DATE_EXPIRED" : "RESTORE_CONFLICT"));
        assert.equal(reads, crossedBeforeValidation ? 1 : 2);
        assert.deepEqual(await executionState(store), before);
        const operationId = action === "apply" ? request.operationId : "midnight-revert";
        assert.deepEqual(await store.getOperationResult(operationId), { status: "not_found", operationId });
      } finally { store.close(); }
    });
  }

  test(`${action} uses the final execution instant for its receipt and events on a valid day`, async () => {
    const store = new SQLitePlannerStore(":memory:");
    try {
      const request = await seed(store, ["old"]);
      if (action === "revert") await new AgentExecutionService(store, clock).apply(request);
      let reads = 0;
      const service = new AgentExecutionService(store, () => Date.parse(reads++ === 0 ? now : beforeMidnight));
      const result = receipt(await (action === "apply" ? service.apply(request) : service.revert(request.operationId, { operationId: "same-day-revert" })));
      assert.equal(reads, 2);
      assert.equal(result.executedAt, beforeMidnight);
      assert.equal(result.date, today);
      const events = (await store.listPlannerEvents()).filter((event) => event.operationId === result.operationId);
      assert.ok(events.length > 0);
      assert.ok(events.every((event) => event.date === today && event.at === result.executedAt));
    } finally { store.close(); }
  });
}
