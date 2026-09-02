import { describe, expect, it } from "vitest";

import { MemoryPlannerStore } from "../adapters/memory-planner-store";
import type {
  FocusRecord,
  RecurrenceSeries,
  Task,
} from "../domain/planner-model";
import {
  executePlannerCommand,
  executePlannerCommands,
  type CreateTaskInput,
} from "./planner-command";
import { clearUndoReceipts, undoPlannerCommand } from "./planner-undo";

const TODAY = "2026-09-01";
const TOMORROW = "2026-09-02";
const NOW = "2026-09-01T08:00:00.000Z";

function createTaskInput(
  overrides: Partial<CreateTaskInput> = {},
): CreateTaskInput {
  return {
    id: "task-1",
    title: "写周报",
    startDate: TODAY,
    endDate: TODAY,
    now: NOW,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "写周报",
    notes: "",
    startDate: TODAY,
    endDate: TODAY,
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
    notes: "",
    startDate: TODAY,
    pattern: { kind: "daily" },
    end: { kind: "never" },
    excludedDates: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function focus(overrides: Partial<FocusRecord> = {}): FocusRecord {
  return {
    id: `focus:${TODAY}:task-1`,
    date: TODAY,
    taskId: "task-1",
    focusedAt: NOW,
    ...overrides,
  };
}

describe("planner command metadata", () => {
  it("records completedAt and completedOn, then clears both on reopen", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: createTaskInput(),
    });

    await executePlannerCommand(store, {
      type: "completeTask",
      input: {
        taskId: "task-1",
        now: "2026-09-01T23:30:00.000Z",
        asOfDate: TOMORROW,
      },
    });
    expect(await store.getTask("task-1")).toEqual(
      expect.objectContaining({
        status: "completed",
        completedAt: "2026-09-01T23:30:00.000Z",
        completedOn: TOMORROW,
      }),
    );

    await executePlannerCommand(store, {
      type: "reopenTask",
      input: { taskId: "task-1", now: "2026-09-02T00:01:00.000Z" },
    });
    expect(await store.getTask("task-1")).toEqual(
      expect.objectContaining({
        status: "open",
        completedAt: null,
        completedOn: null,
      }),
    );
  });

  it("falls back to the completion instant date for the current UI", async () => {
    const store = new MemoryPlannerStore();
    await store.putTask(task());

    await executePlannerCommand(store, {
      type: "completeTask",
      input: { taskId: "task-1", now: "2026-09-02T00:30:00.000Z" },
    });

    expect((await store.getTask("task-1"))?.completedOn).toBe(TOMORROW);
  });

  it("keeps legacy updateTask compatible and makes date changes undoable", async () => {
    const store = new MemoryPlannerStore();
    await store.putTask(task());

    const receipt = await executePlannerCommand(store, {
      type: "updateTask",
      input: {
        taskId: "task-1",
        title: "完成周报",
        startDate: TOMORROW,
        endDate: TOMORROW,
        now: "2026-09-01T09:00:00.000Z",
      },
    });

    expect(await store.getTask("task-1")).toEqual(
      expect.objectContaining({ title: "完成周报", startDate: TOMORROW }),
    );
    await undoPlannerCommand(store, receipt!);
    expect(await store.getTask("task-1")).toEqual(task());
  });

  it("updates series and stops it on an inclusive date", async () => {
    const store = new MemoryPlannerStore();

    await executePlannerCommand(store, {
      type: "createRecurrenceSeries",
      input: {
        id: "series-1",
        title: "每日复盘",
        startDate: TODAY,
        pattern: { kind: "daily" },
        end: { kind: "never" },
        now: NOW,
      },
    });
    await executePlannerCommand(store, {
      type: "updateRecurrenceSeries",
      input: {
        seriesId: "series-1",
        title: "工作日复盘",
        pattern: { kind: "weekdays" },
        now: "2026-09-01T09:00:00.000Z",
      },
    });
    await executePlannerCommand(store, {
      type: "stopRecurrenceSeries",
      input: {
        seriesId: "series-1",
        endDate: TOMORROW,
        now: "2026-09-01T10:00:00.000Z",
      },
    });

    expect(await store.getRecurrenceSeries("series-1")).toEqual(
      expect.objectContaining({
        title: "工作日复盘",
        pattern: { kind: "weekdays" },
        end: { kind: "onDate", date: TOMORROW },
      }),
    );
  });
});

