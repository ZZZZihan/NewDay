import "fake-indexeddb/auto";

import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";

import { executePlannerCommand } from "../application/planner-command";
import { DexiePlannerStore } from "./dexie-planner-store";

const databaseNames: string[] = [];

function createStore() {
  const databaseName = `newday-test-${crypto.randomUUID()}`;
  databaseNames.push(databaseName);
  return new DexiePlannerStore(databaseName);
}

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map(DexiePlannerStore.deleteDatabase));
});

describe("DexiePlannerStore", () => {
  it("migrates a version 1 database without losing planning data", async () => {
    const databaseName = `newday-test-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    const legacy = new Dexie(databaseName);
    legacy.version(1).stores({
      tasks: "id, plannedDate, status, updatedAt",
      timeBlocks: "id, taskId, date, start, updatedAt",
    });
    await legacy.table("tasks").add({
      id: "legacy-task",
      title: "迁移前任务",
      notes: "",
      status: "open",
      plannedDate: "2026-09-01",
      estimatedMinutes: null,
      completedAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    legacy.close();

    const migrated = new DexiePlannerStore(databaseName);

    expect((await migrated.getDayPlan("2026-09-01")).tasks).toEqual([
      expect.objectContaining({ id: "legacy-task", title: "迁移前任务" }),
    ]);
    expect(await migrated.getPreferences()).toEqual(
      expect.objectContaining({ id: "default", slotMinutes: 15 }),
    );
    migrated.close();
  });

  it("persists tasks and time blocks across database instances", async () => {
    const first = createStore();

    await executePlannerCommand(first, {
      type: "createTask",
      input: {
        id: "task-1",
        title: "写周报",
        plannedDate: "2026-09-01",
        estimatedMinutes: 60,
        now: "2026-09-01T00:00:00.000Z",
      },
    });
    await executePlannerCommand(first, {
      type: "scheduleTask",
      input: {
        id: "block-1",
        taskId: "task-1",
        start: "2026-09-01T09:00:00.000Z",
        end: "2026-09-01T10:00:00.000Z",
        now: "2026-09-01T00:05:00.000Z",
      },
    });

    const databaseName = first.databaseName;
    first.close();

    const reopened = new DexiePlannerStore(databaseName);
    const day = await reopened.getDayPlan("2026-09-01");

    expect(day.tasks).toEqual([
      expect.objectContaining({ id: "task-1", title: "写周报" }),
    ]);
    expect(day.timeBlocks).toEqual([
      expect.objectContaining({
        id: "block-1",
        taskId: "task-1",
        date: "2026-09-01",
      }),
    ]);
    reopened.close();
  });

  it("commits carry-over task and time-block removal atomically", async () => {
    const store = createStore();

    await executePlannerCommand(store, {
      type: "createTask",
      input: {
        id: "task-1",
        title: "写周报",
        plannedDate: "2026-09-01",
        estimatedMinutes: 60,
        now: "2026-09-01T00:00:00.000Z",
      },
    });
    await executePlannerCommand(store, {
      type: "scheduleTask",
      input: {
        id: "block-1",
        taskId: "task-1",
        start: "2026-09-01T09:00:00.000Z",
        end: "2026-09-01T10:00:00.000Z",
        now: "2026-09-01T00:05:00.000Z",
      },
    });

    await executePlannerCommand(store, {
      type: "carryOverTask",
      input: {
        taskId: "task-1",
        destinationDate: "2026-09-02",
        now: "2026-09-01T14:00:00.000Z",
      },
    });

    expect((await store.getDayPlan("2026-09-01")).tasks).toEqual([]);
    const tomorrow = await store.getDayPlan("2026-09-02");
    expect(tomorrow.tasks).toHaveLength(1);
    expect(tomorrow.timeBlocks).toEqual([]);
    store.close();
  });
});
