import { describe, expect, it } from "vitest";

import { getDayPlan } from "@newday/core/application/day-plan";
import {
  executePlannerCommand,
  executePlannerCommands,
  type CreateTaskInput,
} from "@newday/core/application/planner-command";
import { MemoryPlannerStore } from "../../../support/memory-planner-store";

const TODAY = "2026-09-01";
const TOMORROW = "2026-09-02";
const DAY_AFTER_TOMORROW = "2026-09-03";

function taskInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    id: "task-1",
    title: "写周报",
    startDate: TODAY,
    endDate: TODAY,
    now: "2026-09-01T08:00:00.000Z",
    ...overrides,
  };
}

async function tasksForDate(store: MemoryPlannerStore, date: string) {
  const plan = await getDayPlan(store, {
    selectedDate: date,
    asOfDate: TODAY,
  });

  return [...plan.focus, ...plan.overdue, ...plan.open, ...plan.completed].map(
    ({ task }) => task,
  );
}

describe("planner commands", () => {
  it("creates a task with an inclusive date range", async () => {
    const store = new MemoryPlannerStore();

    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput({ endDate: DAY_AFTER_TOMORROW }),
    });

    for (const date of [TODAY, TOMORROW, DAY_AFTER_TOMORROW]) {
      expect(await tasksForDate(store, date)).toEqual([
        expect.objectContaining({
          id: "task-1",
          title: "写周报",
          startDate: TODAY,
          endDate: DAY_AFTER_TOMORROW,
          status: "open",
        }),
      ]);
    }
  });

  it("keeps a task out of days beyond its date range", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });

    expect(await tasksForDate(store, TOMORROW)).toEqual([]);
  });

  it("updates task details and date range", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });

    await executePlannerCommand(store, {
      type: "updateTask",
      input: {
        taskId: "task-1",
        title: "完成周报",
        notes: "发给团队",
        startDate: TOMORROW,
        endDate: DAY_AFTER_TOMORROW,
        now: "2026-09-01T09:00:00.000Z",
      },
    });

    expect(await tasksForDate(store, TODAY)).toEqual([]);
    expect((await tasksForDate(store, TOMORROW))[0]).toEqual(
      expect.objectContaining({
        title: "完成周报",
        notes: "发给团队",
        startDate: TOMORROW,
        endDate: DAY_AFTER_TOMORROW,
      }),
    );
  });

  it("rejects an end date before the start date", async () => {
    const store = new MemoryPlannerStore();

    await expect(
      executePlannerCommand(store, {
        type: "createTask",
        input: taskInput({ startDate: TOMORROW, endDate: TODAY }),
      }),
    ).rejects.toThrow("截止日期不能早于开始日期");

    expect(await tasksForDate(store, TODAY)).toEqual([]);
  });

  it("completes and reopens a task", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });

    await executePlannerCommand(store, {
      type: "completeTask",
      input: { taskId: "task-1", now: "2026-09-01T12:00:00.000Z" },
    });
    expect((await tasksForDate(store, TODAY))[0]).toEqual(
      expect.objectContaining({
        status: "completed",
        completedAt: "2026-09-01T12:00:00.000Z",
      }),
    );

    await executePlannerCommand(store, {
      type: "reopenTask",
      input: { taskId: "task-1", now: "2026-09-01T12:01:00.000Z" },
    });
    expect((await tasksForDate(store, TODAY))[0]).toEqual(
      expect.objectContaining({ status: "open", completedAt: null }),
    );
  });

  it("rolls back a command batch when one command fails", async () => {
    const store = new MemoryPlannerStore();

    await expect(
      executePlannerCommands(store, [
        { type: "createTask", input: taskInput() },
        {
          type: "createTask",
          input: taskInput({ title: "重复任务" }),
        },
      ]),
    ).rejects.toThrow("任务已存在");

    expect(await tasksForDate(store, TODAY)).toEqual([]);
  });

  it("deletes a task", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });

    await executePlannerCommand(store, {
      type: "deleteTask",
      input: { taskId: "task-1" },
    });

    expect(await tasksForDate(store, TODAY)).toEqual([]);
  });
});
