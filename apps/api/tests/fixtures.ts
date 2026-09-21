import type { PlannerCommand } from "@newday/core/application/planner-command";
import type { PlannerBackup } from "@newday/core/application/planner-backup";
import type { Task } from "@newday/core/domain/planner-model";

export const today = "2026-09-08";
export const now = "2026-09-08T08:00:00.000Z";

export function task(id = "task-1", overrides: Partial<Task> = {}): Task {
  return {
    id, title: "整理项目", notes: "", startDate: today, endDate: today,
    status: "open", completedAt: null, completedOn: null, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

export function createTask(id = "task-1"): PlannerCommand {
  return { type: "createTask", input: { id, title: "整理项目", startDate: today, endDate: today, now } };
}

export function backup(tasks: Task[] = [task()]): PlannerBackup {
  return { format: "newday-backup", version: 4, exportedAt: now, tasks, recurrenceSeries: [], focusRecords: [] };
}
