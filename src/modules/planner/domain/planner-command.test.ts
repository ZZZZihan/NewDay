import { describe, expect, it } from "vitest";

import {
  executePlannerCommand,
  executePlannerCommands,
  type CreateTaskInput,
} from "../application/planner-command";
import { MemoryPlannerStore } from "../adapters/memory-planner-store";

const TODAY = "2026-09-01";
const TOMORROW = "2026-09-02";

function taskInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    id: "task-1",
    title: "写周报",
    plannedDate: TODAY,
    estimatedMinutes: 60,
    now: "2026-09-01T08:00:00.000Z",
    ...overrides,
  };
}

describe("planner commands", () => {
  it("creates a task in the selected day plan", async () => {
    const store = new MemoryPlannerStore();

    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });

    const day = await store.getDayPlan(TODAY);
    expect(day.tasks).toEqual([
      expect.objectContaining({
        id: "task-1",
        title: "写周报",
        plannedDate: TODAY,
        status: "open",
        estimatedMinutes: 60,
      }),
    ]);
    expect(day.timeBlocks).toEqual([]);
  });

  it("rejects duplicate task ids without overwriting existing data", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });

    await expect(
      executePlannerCommand(store, {
        type: "createTask",
        input: taskInput({ title: "不应覆盖" }),
      }),
    ).rejects.toThrow("任务已存在");

    expect((await store.getDayPlan(TODAY)).tasks[0]?.title).toBe("写周报");
  });

  it("schedules a task without conflating task and time block", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });

    await executePlannerCommand(store, {
      type: "scheduleTask",
      input: {
        id: "block-1",
        taskId: "task-1",
        start: "2026-09-01T09:00:00.000Z",
        end: "2026-09-01T10:00:00.000Z",
        now: "2026-09-01T08:05:00.000Z",
      },
    });

    const day = await store.getDayPlan(TODAY);
    expect(day.tasks).toHaveLength(1);
    expect(day.timeBlocks).toEqual([
      expect.objectContaining({
        id: "block-1",
        taskId: "task-1",
        start: "2026-09-01T09:00:00.000Z",
        end: "2026-09-01T10:00:00.000Z",
      }),
    ]);
  });

  it("rejects duplicate time block ids without overwriting existing data", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });
    await executePlannerCommand(store, {
      type: "scheduleTask",
      input: {
        id: "block-1",
        taskId: "task-1",
        start: "2026-09-01T09:00:00.000Z",
        end: "2026-09-01T10:00:00.000Z",
        now: "2026-09-01T08:05:00.000Z",
      },
    });

    await expect(
      executePlannerCommand(store, {
        type: "scheduleTask",
        input: {
          id: "block-1",
          taskId: "task-1",
          start: "2026-09-01T11:00:00.000Z",
          end: "2026-09-01T12:00:00.000Z",
          now: "2026-09-01T08:06:00.000Z",
        },
      }),
    ).rejects.toThrow("时间块已存在");

    expect((await store.getDayPlan(TODAY)).timeBlocks[0]).toEqual(
      expect.objectContaining({
        start: "2026-09-01T09:00:00.000Z",
        end: "2026-09-01T10:00:00.000Z",
      }),
    );
  });

  it("allows overlaps and reports every conflicting block", async () => {
    const store = new MemoryPlannerStore();

    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput({ id: "task-2", title: "回复邮件" }),
    });
    await executePlannerCommand(store, {
      type: "scheduleTask",
      input: {
        id: "block-1",
        taskId: "task-1",
        start: "2026-09-01T09:00:00.000Z",
        end: "2026-09-01T10:00:00.000Z",
        now: "2026-09-01T08:05:00.000Z",
      },
    });
    await executePlannerCommand(store, {
      type: "scheduleTask",
      input: {
        id: "block-2",
        taskId: "task-2",
        start: "2026-09-01T09:30:00.000Z",
        end: "2026-09-01T10:30:00.000Z",
        now: "2026-09-01T08:06:00.000Z",
      },
    });

    const day = await store.getDayPlan(TODAY);
    expect([...day.conflictingTimeBlockIds].sort()).toEqual([
      "block-1",
      "block-2",
    ]);
  });

  it("carries an incomplete task to tomorrow and removes its time blocks", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });
    await executePlannerCommand(store, {
      type: "scheduleTask",
      input: {
        id: "block-1",
        taskId: "task-1",
        start: "2026-09-01T09:00:00.000Z",
        end: "2026-09-01T10:00:00.000Z",
        now: "2026-09-01T08:05:00.000Z",
      },
    });

    await executePlannerCommand(store, {
      type: "carryOverTask",
      input: {
        taskId: "task-1",
        destinationDate: TOMORROW,
        now: "2026-09-01T22:00:00.000Z",
      },
    });

    expect((await store.getDayPlan(TODAY)).tasks).toEqual([]);
    const tomorrow = await store.getDayPlan(TOMORROW);
    expect(tomorrow.tasks).toEqual([
      expect.objectContaining({ id: "task-1", plannedDate: TOMORROW }),
    ]);
    expect(tomorrow.timeBlocks).toEqual([]);
  });

  it("rejects carrying over a completed task", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });
    await executePlannerCommand(store, {
      type: "completeTask",
      input: {
        taskId: "task-1",
        now: "2026-09-01T12:00:00.000Z",
      },
    });

    await expect(
      executePlannerCommand(store, {
        type: "carryOverTask",
        input: {
          taskId: "task-1",
          destinationDate: TOMORROW,
          now: "2026-09-01T22:00:00.000Z",
        },
      }),
    ).rejects.toThrow("已完成任务不能移到明天");
  });

  it("moves and resizes an existing time block", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });
    await executePlannerCommand(store, {
      type: "scheduleTask",
      input: {
        id: "block-1",
        taskId: "task-1",
        start: "2026-09-01T09:00:00.000Z",
        end: "2026-09-01T10:00:00.000Z",
        now: "2026-09-01T08:05:00.000Z",
      },
    });

    await executePlannerCommand(store, {
      type: "moveTimeBlock",
      input: {
        timeBlockId: "block-1",
        start: "2026-09-01T10:15:00.000Z",
        end: "2026-09-01T11:15:00.000Z",
        now: "2026-09-01T08:10:00.000Z",
      },
    });
    await executePlannerCommand(store, {
      type: "resizeTimeBlock",
      input: {
        timeBlockId: "block-1",
        start: "2026-09-01T10:15:00.000Z",
        end: "2026-09-01T11:45:00.000Z",
        now: "2026-09-01T08:11:00.000Z",
      },
    });

    expect((await store.getDayPlan(TODAY)).timeBlocks).toEqual([
      expect.objectContaining({
        start: "2026-09-01T10:15:00.000Z",
        end: "2026-09-01T11:45:00.000Z",
      }),
    ]);
  });

  it("unschedules a task without deleting it", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });
    await executePlannerCommand(store, {
      type: "scheduleTask",
      input: {
        id: "block-1",
        taskId: "task-1",
        start: "2026-09-01T09:00:00.000Z",
        end: "2026-09-01T10:00:00.000Z",
        now: "2026-09-01T08:05:00.000Z",
      },
    });

    await executePlannerCommand(store, {
      type: "unscheduleTask",
      input: { taskId: "task-1" },
    });

    const day = await store.getDayPlan(TODAY);
    expect(day.tasks).toHaveLength(1);
    expect(day.timeBlocks).toEqual([]);
  });

  it("reopens a completed task", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });
    await executePlannerCommand(store, {
      type: "completeTask",
      input: {
        taskId: "task-1",
        now: "2026-09-01T12:00:00.000Z",
      },
    });
    await executePlannerCommand(store, {
      type: "reopenTask",
      input: {
        taskId: "task-1",
        now: "2026-09-01T12:01:00.000Z",
      },
    });

    expect((await store.getDayPlan(TODAY)).tasks[0]).toEqual(
      expect.objectContaining({ status: "open", completedAt: null }),
    );
  });

  it("rolls back an entire command batch when one command fails", async () => {
    const store = new MemoryPlannerStore();

    await expect(
      executePlannerCommands(store, [
        {
          type: "createTask",
          input: taskInput(),
        },
        {
          type: "scheduleTask",
          input: {
            id: "block-1",
            taskId: "task-1",
            start: "2026-09-02T09:00:00.000Z",
            end: "2026-09-02T10:00:00.000Z",
            now: "2026-09-01T08:05:00.000Z",
          },
        },
      ]),
    ).rejects.toThrow("时间块必须安排在任务所属日期");

    expect((await store.getDayPlan(TODAY)).tasks).toEqual([]);
  });

  it("deletes a task and its time blocks in one transaction", async () => {
    const store = new MemoryPlannerStore();
    await executePlannerCommand(store, {
      type: "createTask",
      input: taskInput(),
    });
    await executePlannerCommand(store, {
      type: "scheduleTask",
      input: {
        id: "block-1",
        taskId: "task-1",
        start: "2026-09-01T09:00:00.000Z",
        end: "2026-09-01T10:00:00.000Z",
        now: "2026-09-01T08:05:00.000Z",
      },
    });

    await executePlannerCommand(store, {
      type: "deleteTask",
      input: { taskId: "task-1" },
    });

    const day = await store.getDayPlan(TODAY);
    expect(day.tasks).toEqual([]);
    expect(day.timeBlocks).toEqual([]);
  });
});
