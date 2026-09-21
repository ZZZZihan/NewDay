import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { restorePlannerBackup } from "@newday/core/application/planner-backup";
import {
  executePlannerCommand,
  executePlannerCommands,
  type PlannerCommand,
} from "@newday/core/application/planner-command";
import { undoPlannerCommand, type UndoReceipt } from "@newday/core/application/planner-undo";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";
import { backup, createTask, now, task, today } from "./fixtures.js";

const later = "2026-09-08T09:00:00.000Z";
const tomorrow = "2026-09-09";

function storeFor(t: TestContext) {
  const store = new SQLitePlannerStore(":memory:");
  t.after(() => store.close());
  return store;
}

function complete(taskId = "task-1"): PlannerCommand {
  return { type: "completeTask", input: { taskId, now: later } };
}

async function completeWithReceipt(store: SQLitePlannerStore) {
  await store.putTask(task());
  const receipt = await executePlannerCommand(store, complete());
  assert.ok(receipt);
  return receipt;
}

test("outer rollback keeps the old receipt and never publishes the replacement", async (t) => {
  const store = storeFor(t);
  const oldReceipt = await completeWithReceipt(store);
  const before = await store.getTask("task-1");
  let rolledBackReceipt: UndoReceipt | undefined;

  await assert.rejects(store.transaction(async () => {
    rolledBackReceipt = await executePlannerCommand(store, {
      type: "reopenTask", input: { taskId: "task-1", now: later },
    });
    assert.ok(rolledBackReceipt);
    throw new Error("abort outer");
  }), /abort outer/);

  assert.deepEqual(await store.getTask("task-1"), before);
  await assert.rejects(undoPlannerCommand(store, rolledBackReceipt!), /撤销操作已失效/);
  await undoPlannerCommand(store, oldReceipt);
  assert.deepEqual(await store.getTask("task-1"), task());
});

test("a new receipt becomes available only after the outer transaction commits", async (t) => {
  const store = storeFor(t);
  await store.putTask(task());
  const receipt = await store.transaction(async () => {
    const pendingReceipt = await executePlannerCommand(store, complete());
    assert.ok(pendingReceipt);
    await assert.rejects(undoPlannerCommand(store, pendingReceipt), /撤销操作已失效/);
    return pendingReceipt;
  });

  await undoPlannerCommand(store, receipt);
  assert.deepEqual(await store.getTask("task-1"), task());
});

test("outer rollback does not consume an undo receipt", async (t) => {
  const store = storeFor(t);
  const receipt = await completeWithReceipt(store);
  const completed = await store.getTask("task-1");

  await assert.rejects(store.transaction(async () => {
    await undoPlannerCommand(store, receipt);
    assert.deepEqual(await store.getTask("task-1"), task());
    throw new Error("abort undo");
  }), /abort undo/);

  assert.deepEqual(await store.getTask("task-1"), completed);
  await undoPlannerCommand(store, receipt);
  assert.deepEqual(await store.getTask("task-1"), task());
  await assert.rejects(undoPlannerCommand(store, receipt), /撤销操作已失效/);
});

for (const action of ["publish", "clear", "consume"] as const) {
  test(`caught savepoint rollback discards pending undo ${action}`, async (t) => {
    const store = storeFor(t);
    const receipt = await completeWithReceipt(store);
    const completed = await store.getTask("task-1");
    let rolledBackReceipt: UndoReceipt | undefined;

    await store.transaction(async () => {
      await assert.rejects(store.transaction(async () => {
        if (action === "publish") {
          rolledBackReceipt = await executePlannerCommand(store, {
            type: "reopenTask", input: { taskId: "task-1", now: later },
          });
        } else if (action === "clear") {
          await executePlannerCommand(store, createTask("rolled-back"));
        } else {
          await undoPlannerCommand(store, receipt);
        }
        throw new Error("abort savepoint");
      }), /abort savepoint/);
      await store.putTask(task("committed"));
    });

    assert.deepEqual(await store.getTask("task-1"), completed);
    assert.equal(await store.getTask("rolled-back"), undefined);
    if (rolledBackReceipt) {
      await assert.rejects(undoPlannerCommand(store, rolledBackReceipt), /撤销操作已失效/);
    }
    await undoPlannerCommand(store, receipt);
    assert.deepEqual(await store.getTask("task-1"), task());
    assert.deepEqual(await store.getTask("committed"), task("committed"));
  });
}

