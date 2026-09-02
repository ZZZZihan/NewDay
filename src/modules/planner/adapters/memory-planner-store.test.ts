import { describe, expect, it } from "vitest";

import type {
  FocusRecord,
  RecurrenceSeries,
  Task,
} from "../domain/planner-model";
import { MemoryPlannerStore } from "./memory-planner-store";

const DATE = "2026-09-01";
const NOW = "2026-09-01T00:00:00.000Z";

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
    title: "每日复盘",
    notes: "",
    startDate: DATE,
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

describe("MemoryPlannerStore", () => {
  it("stores and queries all planner collections", async () => {
    const store = new MemoryPlannerStore();
    const series = recurrenceSeries();
    const occurrence = task({
      seriesId: series.id,
      occurrenceDate: DATE,
      occurrenceKey: `${series.id}:${DATE}`,
      isSeriesException: false,
    });
    const focus = focusRecord();

    await store.putRecurrenceSeries(series);
    await store.putTask(occurrence);
    await store.putFocusRecord(focus);

    expect(await store.getTaskByOccurrenceKey(occurrence.occurrenceKey!)).toEqual(
      occurrence,
    );
    expect(await store.listTasksBySeries(series.id)).toEqual([occurrence]);
    expect(await store.getRecurrenceSeries(series.id)).toEqual(series);
    expect(await store.listAllRecurrenceSeries()).toEqual([series]);
    expect(await store.getFocusRecord(focus.id)).toEqual(focus);
    expect(await store.listFocusRecordsForDate(DATE)).toEqual([focus]);
    expect(await store.listFocusRecordsForTask(occurrence.id)).toEqual([focus]);

    await store.deleteFocusRecord(focus.id);
    await store.deleteTask(occurrence.id);
    await store.deleteRecurrenceSeries(series.id);
    expect(await store.listAllTasks()).toEqual([]);
    expect(await store.listAllRecurrenceSeries()).toEqual([]);
    expect(await store.listAllFocusRecords()).toEqual([]);
  });

  it("matches Dexie duplicate occurrence and focus-key detection", async () => {
    const store = new MemoryPlannerStore();
    const occurrenceKey = `series-1:${DATE}`;

    await store.putTask(
      task({
        seriesId: "series-1",
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
    ).rejects.toThrow("重复任务实例键");

    await store.putFocusRecord(focusRecord());
    await expect(
      store.putFocusRecord(focusRecord({ id: "focus-2" })),
    ).rejects.toThrow("任务在该日期已设为重点");
  });

  it("rolls back changes to all three collections", async () => {
    const store = new MemoryPlannerStore();

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
  });

  it("rejects duplicate replacement data without changing any collection", async () => {
    const store = new MemoryPlannerStore();
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
        tasks: [
          task({ id: "replacement-task-1" }),
          task({ id: "replacement-task-1" }),
        ],
        recurrenceSeries: [],
        focusRecords: [],
      }),
    ).rejects.toThrow("重复任务 ID");

    expect(await store.listAllTasks()).toEqual([originalTask]);
    expect(await store.listAllRecurrenceSeries()).toEqual([originalSeries]);
    expect(await store.listAllFocusRecords()).toEqual([originalFocus]);
  });
});
