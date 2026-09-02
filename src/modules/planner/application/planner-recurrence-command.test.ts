import { describe, expect, it } from "vitest";

import { MemoryPlannerStore } from "../adapters/memory-planner-store";
import type { RecurrenceSeries, Task } from "../domain/planner-model";
import { executePlannerCommand } from "./planner-command";

const NOW = "2026-09-01T08:00:00.000Z";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "每日复盘",
    notes: "旧备注",
    startDate: "2026-09-01",
    endDate: "2026-09-01",
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    completedOn: null,
    ...overrides,
  };
}

function series(overrides: Partial<RecurrenceSeries> = {}): RecurrenceSeries {
  return {
    id: "series-1",
    title: "每日复盘",
    notes: "旧备注",
    startDate: "2026-09-01",
    pattern: { kind: "daily" },
    end: { kind: "never" },
    excludedDates: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function occurrence(
  date: string,
  overrides: Partial<Task> = {},
): Task {
  return task({
    id: `series-1:${date}`,
    startDate: date,
    endDate: date,
    seriesId: "series-1",
    occurrenceDate: date,
    occurrenceKey: `series-1:${date}`,
    isSeriesException: false,
    ...overrides,
  });
}

describe("recurrence series commands", () => {
  it("converts an existing one-day task into the first occurrence atomically", async () => {
    const store = new MemoryPlannerStore();
    const original = task();
    await store.putTask(original);

    const receipt = await executePlannerCommand(store, {
      type: "createRecurrenceSeriesFromTask",
      input: {
        taskId: original.id,
        seriesId: "series-1",
        pattern: { kind: "daily" },
        end: { kind: "never" },
        now: "2026-09-01T09:00:00.000Z",
      },
    });

    expect(receipt).toBeUndefined();
    expect(await store.getRecurrenceSeries("series-1")).toEqual(
      expect.objectContaining({
        title: original.title,
        notes: original.notes,
        startDate: original.startDate,
      }),
    );
    expect(await store.getTask(original.id)).toEqual(
      expect.objectContaining({
        id: original.id,
        seriesId: "series-1",
        occurrenceDate: original.startDate,
        occurrenceKey: `series-1:${original.startDate}`,
        isSeriesException: false,
      }),
    );
  });

  it("rejects multi-day, already-recurring, and nonmatching weekday starts", async () => {
    const multiDayStore = new MemoryPlannerStore();
    await multiDayStore.putTask(task({ endDate: "2026-09-02" }));
    await expect(
      executePlannerCommand(multiDayStore, {
        type: "createRecurrenceSeriesFromTask",
        input: {
          taskId: "task-1",
          seriesId: "series-1",
          pattern: { kind: "daily" },
          end: { kind: "never" },
          now: NOW,
        },
      }),
    ).rejects.toThrow("只有单日任务");
    expect(await multiDayStore.listAllRecurrenceSeries()).toEqual([]);

    const recurringStore = new MemoryPlannerStore();
    await recurringStore.putTask(occurrence("2026-09-01", { id: "task-1" }));
    await expect(
      executePlannerCommand(recurringStore, {
        type: "createRecurrenceSeriesFromTask",
        input: {
          taskId: "task-1",
          seriesId: "series-2",
          pattern: { kind: "daily" },
          end: { kind: "never" },
          now: NOW,
        },
      }),
    ).rejects.toThrow("已经属于重复系列");

    const weekendStore = new MemoryPlannerStore();
    await weekendStore.putTask(
      task({ startDate: "2026-09-05", endDate: "2026-09-05" }),
    );
    await expect(
      executePlannerCommand(weekendStore, {
        type: "createRecurrenceSeriesFromTask",
        input: {
          taskId: "task-1",
          seriesId: "series-1",
          pattern: { kind: "weekdays" },
          end: { kind: "never" },
          now: NOW,
        },
      }),
    ).rejects.toThrow("重复规则必须包含任务的开始日期");
  });

  it("marks only-this detail edits as exceptions", async () => {
    const store = new MemoryPlannerStore();
    const value = occurrence("2026-09-01");
    await store.putTask(value);

    await executePlannerCommand(store, {
      type: "updateTaskDetails",
      input: {
        taskId: value.id,
        title: "仅此项复盘",
        now: "2026-09-01T09:00:00.000Z",
      },
    });

    expect(await store.getTask(value.id)).toEqual(
      expect.objectContaining({
        title: "仅此项复盘",
        isSeriesException: true,
      }),
    );
  });

  it("reconciles matching open occurrences from the effective date", async () => {
    const store = new MemoryPlannerStore();
    await store.putRecurrenceSeries(series());
    const before = occurrence("2026-09-01");
    const matching = occurrence("2026-09-02");
    const removed = occurrence("2026-09-03");
    const completed = occurrence("2026-09-04", {
      status: "completed",
      completedAt: "2026-09-04T09:00:00.000Z",
      completedOn: "2026-09-04",
    });
    const exception = occurrence("2026-09-05", {
      title: "保留例外",
      isSeriesException: true,
    });
    for (const value of [before, matching, removed, completed, exception]) {
      await store.putTask(value);
    }
    await store.putFocusRecord({
      id: "focus-removed",
      date: "2026-09-03",
      taskId: removed.id,
      focusedAt: NOW,
    });

    await executePlannerCommand(store, {
      type: "updateRecurrenceSeries",
      input: {
        seriesId: "series-1",
        title: "周三复盘",
        notes: "新备注",
        pattern: { kind: "weekly", weekdays: [3] },
        effectiveDate: "2026-09-02",
        now: "2026-09-01T10:00:00.000Z",
      },
    });

    expect(await store.getTask(before.id)).toEqual(before);
    expect(await store.getTask(matching.id)).toEqual(
      expect.objectContaining({
        title: "周三复盘",
        notes: "新备注",
        isSeriesException: false,
      }),
    );
    expect(await store.getTask(removed.id)).toBeUndefined();
    expect(await store.listFocusRecordsForTask(removed.id)).toEqual([]);
    expect(await store.getTask(completed.id)).toEqual(completed);
    expect(await store.getTask(exception.id)).toEqual(exception);
  });

  it("stops future open occurrences while preserving completed and exceptions", async () => {
    const store = new MemoryPlannerStore();
    await store.putRecurrenceSeries(series());
    const kept = occurrence("2026-09-02");
    const removed = occurrence("2026-09-03");
    const completed = occurrence("2026-09-04", {
      status: "completed",
      completedAt: "2026-09-04T09:00:00.000Z",
      completedOn: "2026-09-04",
    });
    const exception = occurrence("2026-09-05", {
      isSeriesException: true,
    });
    for (const value of [kept, removed, completed, exception]) {
      await store.putTask(value);
    }

    await executePlannerCommand(store, {
      type: "stopRecurrenceSeries",
      input: {
        seriesId: "series-1",
        endDate: "2026-09-02",
        now: "2026-09-01T10:00:00.000Z",
      },
    });

    expect((await store.getRecurrenceSeries("series-1"))?.end).toEqual({
      kind: "onDate",
      date: "2026-09-02",
    });
    expect(await store.getTask(kept.id)).toEqual(kept);
    expect(await store.getTask(removed.id)).toBeUndefined();
    expect(await store.getTask(completed.id)).toEqual(completed);
    expect(await store.getTask(exception.id)).toEqual(exception);
  });
});