describe("today focus commands", () => {
  it("allows open visible or overdue tasks and keeps a stable record", async () => {
    const store = new MemoryPlannerStore();
    await store.putTask(
      task({ startDate: "2026-08-30", endDate: "2026-08-31" }),
    );

    await executePlannerCommand(store, {
      type: "setTodayFocus",
      input: { taskId: "task-1", date: TODAY, now: NOW },
    });
    await executePlannerCommand(store, {
      type: "setTodayFocus",
      input: {
        taskId: "task-1",
        date: TODAY,
        now: "2026-09-01T09:00:00.000Z",
      },
    });

    expect(await store.listFocusRecordsForDate(TODAY)).toEqual([focus()]);
  });

  it("rejects completed and future tasks", async () => {
    const store = new MemoryPlannerStore();
    await store.putTask(
      task({
        status: "completed",
        completedAt: NOW,
        completedOn: TODAY,
      }),
    );
    await store.putTask(
      task({ id: "future-task", startDate: TOMORROW, endDate: TOMORROW }),
    );

    await expect(
      executePlannerCommand(store, {
        type: "setTodayFocus",
        input: { taskId: "task-1", date: TODAY, now: NOW },
      }),
    ).rejects.toThrow("只有未完成任务");
    await expect(
      executePlannerCommand(store, {
        type: "setTodayFocus",
        input: { taskId: "future-task", date: TODAY, now: NOW },
      }),
    ).rejects.toThrow("任务在该日期不可见");
  });

  it("enforces the three-task limit and removes focus explicitly", async () => {
    const store = new MemoryPlannerStore();

    for (let index = 1; index <= 4; index += 1) {
      await store.putTask(task({ id: `task-${index}` }));
    }
    for (let index = 1; index <= 3; index += 1) {
      await executePlannerCommand(store, {
        type: "setTodayFocus",
        input: { taskId: `task-${index}`, date: TODAY, now: NOW },
      });
    }

    await expect(
      executePlannerCommand(store, {
        type: "setTodayFocus",
        input: { taskId: "task-4", date: TODAY, now: NOW },
      }),
    ).rejects.toThrow("今日重点最多 3 项");

    await executePlannerCommand(store, {
      type: "removeTodayFocus",
      input: { taskId: "task-1", date: TODAY },
    });
    expect((await store.listFocusRecordsForDate(TODAY)).map((item) => item.taskId)).toEqual([
      "task-2",
      "task-3",
    ]);
  });
});

