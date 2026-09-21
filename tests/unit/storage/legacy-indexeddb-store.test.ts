import "fake-indexeddb/auto";

import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";

import type {
  FocusRecord,
  RecurrenceSeries,
  Task,
} from "@newday/core/domain/planner-model";
import { DexiePlannerStore } from "../../support/legacy-indexeddb-store";

const DATE = "2026-09-01";
const NOW = "2026-09-01T00:00:00.000Z";
const databaseNames: string[] = [];

function createStore() {
  const databaseName = `newday-test-${crypto.randomUUID()}`;
  databaseNames.push(databaseName);
  return new DexiePlannerStore(databaseName);
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "写周报",
    notes: "",
    startDate: DATE,
    endDate: DATE,
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    completedOn: null,
    ...overrides,
  };
}

function recurrenceSeries(
  overrides: Partial<RecurrenceSeries> = {},
): RecurrenceSeries {
  return {
    id: "series-1",
    logicalSeriesId: "series-1",
    title: "每日复盘",
    notes: "",
    startDate: DATE,
    effectiveEndDate: null,
    pattern: { kind: "daily" },
    end: { kind: "never" },
    excludedDates: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function focusRecord(overrides: Partial<FocusRecord> = {}): FocusRecord {
  return {
    id: "focus-1",
    date: DATE,
    taskId: "task-1",
    focusedAt: NOW,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map(DexiePlannerStore.deleteDatabase));
});

describe("DexiePlannerStore", () => {
  it("migrates a version 1 task through the latest schema", async () => {
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
      plannedDate: DATE,
      estimatedMinutes: 60,
      completedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    legacy.close();

    const migrated = new DexiePlannerStore(databaseName);

    expect(await migrated.getTask("legacy-task")).toEqual(
      expect.objectContaining({
        id: "legacy-task",
        startDate: DATE,
        endDate: DATE,
        completedOn: null,
      }),
    );
    expect(await migrated.listAllRecurrenceSeries()).toEqual([]);
    expect(await migrated.listAllFocusRecords()).toEqual([]);
    migrated.close();
  });

  it("migrates version 3 tasks by adding completedOn and empty collections", async () => {
    const databaseName = `newday-test-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    const versionThree = new Dexie(databaseName);
    versionThree.version(3).stores({
      tasks: "id, startDate, endDate, status, updatedAt",
    });
    await versionThree.table("tasks").add({
      ...task(),
      completedOn: undefined,
    });
    versionThree.close();

    const migrated = new DexiePlannerStore(databaseName);

    expect(await migrated.getTask("task-1")).toEqual({
      ...task(),
      completedOn: null,
    });
    expect(await migrated.listAllRecurrenceSeries()).toEqual([]);
    expect(await migrated.listAllFocusRecords()).toEqual([]);
    migrated.close();
  });

  it("migrates version 4 recurrence lineage without changing occurrence identity", async () => {
    const databaseName = `newday-test-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    const versionFour = new Dexie(databaseName);
    versionFour.version(4).stores({
      tasks:
        "id, startDate, endDate, status, completedOn, updatedAt, seriesId, occurrenceDate, &occurrenceKey",
      recurrenceSeries: "id, startDate, updatedAt",
      focusRecords: "id, date, taskId, focusedAt, &[date+taskId]",
    });
    const legacySeries = {
      id: "legacy-series",
      title: "每日复盘",
      notes: "旧规则",
      startDate: DATE,
      pattern: { kind: "daily" },
      end: { kind: "never" },
      excludedDates: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const legacyTask = {
      ...task({ id: "legacy-occurrence-id" }),
      seriesId: legacySeries.id,
      occurrenceDate: DATE,
      occurrenceKey: `${legacySeries.id}:${DATE}`,
      isSeriesException: false,
    };
    await versionFour.table("recurrenceSeries").add(legacySeries);
    await versionFour.table("tasks").add(legacyTask);
    versionFour.close();

    const migrated = new DexiePlannerStore(databaseName);
    const expectedSeries = {
      ...legacySeries,
      logicalSeriesId: legacySeries.id,
      effectiveEndDate: null,
    };
    const expectedTask = {
      ...legacyTask,
      logicalSeriesId: legacySeries.id,
    };

    expect(await migrated.getRecurrenceSeries(legacySeries.id)).toEqual(
      expectedSeries,
    );
    expect(await migrated.getTask(legacyTask.id)).toEqual(expectedTask);
    expect(
      await migrated.getTaskByOccurrenceKey(legacyTask.occurrenceKey),
    ).toEqual(expectedTask);
    expect(
      await migrated.listRecurrenceSeriesByLogicalSeriesId(legacySeries.id),
    ).toEqual([expectedSeries]);
    migrated.close();
  });

  it("persists and queries tasks, recurrence series, and focus records", async () => {
    const first = createStore();
    const series = recurrenceSeries();
    const occurrence = task({
      seriesId: series.id,
      logicalSeriesId: series.logicalSeriesId,
      occurrenceDate: DATE,
      occurrenceKey: `${series.id}:${DATE}`,
      isSeriesException: false,
    });
    const focus = focusRecord();

    await first.putRecurrenceSeries(series);
    await first.putTask(occurrence);
    await first.putFocusRecord(focus);

    const databaseName = first.databaseName;
    first.close();

    const reopened = new DexiePlannerStore(databaseName);
    expect(await reopened.getTaskByOccurrenceKey(occurrence.occurrenceKey!)).toEqual(
      occurrence,
    );
    expect(await reopened.listTasksBySeries(series.id)).toEqual([occurrence]);
    expect(await reopened.getRecurrenceSeries(series.id)).toEqual(series);
    expect(await reopened.listAllRecurrenceSeries()).toEqual([series]);
    expect(await reopened.getFocusRecord(focus.id)).toEqual(focus);
    expect(await reopened.listFocusRecordsForDate(DATE)).toEqual([focus]);
    expect(await reopened.listFocusRecordsForTask(occurrence.id)).toEqual([focus]);

    await reopened.deleteFocusRecord(focus.id);
    await reopened.deleteTask(occurrence.id);
    await reopened.deleteRecurrenceSeries(series.id);
    expect(await reopened.listAllTasks()).toEqual([]);
    expect(await reopened.listAllRecurrenceSeries()).toEqual([]);
    expect(await reopened.listAllFocusRecords()).toEqual([]);
    reopened.close();
  });

  it("lists logical recurrence segments by start date and then id", async () => {
    const store = createStore();
    const logicalSeriesId = "logical-series";
    const segmentB = recurrenceSeries({
      id: "segment-b",
      logicalSeriesId,
      startDate: "2026-09-03",
    });
    const segmentEarly = recurrenceSeries({
      id: "segment-early",
      logicalSeriesId,
      effectiveEndDate: "2026-09-02",
    });
    const segmentA = recurrenceSeries({
      id: "segment-a",
      logicalSeriesId,
      startDate: "2026-09-03",
    });
    await store.putRecurrenceSeries(segmentB);
    await store.putRecurrenceSeries(
      recurrenceSeries({ id: "unrelated", logicalSeriesId: "unrelated" }),
    );
    await store.putRecurrenceSeries(segmentEarly);
    await store.putRecurrenceSeries(segmentA);

    expect(
      (
        await store.listRecurrenceSeriesByLogicalSeriesId(logicalSeriesId)
      ).map((series) => series.id),
    ).toEqual(["segment-early", "segment-a", "segment-b"]);
    store.close();
  });

  it("enforces unique occurrence and date-task focus keys", async () => {
    const store = createStore();
    const occurrenceKey = `series-1:${DATE}`;

    await store.putTask(
      task({
        seriesId: "series-1",
        logicalSeriesId: "series-1",
        occurrenceDate: DATE,
        occurrenceKey,
        isSeriesException: false,
      }),
    );
    await expect(
      store.putTask(
        task({
          id: "task-2",
          seriesId: "series-1",
          occurrenceDate: DATE,
          occurrenceKey,
          isSeriesException: false,
        }),
      ),
    ).rejects.toThrow();

    await store.putFocusRecord(focusRecord());
    await expect(
      store.putFocusRecord(focusRecord({ id: "focus-2" })),
    ).rejects.toThrow();
    store.close();
  });

  it("rolls back changes to all three collections in one transaction", async () => {
    const store = createStore();

    await expect(
      store.transaction(async () => {
        await store.putTask(task());
        await store.putRecurrenceSeries(recurrenceSeries());
        await store.putFocusRecord(focusRecord());
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(await store.listAllTasks()).toEqual([]);
    expect(await store.listAllRecurrenceSeries()).toEqual([]);
    expect(await store.listAllFocusRecords()).toEqual([]);
    store.close();
  });

  it("replaces all collections atomically", async () => {
    const store = createStore();
    const originalTask = task({ id: "original-task" });
    const originalSeries = recurrenceSeries({ id: "original-series" });
    const originalFocus = focusRecord({
      id: "original-focus",
      taskId: originalTask.id,
    });

    await store.replaceAllData({
      tasks: [originalTask],
      recurrenceSeries: [originalSeries],
      focusRecords: [originalFocus],
    });

    await expect(
      store.replaceAllData({
        tasks: [task({ id: "replacement-task" })],
        recurrenceSeries: [recurrenceSeries({ id: "replacement-series" })],
        focusRecords: [
          focusRecord({ id: "replacement-focus-1" }),
          focusRecord({ id: "replacement-focus-2" }),
        ],
      }),
    ).rejects.toThrow();

    expect(await store.listAllTasks()).toEqual([originalTask]);
    expect(await store.listAllRecurrenceSeries()).toEqual([originalSeries]);
    expect(await store.listAllFocusRecords()).toEqual([originalFocus]);
    store.close();
  });
});