test("rolled-back backup restore preserves undo; committed restore clears it", async (t) => {
  const store = storeFor(t);
  const receipt = await completeWithReceipt(store);
  const completed = await store.getTask("task-1");
  const source = JSON.stringify(backup([task("replacement")]));

  await assert.rejects(store.transaction(async () => {
    await restorePlannerBackup(store, source);
    throw new Error("abort restore");
  }), /abort restore/);
  assert.deepEqual(await store.getTask("task-1"), completed);
  await undoPlannerCommand(store, receipt);

  const nextReceipt = await executePlannerCommand(store, complete());
  assert.ok(nextReceipt);
  await restorePlannerBackup(store, source);
  await assert.rejects(undoPlannerCommand(store, nextReceipt), /撤销操作已失效/);
  assert.deepEqual(await store.listAllTasks(), [task("replacement")]);
});

test("independent concurrent undo calls consume a receipt only once", async (t) => {
  const store = storeFor(t);
  const receipt = await completeWithReceipt(store);
  const results = await Promise.allSettled([
    undoPlannerCommand(store, receipt),
    undoPlannerCommand(store, receipt),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.match(String(rejected.reason), /撤销操作已失效/);
  assert.deepEqual(await store.getTask("task-1"), task());
});

test("unchanged details, schedule, and reopen preserve exact task and focus snapshots", async (t) => {
  const store = storeFor(t);
  const original = task("task-1", {
    seriesId: "series-1", logicalSeriesId: "series-1", occurrenceDate: today,
    occurrenceKey: `series-1:${today}`, isSeriesException: false,
  });
  const focus = { id: "focus-1", taskId: "task-1", date: today, focusedAt: now };
  await store.putTask(original);
  await store.putFocusRecord(focus);
  await store.putTask(task("undo-target"));
  const receipt = await executePlannerCommand(store, complete("undo-target"));
  assert.ok(receipt);
  const version = await store.getPlanningVersion();
  const events = await store.listPlannerEvents();

  const result = await executePlannerCommands(store, [
    { type: "updateTaskDetails", input: { taskId: "task-1", title: `  ${original.title}  `, notes: "", now: later } },
    { type: "rescheduleTask", input: { taskId: "task-1", startDate: today, endDate: today, now: later } },
    { type: "reopenTask", input: { taskId: "task-1", now: later } },
  ]);

  assert.equal(result, undefined);
  assert.deepEqual(await store.getPlanningVersion(), version);
  assert.deepEqual(await store.listPlannerEvents(), events);
  assert.deepEqual(await store.getTask("task-1"), original);
  assert.deepEqual(await store.listFocusRecordsForTask("task-1"), [focus]);
  await undoPlannerCommand(store, receipt);
  assert.deepEqual(await store.getTask("undo-target"), task("undo-target"));
});

test("completing an already completed task preserves completion dates and the previous undo", async (t) => {
  const store = storeFor(t);
  const receipt = await completeWithReceipt(store);
  const completed = await store.getTask("task-1");
  const version = await store.getPlanningVersion();
  const events = await store.listPlannerEvents();

  const result = await executePlannerCommand(store, {
    type: "completeTask",
    input: { taskId: "task-1", now: "2026-09-09T10:00:00.000Z", completedOn: tomorrow },
  });

  assert.equal(result, undefined);
  assert.deepEqual(await store.getPlanningVersion(), version);
  assert.deepEqual(await store.listPlannerEvents(), events);
  assert.deepEqual(await store.getTask("task-1"), completed);
  await undoPlannerCommand(store, receipt);
  assert.deepEqual(await store.getTask("task-1"), task());
});

for (const startDate of [today, tomorrow]) {
  test(`details plus reschedule to ${startDate} retains the original batch undo snapshot`, async (t) => {
    const store = storeFor(t);
    const original = task();
    const focus = { id: "focus-1", taskId: "task-1", date: today, focusedAt: now };
    await store.putTask(original);
    await store.putFocusRecord(focus);

    const receipt = await executePlannerCommands(store, [
      { type: "updateTaskDetails", input: { taskId: "task-1", title: "完成整理", notes: "发给团队", now: later } },
      { type: "rescheduleTask", input: { taskId: "task-1", startDate, endDate: startDate, now: later } },
    ]);

    assert.ok(receipt);
    assert.equal((await store.getTask("task-1"))?.title, "完成整理");
    assert.equal((await store.getTask("task-1"))?.startDate, startDate);
    assert.deepEqual(await store.listFocusRecordsForTask("task-1"), startDate === today ? [focus] : []);
    await undoPlannerCommand(store, receipt);
    assert.deepEqual(await store.getTask("task-1"), original);
    assert.deepEqual(await store.listFocusRecordsForTask("task-1"), [focus]);
  });
}
