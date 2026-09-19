import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_NAMESPACES, type ExecutionReceipt } from "@newday/core/contracts/agent-planning";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";
import { task, today, now } from "./fixtures.js";

test("one revision per committed transaction, read/no-op and nested rollback stay unchanged", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    const initial = await store.getPlanningVersion();
    await store.transaction(async () => {
      await store.putTask(task("a"));
      await store.putTask(task("b"));
      assert.equal((await store.getPlanningVersion()).plannerRevision, 1);
    });
    await store.transaction(async () => { await store.putTask(task("a")); await store.deleteTask("missing"); });
    assert.equal((await store.getPlanningVersion()).plannerRevision, 1);
    await store.transaction(async () => {
      await assert.rejects(store.transaction(async () => { await store.putTask(task("c")); throw new Error("rollback"); }));
      assert.equal((await store.getPlanningVersion()).plannerRevision, 1);
      await store.putTask(task("d"));
    });
    assert.deepEqual(await store.getPlanningVersion(), { ...initial, plannerRevision: 2 });
  } finally { store.close(); }
});

test("failed event append rolls back task and revision, savepoint callbacks do not escape", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const callbacks: string[] = [];
  try {
    const version = await store.getPlanningVersion();
    store.setFailureInjector((point) => { if (point === "before_event") throw new Error("event failed"); });
    await assert.rejects(store.withEventContext({ date: today, at: now, source: "manual" }, () => store.putTask(task())), /event failed/);
    assert.deepEqual(await store.getPlanningVersion(), version);
    assert.deepEqual(await store.listAllTasks(), []);
    assert.deepEqual(await store.listPlannerEvents(), []);
    store.setFailureInjector();
    await store.transaction(async () => {
      store.afterCommit(() => callbacks.push("outer"));
      await assert.rejects(store.transaction(async () => { store.afterCommit(() => callbacks.push("rolled-back")); throw new Error("savepoint"); }));
      await store.transaction(async () => { store.afterCommit(() => callbacks.push("nested")); });
      assert.deepEqual(callbacks, []);
    });
    assert.deepEqual(callbacks, ["outer", "nested"]);
  } finally { store.close(); }
});

test("Agent record transactions serialize and epoch replacement rolls back as a whole", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    const initial = await store.getPlanningVersion();
    await store.putAgentRecord("test", "counter", 0);
    await Promise.all(Array.from({ length: 5 }, () => store.transaction(async () => {
      const value = await store.getAgentRecord<number>("test", "counter");
      await store.putAgentRecord("test", "counter", value! + 1);
    })));
    assert.equal(await store.getAgentRecord("test", "counter"), 5);
    assert.deepEqual(await store.getPlanningVersion(), initial);
    await assert.rejects(store.transaction(async () => { await store.replaceAllData({ tasks: [task()] }); throw new Error("abort"); }));
    assert.deepEqual(await store.getPlanningVersion(), initial);
    await store.replaceAllData({ tasks: [task()] });
    assert.notEqual((await store.getPlanningVersion()).datasetEpoch, initial.datasetEpoch);
  } finally { store.close(); }
});

test("execution ledger and deleted-detail tombstone survive restart and dataset replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-agent-ledger-"));
  const path = join(directory, "test.sqlite");
  let store = new SQLitePlannerStore(path);
  try {
    const version = await store.getPlanningVersion();
    const receipt: ExecutionReceipt = { operationId: "operation", proposalId: "proposal", action: "apply", status: "no_change", beforeVersion: version, afterVersion: version,
      date: today, timeZone: "Asia/Shanghai", beforeFocusTaskIds: [], finalFocusTaskIds: [], addedTaskIds: [], removedTaskIds: [], retainedTaskIds: [], executedAt: now, canRevert: false };
    await store.putExecutionReceipt("digest", receipt);
    await store.putAgentRecord(AGENT_NAMESPACES.proposal, "proposal", { example: true });
    store.close(); store = new SQLitePlannerStore(path);
    assert.deepEqual(await store.getOperationResult("operation"), { status: "found", receipt });
    await store.transaction(async () => { await store.clearExecutionDetails(); await store.replaceAllData({ tasks: [] }); });
    store.close(); store = new SQLitePlannerStore(path);
    assert.equal((await store.getExecutionLedger("operation"))?.requestDigest, "digest");
    assert.deepEqual(await store.getOperationResult("operation"), { status: "details_deleted", operationId: "operation", proposalId: "proposal", datasetEpoch: version.datasetEpoch, terminalStatus: "no_change", detailsDeleted: true });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("parallel nested callers serialize sibling savepoints without escaping the outer transaction", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await store.transaction(async () => {
      await Promise.all([store.putTask(task("a")), store.putTask(task("b"))]);
      assert.equal((await store.getPlanningVersion()).plannerRevision, 1);
      const results = await Promise.allSettled([
        store.transaction(async () => { await store.putTask(task("bad")); throw new Error("abort child"); }),
        store.transaction(async () => { await store.putTask(task("c")); }),
      ]);
      assert.equal(results[0].status, "rejected");
      assert.equal(results[1].status, "fulfilled");
    });
    assert.deepEqual((await store.listAllTasks()).map((value) => value.id), ["a", "b", "c"]);
    assert.equal((await store.getPlanningVersion()).plannerRevision, 1);
    await assert.rejects(store.transaction(async () => { await Promise.all([store.putTask(task("d")), store.putTask(task("e"))]); throw new Error("abort outer"); }));
    assert.deepEqual((await store.listAllTasks()).map((value) => value.id), ["a", "b", "c"]);
  } finally { store.close(); }
});