describe("planner undo", () => {
  it("undoes one-off deletion without affecting unrelated tasks", async () => {
    const store = new MemoryPlannerStore();
    const deletedTask = task();
    const unrelatedTask = task({ id: "task-2", title: "保留任务" });
    await store.putTask(deletedTask);
    await store.putTask(unrelatedTask);

    const receipt = await executePlannerCommand(store, {
      type: "deleteTask",
      input: { taskId: deletedTask.id },
    });
    await store.putTask({ ...unrelatedTask, title: "外部更新" });

    await undoPlannerCommand(store, receipt!);
    expect(await store.getTask(deletedTask.id)).toEqual(deletedTask);
    expect((await store.getTask(unrelatedTask.id))?.title).toBe("外部更新");
  });

  it("undoes completion and restores exact focus metadata", async () => {
    const store = new MemoryPlannerStore();
    const originalTask = task();
    const originalFocus = focus({ focusedAt: "2026-09-01T07:30:00.000Z" });
    await store.putTask(originalTask);
    await store.putFocusRecord(originalFocus);

    const receipt = await executePlannerCommand(store, {
      type: "completeTask",
      input: { taskId: originalTask.id, now: "2026-09-01T09:00:00.000Z" },
    });

    expect(await store.listFocusRecordsForTask(originalTask.id)).toEqual([]);
    await undoPlannerCommand(store, receipt!);
    expect(await store.getTask(originalTask.id)).toEqual(originalTask);
    expect(await store.listFocusRecordsForTask(originalTask.id)).toEqual([
      originalFocus,
    ]);
  });

  it("undoes reschedule and a details-plus-reschedule batch exactly", async () => {
    const store = new MemoryPlannerStore();
    const originalTask = task();
    const originalFocus = focus();
    await store.putTask(originalTask);
    await store.putFocusRecord(originalFocus);

    const receipt = await executePlannerCommands(store, [
      {
        type: "updateTaskDetails",
        input: {
          taskId: originalTask.id,
          title: "完成周报",
          notes: "发给团队",
          now: "2026-09-01T09:00:00.000Z",
        },
      },
      {
        type: "rescheduleTask",
        input: {
          taskId: originalTask.id,
          startDate: TOMORROW,
          endDate: TOMORROW,
          now: "2026-09-01T09:00:00.000Z",
        },
      },
    ]);

    expect(await store.getTask(originalTask.id)).toEqual(
      expect.objectContaining({ title: "完成周报", startDate: TOMORROW }),
    );
    expect(await store.listFocusRecordsForTask(originalTask.id)).toEqual([]);

    await undoPlannerCommand(store, receipt!);
    expect(await store.getTask(originalTask.id)).toEqual(originalTask);
    expect(await store.listFocusRecordsForTask(originalTask.id)).toEqual([
      originalFocus,
    ]);
  });

  it("marks recurring reschedules as exceptions and restores them", async () => {
    const store = new MemoryPlannerStore();
    const occurrence = task({
      seriesId: "series-1",
      occurrenceDate: TODAY,
      occurrenceKey: `series-1:${TODAY}`,
      isSeriesException: false,
    });
    await store.putTask(occurrence);

    await expect(
      executePlannerCommand(store, {
        type: "rescheduleTask",
        input: {
          taskId: occurrence.id,
          startDate: TOMORROW,
          endDate: "2026-09-03",
          now: "2026-09-01T09:00:00.000Z",
        },
      }),
    ).rejects.toThrow("重复任务实例必须是单日任务");
    expect(await store.getTask(occurrence.id)).toEqual(occurrence);

    const receipt = await executePlannerCommand(store, {
      type: "rescheduleTask",
      input: {
        taskId: occurrence.id,
        startDate: TOMORROW,
        endDate: TOMORROW,
        now: "2026-09-01T09:00:00.000Z",
      },
    });

    expect(await store.getTask(occurrence.id)).toEqual(
      expect.objectContaining({
        startDate: TOMORROW,
        endDate: TOMORROW,
        occurrenceDate: TODAY,
        occurrenceKey: `series-1:${TODAY}`,
        isSeriesException: true,
      }),
    );
    await undoPlannerCommand(store, receipt!);
    expect(await store.getTask(occurrence.id)).toEqual(occurrence);
  });

  it("undoes recurring deletion including exclusion and focus", async () => {
    const store = new MemoryPlannerStore();
    const originalSeries = series();
    const occurrence = task({
      seriesId: originalSeries.id,
      occurrenceDate: TODAY,
      occurrenceKey: `${originalSeries.id}:${TODAY}`,
      isSeriesException: false,
    });
    const originalFocus = focus();
    await store.putRecurrenceSeries(originalSeries);
    await store.putTask(occurrence);
    await store.putFocusRecord(originalFocus);

    const receipt = await executePlannerCommand(store, {
      type: "deleteTask",
      input: {
        taskId: occurrence.id,
        now: "2026-09-01T09:00:00.000Z",
      },
    });

    expect(await store.getTask(occurrence.id)).toBeUndefined();
    expect((await store.getRecurrenceSeries(originalSeries.id))?.excludedDates).toEqual([
      TODAY,
    ]);
    expect(await store.listFocusRecordsForTask(occurrence.id)).toEqual([]);

    await undoPlannerCommand(store, receipt!);
    expect(await store.getTask(occurrence.id)).toEqual(occurrence);
    expect(await store.getRecurrenceSeries(originalSeries.id)).toEqual(
      originalSeries,
    );
    expect(await store.listFocusRecordsForTask(occurrence.id)).toEqual([
      originalFocus,
    ]);
  });

  it("keeps the latest receipt after a failed mutation and consumes it once", async () => {
    const store = new MemoryPlannerStore();
    await store.putTask(task());
    const receipt = await executePlannerCommand(store, {
      type: "completeTask",
      input: { taskId: "task-1", now: "2026-09-01T09:00:00.000Z" },
    });

    await expect(
      executePlannerCommand(store, {
        type: "createTask",
        input: createTaskInput(),
      }),
    ).rejects.toThrow("任务已存在");

    await undoPlannerCommand(store, receipt!);
    expect((await store.getTask("task-1"))?.status).toBe("open");
    await expect(undoPlannerCommand(store, receipt!)).rejects.toThrow(
      "撤销操作已失效",
    );
  });

  it("invalidates an older receipt after a successful mutation", async () => {
    const store = new MemoryPlannerStore();
    await store.putTask(task());
    const receipt = await executePlannerCommand(store, {
      type: "completeTask",
      input: { taskId: "task-1", now: "2026-09-01T09:00:00.000Z" },
    });

    await executePlannerCommand(store, {
      type: "createTask",
      input: createTaskInput({ id: "task-2" }),
    });

    await expect(undoPlannerCommand(store, receipt!)).rejects.toThrow(
      "撤销操作已失效",
    );
  });

  it("retains a receipt when undo fails and supports explicit clearing", async () => {
    const store = new FailingUndoStore();
    const originalTask = task();
    await store.putTask(originalTask);
    const receipt = await executePlannerCommand(store, {
      type: "completeTask",
      input: { taskId: originalTask.id, now: "2026-09-01T09:00:00.000Z" },
    });

    store.failNextTaskWrite = true;
    await expect(undoPlannerCommand(store, receipt!)).rejects.toThrow(
      "undo write failed",
    );
    await undoPlannerCommand(store, receipt!);
    expect(await store.getTask(originalTask.id)).toEqual(originalTask);

    const nextReceipt = await executePlannerCommand(store, {
      type: "completeTask",
      input: { taskId: originalTask.id, now: "2026-09-01T10:00:00.000Z" },
    });
    clearUndoReceipts(store);
    await expect(undoPlannerCommand(store, nextReceipt!)).rejects.toThrow(
      "撤销操作已失效",
    );
  });
});

class FailingUndoStore extends MemoryPlannerStore {
  failNextTaskWrite = false;

  override async putTask(value: Task) {
    if (this.failNextTaskWrite) {
      this.failNextTaskWrite = false;
      throw new Error("undo write failed");
    }

    await super.putTask(value);
  }
}
