import { describe, expect, it } from "vitest";

import { MemoryPlannerStore } from "../../../support/memory-planner-store";
import type { FocusRecord, Task } from "@newday/core/domain/planner-model";
import { getDayPlan } from "@newday/core/application/day-plan";

const TODAY = "2026-09-01";
const NOW = "2026-09-01T08:00:00.000Z";

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

function focusRecord(overrides: Partial<FocusRecord> = {}): FocusRecord {
  return {
    id: "focus-1",
    date: TODAY,
    taskId: "task-1",
    focusedAt: NOW,
    ...overrides,
  };
}

describe("getDayPlan", () => {
  it("projects an open overdue task into today without changing its dates", async () => {
    const store = new MemoryPlannerStore();
    const overdue = task({
      startDate: "2026-08-30",
      endDate: "2026-08-31",
    });
    await store.putTask(overdue);

    const plan = await getDayPlan(store, {
      selectedDate: TODAY,
      asOfDate: TODAY,
    });

    expect(plan.overdue).toEqual([{ task: overdue, isOverdue: true }]);
    expect(plan.open).toEqual([]);
    expect(plan.counts).toEqual({
      open: 1,
      completed: 0,
      overdue: 1,
      focus: 0,
    });
    expect(await store.getTask(overdue.id)).toEqual(overdue);
  });

  it("does not inject focus or overdue tasks into another selected date", async () => {
    const store = new MemoryPlannerStore();
    await store.putTask(
      task({ startDate: "2026-08-30", endDate: "2026-08-31" }),
    );
    await store.putFocusRecord(focusRecord());

    const plan = await getDayPlan(store, {
      selectedDate: "2026-09-02",
      asOfDate: TODAY,
    });

    expect(plan.isToday).toBe(false);
    expect(plan.focus).toEqual([]);
    expect(plan.overdue).toEqual([]);
    expect(plan.open).toEqual([]);
    expect(plan.completed).toEqual([]);
  });

  it("places a focused overdue task once and counts visible work once", async () => {
    const store = new MemoryPlannerStore();
    const overdue = task({
      startDate: "2026-08-30",
      endDate: "2026-08-31",
    });
    await store.putTask(overdue);
    await store.putFocusRecord(focusRecord({ taskId: overdue.id }));

    const plan = await getDayPlan(store, {
      selectedDate: TODAY,
      asOfDate: TODAY,
    });

    expect(plan.focus).toEqual([{ task: overdue, isOverdue: true }]);
    expect(plan.overdue).toEqual([]);
    expect(plan.open).toEqual([]);
    expect(plan.completed).toEqual([]);
    expect(plan.counts).toEqual({
      open: 1,
      completed: 0,
      overdue: 1,
      focus: 1,
    });
  });

  it("keeps overdue work completed today in today's completed section", async () => {
    const store = new MemoryPlannerStore();
    const completed = task({
      startDate: "2026-08-30",
      endDate: "2026-08-31",
      status: "completed",
      completedAt: NOW,
      completedOn: TODAY,
    });
    await store.putTask(completed);

    const todayPlan = await getDayPlan(store, {
      selectedDate: TODAY,
      asOfDate: TODAY,
    });
    const tomorrowPlan = await getDayPlan(store, {
      selectedDate: "2026-09-02",
      asOfDate: "2026-09-02",
    });

    expect(todayPlan.completed).toEqual([
      { task: completed, isOverdue: true },
    ]);
    expect(tomorrowPlan.completed).toEqual([]);
  });

  it("orders focus, overdue, open, and completed tasks deterministically", async () => {
    const store = new MemoryPlannerStore();
    const tasks = [
      task({
        id: "open-later",
        title: "稍后截止",
        endDate: "2026-09-02",
        createdAt: "2026-08-30T08:00:00.000Z",
      }),
      task({
        id: "open-today",
        title: "今天截止",
        createdAt: "2026-08-31T08:00:00.000Z",
      }),
      task({
        id: "overdue-newer",
        title: "较晚逾期",
        startDate: "2026-08-30",
        endDate: "2026-08-31",
        createdAt: "2026-08-30T08:00:00.000Z",
      }),
      task({
        id: "overdue-older",
        title: "更早逾期",
        startDate: "2026-08-28",
        endDate: "2026-08-29",
        createdAt: "2026-08-31T08:00:00.000Z",
      }),
      task({
        id: "completed",
        title: "已完成",
        status: "completed",
        completedAt: "2026-09-01T09:00:00.000Z",
        completedOn: TODAY,
      }),
    ];

    for (const value of tasks) {
      await store.putTask(value);
    }
    await store.putFocusRecord(
      focusRecord({
        id: "focus-open-later",
        taskId: "open-later",
        focusedAt: "2026-09-01T07:00:00.000Z",
      }),
    );

    const plan = await getDayPlan(store, {
      selectedDate: TODAY,
      asOfDate: TODAY,
    });

    expect(plan.focus.map(({ task }) => task.id)).toEqual(["open-later"]);
    expect(plan.overdue.map(({ task }) => task.id)).toEqual([
      "overdue-older",
      "overdue-newer",
    ]);
    expect(plan.open.map(({ task }) => task.id)).toEqual(["open-today"]);
    expect(plan.completed.map(({ task }) => task.id)).toEqual(["completed"]);
  });
});
