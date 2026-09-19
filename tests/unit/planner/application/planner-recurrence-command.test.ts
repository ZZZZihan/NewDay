import { describe, expect, it } from "vitest";

import { MemoryPlannerStore } from "../../../support/memory-planner-store";
import type { RecurrenceSeries, Task } from "@newday/core/domain/planner-model";
import {
  executePlannerCommand,
  previewStopRecurrenceSeries,
} from "@newday/core/application/planner-command";
import { undoPlannerCommand } from "@newday/core/application/planner-undo";
import { ensureRecurrenceOccurrences } from "@newday/core/application/recurrence-generation";

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
    logicalSeriesId: "series-1",
    title: "每日复盘",
    notes: "旧备注",
    startDate: "2026-09-01",
    effectiveEndDate: null,
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
    logicalSeriesId: "series-1",
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

    const receipt = await executePlannerCommand(store, {
      type: "updateRecurrenceSeries",
      input: {
        seriesId: "series-1",
        newSeriesId: "series-2",
        title: "周三复盘",
        notes: "新备注",
        pattern: { kind: "weekly", weekdays: [3] },
        effectiveDate: "2026-09-02",
        materialization: {
          asOfDate: "2026-09-01",
          throughDate: "2026-09-06",
        },
        now: "2026-09-01T10:00:00.000Z",
      },
    });

    expect(receipt).toBeDefined();
    expect(await store.getRecurrenceSeries("series-1")).toEqual({
      ...series(),
      effectiveEndDate: "2026-09-01",
      updatedAt: "2026-09-01T10:00:00.000Z",
    });
    expect(await store.getRecurrenceSeries("series-2")).toEqual(
      expect.objectContaining({
        logicalSeriesId: "series-1",
        startDate: "2026-09-02",
        effectiveEndDate: null,
        title: "周三复盘",
      }),
    );
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
    expect(await store.getTask(completed.id)).toEqual({
      ...completed,
      seriesId: "series-2",
      isSeriesException: true,
    });
    expect(await store.getTask(exception.id)).toEqual({
      ...exception,
      seriesId: "series-2",
    });

    await undoPlannerCommand(store, receipt!);
    expect(await store.listAllRecurrenceSeries()).toEqual([series()]);
    expect(await store.listAllTasks()).toEqual(
      expect.arrayContaining([before, matching, removed, completed, exception]),
    );
    expect(await store.listAllTasks()).toHaveLength(5);
    expect(await store.listFocusRecordsForTask(removed.id)).toEqual([
      {
        id: "focus-removed",
        date: "2026-09-03",
        taskId: removed.id,
        focusedAt: NOW,
      },
    ]);
  });

  it("materializes a broader replacement only from the cutover and removes it on undo", async () => {
    const store = new MemoryPlannerStore();
    const originalSeries = series({
      pattern: { kind: "weekly", weekdays: [3] },
    });
    const earlier = occurrence("2026-09-02");
    const cutover = occurrence("2026-09-09");
    await store.putRecurrenceSeries(originalSeries);
    await store.putTask(earlier);
    await store.putTask(cutover);

    const receipt = await executePlannerCommand(store, {
      type: "updateRecurrenceSeries",
      input: {
        seriesId: originalSeries.id,
        newSeriesId: "series-2",
        pattern: { kind: "daily" },
        effectiveDate: "2026-09-09",
        materialization: {
          asOfDate: "2026-09-01",
          throughDate: "2026-09-12",
        },
        now: "2026-09-01T10:00:00.000Z",
      },
    });

    const tasks = await store.listAllTasks();
    expect(tasks.map((value) => value.occurrenceDate).sort()).toEqual([
      "2026-09-02",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
    ]);
    expect(tasks.some((value) => value.occurrenceDate === "2026-09-08")).toBe(false);
    expect(await store.getTask(cutover.id)).toEqual(
      expect.objectContaining({
        id: cutover.id,
        occurrenceKey: cutover.occurrenceKey,
        seriesId: "series-2",
      }),
    );

    await undoPlannerCommand(store, receipt!);
    expect(await store.listAllRecurrenceSeries()).toEqual([originalSeries]);
    expect(await store.listAllTasks()).toEqual(
      expect.arrayContaining([earlier, cutover]),
    );
    expect(await store.listAllTasks()).toHaveLength(2);
  });

  it("undo removes occurrences materialized against the replacement afterward", async () => {
    const store = new MemoryPlannerStore();
    const originalSeries = series({
      pattern: { kind: "weekly", weekdays: [3] },
    });
    await store.putRecurrenceSeries(originalSeries);

    const receipt = await executePlannerCommand(store, {
      type: "updateRecurrenceSeries",
      input: {
        seriesId: originalSeries.id,
        newSeriesId: "series-2",
        pattern: { kind: "daily" },
        effectiveDate: "2026-09-09",
        materialization: {
          asOfDate: "2026-09-09",
          throughDate: "2026-09-09",
        },
        now: "2026-09-01T10:00:00.000Z",
      },
    });
    await ensureRecurrenceOccurrences(store, {
      asOfDate: "2026-09-10",
      throughDate: "2026-09-10",
      now: "2026-09-01T11:00:00.000Z",
    });
    const laterTask = await store.getTask("series-1:2026-09-10");
    expect(laterTask).toEqual(expect.objectContaining({ seriesId: "series-2" }));
    await store.putFocusRecord({
      id: "focus-later",
      date: "2026-09-10",
      taskId: laterTask!.id,
      focusedAt: NOW,
    });

    await undoPlannerCommand(store, receipt!);

    expect(await store.listAllRecurrenceSeries()).toEqual([originalSeries]);
    expect(await store.getTask(laterTask!.id)).toBeUndefined();
    expect(await store.listFocusRecordsForTask(laterTask!.id)).toEqual([]);
  });

  it("keeps a cutover occurrence as an exception when the new rule excludes it", async () => {
    const store = new MemoryPlannerStore();
    await store.putRecurrenceSeries(series());
    const current = occurrence("2026-09-02");
    const later = occurrence("2026-09-03");
    await store.putTask(current);
    await store.putTask(later);

    await executePlannerCommand(store, {
      type: "updateRecurrenceSeries",
      input: {
        seriesId: "series-1",
        newSeriesId: "series-2",
        title: "周五复盘",
        pattern: { kind: "weekly", weekdays: [5] },
        effectiveDate: "2026-09-02",
        materialization: {
          asOfDate: "2026-09-01",
          throughDate: "2026-09-05",
        },
        now: "2026-09-01T10:00:00.000Z",
      },
    });

    expect(await store.getTask(current.id)).toEqual(
      expect.objectContaining({
        title: "周五复盘",
        seriesId: "series-2",
        isSeriesException: true,
      }),
    );
    expect(await store.getTask(later.id)).toBeUndefined();
    expect(await store.getTask("series-1:2026-09-04")).toEqual(
      expect.objectContaining({ seriesId: "series-2" }),
    );
  });

  it("keeps a preserved completed occurrence durable after it is reopened", async () => {
    const store = new MemoryPlannerStore();
    await store.putRecurrenceSeries(series());
    const completed = occurrence("2026-09-04", {
      status: "completed",
      completedAt: "2026-09-04T09:00:00.000Z",
      completedOn: "2026-09-04",
    });
    await store.putTask(completed);

    await executePlannerCommand(store, {
      type: "updateRecurrenceSeries",
      input: {
        seriesId: "series-1",
        newSeriesId: "series-2",
        pattern: { kind: "weekly", weekdays: [1] },
        effectiveDate: "2026-09-02",
        materialization: {
          asOfDate: "2026-09-01",
          throughDate: "2026-09-05",
        },
        now: "2026-09-01T10:00:00.000Z",
      },
    });
    expect(await store.getTask(completed.id)).toEqual(
      expect.objectContaining({ isSeriesException: true }),
    );

    await executePlannerCommand(store, {
      type: "reopenTask",
      input: {
        taskId: completed.id,
        now: "2026-09-01T11:00:00.000Z",
      },
    });
    await executePlannerCommand(store, {
      type: "stopRecurrenceSeries",
      input: {
        seriesId: "series-2",
        endDate: "2026-09-02",
        now: "2026-09-01T12:00:00.000Z",
      },
    });

    expect(await store.getTask(completed.id)).toEqual(
      expect.objectContaining({
        status: "open",
        isSeriesException: true,
        seriesId: "series-2",
      }),
    );
  });

  it("replaces the full logical tail when editing an earlier rule segment", async () => {
    const store = new MemoryPlannerStore();
    await store.putRecurrenceSeries(series());

    await executePlannerCommand(store, {
      type: "updateRecurrenceSeries",
      input: {
        seriesId: "series-1",
        newSeriesId: "series-2",
        pattern: { kind: "weekly", weekdays: [5] },
        effectiveDate: "2026-09-05",
        materialization: {
          asOfDate: "2026-09-01",
          throughDate: "2026-09-12",
        },
        now: "2026-09-01T09:00:00.000Z",
      },
    });
    const firstSplitSeries = await store.listAllRecurrenceSeries();
    const firstSplitTasks = await store.listAllTasks();

    const receipt = await executePlannerCommand(store, {
      type: "updateRecurrenceSeries",
      input: {
        seriesId: "series-1",
        newSeriesId: "series-3",
        pattern: { kind: "weekdays" },
        effectiveDate: "2026-09-03",
        materialization: {
          asOfDate: "2026-09-01",
          throughDate: "2026-09-12",
        },
        now: "2026-09-01T10:00:00.000Z",
      },
    });

    expect(await store.listAllRecurrenceSeries()).toEqual([
      expect.objectContaining({
        id: "series-1",
        effectiveEndDate: "2026-09-02",
      }),
      expect.objectContaining({
        id: "series-3",
        logicalSeriesId: "series-1",
        startDate: "2026-09-03",
        effectiveEndDate: null,
      }),
    ]);
    expect(await store.getRecurrenceSeries("series-2")).toBeUndefined();
    expect(
      (await store.listAllTasks()).every(
        (value) => value.seriesId !== "series-2",
      ),
    ).toBe(true);

    await undoPlannerCommand(store, receipt!);
    expect(await store.listAllRecurrenceSeries()).toEqual(firstSplitSeries);
    expect(await store.listAllTasks()).toEqual(firstSplitTasks);
  });

  it("does not split a series for an unchanged tail save", async () => {
    const store = new MemoryPlannerStore();
    const originalSeries = series();
    await store.putRecurrenceSeries(originalSeries);

    const receipt = await executePlannerCommand(store, {
      type: "updateRecurrenceSeries",
      input: {
        seriesId: originalSeries.id,
        newSeriesId: "series-2",
        title: originalSeries.title,
        notes: originalSeries.notes,
        pattern: originalSeries.pattern,
        end: originalSeries.end,
        effectiveDate: "2026-09-02",
        materialization: {
          asOfDate: "2026-09-01",
          throughDate: "2026-09-05",
        },
        now: "2026-09-01T10:00:00.000Z",
      },
    });

    expect(receipt).toBeUndefined();
    expect(await store.listAllRecurrenceSeries()).toEqual([originalSeries]);
    expect(await store.listAllTasks()).toEqual([]);
  });

  it("replaces successor segments when restoring an earlier rule unchanged", async () => {
    const store = new MemoryPlannerStore();
    const prefix = series({
      effectiveEndDate: "2026-09-04",
    });
    const successor = series({
      id: "series-2",
      logicalSeriesId: prefix.logicalSeriesId,
      startDate: "2026-09-05",
      pattern: { kind: "weekly", weekdays: [5] },
    });
    await store.putRecurrenceSeries(prefix);
    await store.putRecurrenceSeries(successor);

    const receipt = await executePlannerCommand(store, {
      type: "updateRecurrenceSeries",
      input: {
        seriesId: prefix.id,
        newSeriesId: "series-3",
        title: prefix.title,
        notes: prefix.notes,
        pattern: prefix.pattern,
        end: prefix.end,
        effectiveDate: "2026-09-03",
        materialization: {
          asOfDate: "2026-09-01",
          throughDate: "2026-09-08",
        },
        now: "2026-09-01T10:00:00.000Z",
      },
    });

    expect(receipt).toBeDefined();
    expect(await store.listAllRecurrenceSeries()).toEqual([
      expect.objectContaining({
        id: prefix.id,
        effectiveEndDate: "2026-09-02",
      }),
      expect.objectContaining({
        id: "series-3",
        logicalSeriesId: prefix.logicalSeriesId,
        startDate: "2026-09-03",
        pattern: prefix.pattern,
        effectiveEndDate: null,
      }),
    ]);
    expect(await store.getRecurrenceSeries(successor.id)).toBeUndefined();
  });

  it("rolls back segment replacement when materialization collides", async () => {
    const store = new MemoryPlannerStore();
    const originalSeries = series({
      pattern: { kind: "weekly", weekdays: [2] },
    });
    const collidingTask = task({
      id: "series-1:2026-09-03",
      title: "同名普通任务",
      startDate: "2026-09-03",
      endDate: "2026-09-03",
    });
    await store.putRecurrenceSeries(originalSeries);
    await store.putTask(collidingTask);

    await expect(
      executePlannerCommand(store, {
        type: "updateRecurrenceSeries",
        input: {
          seriesId: originalSeries.id,
          newSeriesId: "series-2",
          pattern: { kind: "daily" },
          effectiveDate: "2026-09-02",
          materialization: {
            asOfDate: "2026-09-02",
            throughDate: "2026-09-03",
          },
          now: "2026-09-01T10:00:00.000Z",
        },
      }),
    ).rejects.toThrow("重复任务实例 ID 冲突");

    expect(await store.listAllRecurrenceSeries()).toEqual([originalSeries]);
    expect(await store.listAllTasks()).toEqual([collidingTask]);
  });

  it("rejects a stop when its confirmed impact has become stale", async () => {
    const store = new MemoryPlannerStore();
    const originalSeries = series();
    const firstFuture = occurrence("2026-09-03");
    await store.putRecurrenceSeries(originalSeries);
    await store.putTask(firstFuture);
    const impact = await previewStopRecurrenceSeries(store, {
      seriesId: originalSeries.id,
      endDate: "2026-09-02",
    });
    const addedAfterPreview = occurrence("2026-09-04");
    await store.putTask(addedAfterPreview);

    await expect(
      executePlannerCommand(store, {
        type: "stopRecurrenceSeries",
        input: {
          seriesId: originalSeries.id,
          endDate: "2026-09-02",
          expectedImpact: impact,
          now: "2026-09-01T10:00:00.000Z",
        },
      }),
    ).rejects.toThrow("停止范围已变化，请重新确认");

    expect(await store.listAllRecurrenceSeries()).toEqual([originalSeries]);
    expect(await store.listAllTasks()).toEqual(
      expect.arrayContaining([firstFuture, addedAfterPreview]),
    );
    expect(await store.listAllTasks()).toHaveLength(2);
  });

  it("binds a confirmed stop impact to its ending date", async () => {
    const store = new MemoryPlannerStore();
    await store.putRecurrenceSeries(series());
    const impact = await previewStopRecurrenceSeries(store, {
      seriesId: "series-1",
      endDate: "2026-09-02",
    });

    await expect(
      executePlannerCommand(store, {
        type: "stopRecurrenceSeries",
        input: {
          seriesId: "series-1",
          endDate: "2026-09-03",
          expectedImpact: impact,
          now: "2026-09-01T10:00:00.000Z",
        },
      }),
    ).rejects.toThrow("停止范围已变化，请重新确认");

    expect((await store.getRecurrenceSeries("series-1"))?.end).toEqual({
      kind: "never",
    });
  });

  it("rejects a stop when an earlier occurrence deletion changes exclusions", async () => {
    const store = new MemoryPlannerStore();
    const originalSeries = series();
    const earlier = occurrence("2026-09-01");
    const future = occurrence("2026-09-03");
    await store.putRecurrenceSeries(originalSeries);
    await store.putTask(earlier);
    await store.putTask(future);
    const impact = await previewStopRecurrenceSeries(store, {
      seriesId: originalSeries.id,
      endDate: "2026-09-02",
    });

    await executePlannerCommand(store, {
      type: "deleteTask",
      input: { taskId: earlier.id },
    });

    await expect(
      executePlannerCommand(store, {
        type: "stopRecurrenceSeries",
        input: {
          seriesId: originalSeries.id,
          endDate: "2026-09-02",
          expectedImpact: impact,
          now: "2026-09-01T10:00:00.000Z",
        },
      }),
    ).rejects.toThrow("停止范围已变化，请重新确认");

    expect((await store.getRecurrenceSeries(originalSeries.id))?.end).toEqual(
      originalSeries.end,
    );
    expect(await store.getTask(future.id)).toEqual(future);
  });

  it("validates a stop date before presenting its impact", async () => {
    const store = new MemoryPlannerStore();
    await store.putRecurrenceSeries(series());

    await expect(
      previewStopRecurrenceSeries(store, {
        seriesId: "series-1",
        endDate: "2026-08-31",
      }),
    ).rejects.toThrow("生效日期不在当前重复规则段内");
  });

  it("stops across successor segments and reparents preserved occurrences", async () => {
    const store = new MemoryPlannerStore();
    const prefix = series({ effectiveEndDate: "2026-09-02" });
    const successor = series({
      id: "series-2",
      startDate: "2026-09-03",
    });
    const removed = occurrence("2026-09-04", { seriesId: successor.id });
    const completed = occurrence("2026-09-05", {
      seriesId: successor.id,
      status: "completed",
      completedAt: "2026-09-05T09:00:00.000Z",
      completedOn: "2026-09-05",
    });
    await store.putRecurrenceSeries(prefix);
    await store.putRecurrenceSeries(successor);
    await store.putTask(removed);
    await store.putTask(completed);

    await expect(
      previewStopRecurrenceSeries(store, {
        seriesId: prefix.id,
        endDate: "2026-09-02",
      }),
    ).resolves.toEqual({
      openOrdinaryTaskCount: 1,
      focusRecordCount: 0,
      preservedTaskCount: 1,
      successorSegmentCount: 1,
      revision: expect.any(String),
    });

    const receipt = await executePlannerCommand(store, {
      type: "stopRecurrenceSeries",
      input: {
        seriesId: prefix.id,
        endDate: "2026-09-02",
        now: "2026-09-01T10:00:00.000Z",
      },
    });

    expect(await store.getRecurrenceSeries(successor.id)).toBeUndefined();
    expect(await store.getRecurrenceSeries(prefix.id)).toEqual(
      expect.objectContaining({
        effectiveEndDate: null,
        end: { kind: "onDate", date: "2026-09-02" },
      }),
    );
    expect(await store.getTask(removed.id)).toBeUndefined();
    expect(await store.getTask(completed.id)).toEqual({
      ...completed,
      seriesId: prefix.id,
      isSeriesException: true,
    });

    await undoPlannerCommand(store, receipt!);
    expect(await store.listAllRecurrenceSeries()).toEqual([prefix, successor]);
    expect(await store.listAllTasks()).toEqual(
      expect.arrayContaining([removed, completed]),
    );
    expect(await store.listAllTasks()).toHaveLength(2);
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
    const removedFocus = {
      id: "focus-removed",
      date: "2026-09-03",
      taskId: removed.id,
      focusedAt: NOW,
    };
    await store.putFocusRecord(removedFocus);

    await expect(
      previewStopRecurrenceSeries(store, {
        seriesId: "series-1",
        endDate: "2026-09-02",
      }),
    ).resolves.toEqual({
      openOrdinaryTaskCount: 1,
      focusRecordCount: 1,
      preservedTaskCount: 2,
      successorSegmentCount: 0,
      revision: expect.any(String),
    });

    const receipt = await executePlannerCommand(store, {
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
    expect(receipt).toBeDefined();
    expect(await store.getTask(kept.id)).toEqual(kept);
    expect(await store.getTask(removed.id)).toBeUndefined();
    expect(await store.listFocusRecordsForTask(removed.id)).toEqual([]);
    expect(await store.getTask(completed.id)).toEqual({
      ...completed,
      isSeriesException: true,
    });
    expect(await store.getTask(exception.id)).toEqual(exception);

    await undoPlannerCommand(store, receipt!);
    expect(await store.getRecurrenceSeries("series-1")).toEqual(series());
    expect(await store.getTask(removed.id)).toEqual(removed);
    expect(await store.listFocusRecordsForTask(removed.id)).toEqual([
      removedFocus,
    ]);
  });
});
