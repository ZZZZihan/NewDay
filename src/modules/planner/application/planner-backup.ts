import { z } from "zod";

import {
  instantSchema,
  plannerPreferencesSchema,
  taskSchema,
  timeBlockSchema,
} from "../domain/planner-model";
import type { PlannerArchiveStore } from "./planner-archive-store";

export const plannerBackupSchema = z
  .object({
    format: z.literal("newday-backup"),
    version: z.literal(1),
    exportedAt: instantSchema,
    preferences: plannerPreferencesSchema,
    tasks: z.array(taskSchema),
    timeBlocks: z.array(timeBlockSchema),
  })
  .superRefine((backup, context) => {
    const tasksById = new Map<string, (typeof backup.tasks)[number]>();
    const timeBlockIds = new Set<string>();

    for (const [index, task] of backup.tasks.entries()) {
      if (tasksById.has(task.id)) {
        context.addIssue({
          code: "custom",
          message: `备份中存在重复任务：${task.id}`,
          path: ["tasks", index, "id"],
        });
      }
      tasksById.set(task.id, task);
    }

    for (const [index, block] of backup.timeBlocks.entries()) {
      if (timeBlockIds.has(block.id)) {
        context.addIssue({
          code: "custom",
          message: `备份中存在重复时间块：${block.id}`,
          path: ["timeBlocks", index, "id"],
        });
      }
      timeBlockIds.add(block.id);

      if (!tasksById.has(block.taskId)) {
        context.addIssue({
          code: "custom",
          message: `时间块引用了不存在的任务：${block.taskId}`,
          path: ["timeBlocks", index, "taskId"],
        });
      }

      const task = tasksById.get(block.taskId);
      if (task && task.plannedDate !== block.date) {
        context.addIssue({
          code: "custom",
          message: `时间块日期与任务日期不一致：${block.id}`,
          path: ["timeBlocks", index, "date"],
        });
      }
    }
  });

export type PlannerBackup = z.infer<typeof plannerBackupSchema>;

export async function createPlannerBackup(
  store: PlannerArchiveStore,
  exportedAt = new Date().toISOString(),
): Promise<PlannerBackup> {
  return store.transaction(async () => {
    const [tasks, timeBlocks, preferences] = await Promise.all([
      store.listAllTasks(),
      store.listAllTimeBlocks(),
      store.getPreferences(),
    ]);

    return plannerBackupSchema.parse({
      format: "newday-backup",
      version: 1,
      exportedAt,
      preferences,
      tasks,
      timeBlocks,
    });
  });
}

export function parsePlannerBackup(source: string): PlannerBackup {
  let candidate: unknown;

  try {
    candidate = JSON.parse(source);
  } catch {
    throw new Error("无法解析备份文件：文件不是有效的 JSON");
  }

  const result = plannerBackupSchema.safeParse(candidate);

  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "备份文件格式无效");
  }

  return result.data;
}

export async function restorePlannerBackup(
  store: PlannerArchiveStore,
  source: string,
): Promise<PlannerBackup> {
  const backup = parsePlannerBackup(source);
  await store.replaceAllData({
    tasks: backup.tasks,
    timeBlocks: backup.timeBlocks,
    preferences: backup.preferences,
  });
  return backup;
}
