import {
  instantSchema,
  localDateForInstant,
  localDateSchema,
  taskSchema,
  timeBlockSchema,
} from "../domain/planner-model";
import type { PlannerStore } from "./planner-store";

export type CreateTaskInput = {
  id: string;
  title: string;
  notes?: string;
  plannedDate: string;
  estimatedMinutes?: number | null;
  now: string;
};

export type PlannerCommand =
  | { type: "createTask"; input: CreateTaskInput }
  | {
      type: "updateTask";
      input: {
        taskId: string;
        title?: string;
        notes?: string;
        estimatedMinutes?: number | null;
        now: string;
      };
    }
  | {
      type: "scheduleTask";
      input: {
        id: string;
        taskId: string;
        start: string;
        end: string;
        now: string;
      };
    }
  | {
      type: "moveTimeBlock" | "resizeTimeBlock";
      input: {
        timeBlockId: string;
        start: string;
        end: string;
        now: string;
      };
    }
  | {
      type: "unscheduleTask";
      input: { taskId: string };
    }
  | {
      type: "completeTask" | "reopenTask";
      input: { taskId: string; now: string };
    }
  | {
      type: "moveTaskToDate" | "carryOverTask";
      input: { taskId: string; destinationDate: string; now: string };
    }
  | {
      type: "deleteTask";
      input: { taskId: string };
    };

export async function executePlannerCommand(
  store: PlannerStore,
  command: PlannerCommand,
): Promise<void> {
  await executePlannerCommands(store, [command]);
}

export async function executePlannerCommands(
  store: PlannerStore,
  commands: readonly PlannerCommand[],
): Promise<void> {
  await store.transaction(async () => {
    for (const command of commands) {
      await applyPlannerCommand(store, command);
    }
  });
}

async function applyPlannerCommand(
  store: PlannerStore,
  command: PlannerCommand,
): Promise<void> {
  switch (command.type) {
    case "createTask": {
      const input = command.input;

      if (await store.getTask(input.id)) {
        throw new Error(`任务已存在：${input.id}`);
      }

      await store.putTask(
        taskSchema.parse({
          id: input.id,
          title: input.title,
          notes: input.notes ?? "",
          plannedDate: input.plannedDate,
          status: "open",
          estimatedMinutes: input.estimatedMinutes ?? null,
          createdAt: input.now,
          updatedAt: input.now,
          completedAt: null,
        }),
      );
      return;
    }

    case "updateTask": {
      const input = command.input;
      instantSchema.parse(input.now);
      const task = await requireTask(store, input.taskId);
      await store.putTask(
        taskSchema.parse({
          ...task,
          title: input.title ?? task.title,
          notes: input.notes ?? task.notes,
          estimatedMinutes:
            input.estimatedMinutes === undefined
              ? task.estimatedMinutes
              : input.estimatedMinutes,
          updatedAt: input.now,
        }),
      );
      return;
    }

    case "scheduleTask": {
      const input = command.input;

      if (await store.getTimeBlock(input.id)) {
        throw new Error(`时间块已存在：${input.id}`);
      }

      const task = await requireOpenTask(store, input.taskId);
      const date = localDateForInstant(input.start);

      if (task.plannedDate !== date) {
        throw new Error("时间块必须安排在任务所属日期");
      }

      await store.putTimeBlock(
        timeBlockSchema.parse({
          id: input.id,
          taskId: input.taskId,
          date,
          start: input.start,
          end: input.end,
          createdAt: input.now,
          updatedAt: input.now,
        }),
      );
      return;
    }

    case "moveTimeBlock":
    case "resizeTimeBlock": {
      const input = command.input;
      const block = await requireTimeBlock(store, input.timeBlockId);
      const task = await requireOpenTask(store, block.taskId);
      const date = localDateForInstant(input.start);

      if (task.plannedDate !== date) {
        throw new Error("时间块必须安排在任务所属日期");
      }

      await store.putTimeBlock(
        timeBlockSchema.parse({
          ...block,
          date,
          start: input.start,
          end: input.end,
          updatedAt: input.now,
        }),
      );
      return;
    }

    case "unscheduleTask": {
      await requireTask(store, command.input.taskId);
      await store.deleteTimeBlocksForTask(command.input.taskId);
      return;
    }

    case "completeTask":
    case "reopenTask": {
      const task = await requireTask(store, command.input.taskId);
      const completed = command.type === "completeTask";
      await store.putTask(
        taskSchema.parse({
          ...task,
          status: completed ? "completed" : "open",
          completedAt: completed ? command.input.now : null,
          updatedAt: command.input.now,
        }),
      );
      return;
    }

    case "moveTaskToDate":
    case "carryOverTask": {
      localDateSchema.parse(command.input.destinationDate);
      const task = await requireTask(store, command.input.taskId);

      if (command.type === "carryOverTask" && task.status === "completed") {
        throw new Error("已完成任务不能移到明天");
      }

      await store.deleteTimeBlocksForTask(task.id);
      await store.putTask(
        taskSchema.parse({
          ...task,
          plannedDate: command.input.destinationDate,
          updatedAt: command.input.now,
        }),
      );
      return;
    }

    case "deleteTask": {
      await requireTask(store, command.input.taskId);
      await store.deleteTimeBlocksForTask(command.input.taskId);
      await store.deleteTask(command.input.taskId);
      return;
    }
  }
}

async function requireTask(store: PlannerStore, id: string) {
  const task = await store.getTask(id);

  if (!task) {
    throw new Error(`任务不存在：${id}`);
  }

  return task;
}

async function requireOpenTask(store: PlannerStore, id: string) {
  const task = await requireTask(store, id);

  if (task.status === "completed") {
    throw new Error("已完成任务不能调整时间");
  }

  return task;
}

async function requireTimeBlock(store: PlannerStore, id: string) {
  const block = await store.getTimeBlock(id);

  if (!block) {
    throw new Error(`时间块不存在：${id}`);
  }

  return block;
}
