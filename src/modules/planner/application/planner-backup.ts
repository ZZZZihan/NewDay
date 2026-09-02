import { z } from "zod";

import {
  focusRecordSchema,
  instantSchema,
  localDateSchema,
  recurrenceSeriesSchema,
  taskSchema,
  type FocusRecord,
  type Task,
} from "../domain/planner-model";
import type { PlannerArchiveStore } from "./planner-archive-store";
import { clearUndoReceipts } from "./planner-undo";

export const plannerBackupSchema = z.object({
  format: z.literal("newday-backup"),
  version: z.literal(3),
  exportedAt: instantSchema,
  tasks: z.array(taskSchema),
  recurrenceSeries: z.array(recurrenceSeriesSchema),
  focusRecords: z.array(focusRecordSchema),
});

const versionTwoTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10_000).default(""),
  startDate: localDateSchema,
  endDate: localDateSchema,
  status: z.enum(["open", "completed"]),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  completedAt: instantSchema.nullable(),
});

const versionTwoBackupSchema = z.object({
  format: z.literal("newday-backup"),
  version: z.literal(2),
  exportedAt: instantSchema,
  tasks: z.array(versionTwoTaskSchema),
});

const legacyTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10_000).default(""),
  plannedDate: localDateSchema,
  status: z.enum(["open", "completed"]),
  estimatedMinutes: z.number().int().positive().nullable().optional(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  completedAt: instantSchema.nullable(),
});

const legacyPlannerBackupSchema = z.object({
  format: z.literal("newday-backup"),
  version: z.literal(1),
  exportedAt: instantSchema,
  tasks: z.array(legacyTaskSchema),
  timeBlocks: z.array(z.unknown()).default([]),
  preferences: z.unknown().optional(),
});

export type PlannerBackup = z.infer<typeof plannerBackupSchema>;

export async function createPlannerBackup(
  store: PlannerArchiveStore,
  exportedAt = new Date().toISOString(),
): Promise<PlannerBackup> {
  return store.transaction(async () => {
    const [tasks, recurrenceSeries, focusRecords] = await Promise.all([
      store.listAllTasks(),
      store.listAllRecurrenceSeries(),
      store.listAllFocusRecords(),
    ]);

    return parseAndValidateCurrentBackup({
      format: "newday-backup",
      version: 3,
      exportedAt,
      tasks,
      recurrenceSeries,
      focusRecords,
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

  if (!candidate || typeof candidate !== "object") {
    throw new Error("备份文件格式无效");
  }

  const version = Reflect.get(candidate, "version");

  if (version === 3) {
    return parseAndValidateCurrentBackup(candidate);
  }

  if (version === 2) {
    const backup = parseSchema(versionTwoBackupSchema, candidate);

    return parseAndValidateCurrentBackup({
      format: "newday-backup",
      version: 3,
      exportedAt: backup.exportedAt,
      tasks: backup.tasks.map(normalizeVersionTwoTask),
      recurrenceSeries: [],
      focusRecords: [],
    });
  }

  if (version === 1) {
    const backup = parseSchema(legacyPlannerBackupSchema, candidate);

    return parseAndValidateCurrentBackup({
      format: "newday-backup",
      version: 3,
      exportedAt: backup.exportedAt,
      tasks: backup.tasks.map((task) =>
        taskSchema.parse({
          id: task.id,
          title: task.title,
          notes: task.notes,
          startDate: task.plannedDate,
          endDate: task.plannedDate,
          status: task.status,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          completedAt: task.completedAt,
          completedOn: null,
        }),
      ),
      recurrenceSeries: [],
      focusRecords: [],
    });
  }

  throw new Error("备份版本不受支持");
}

export async function restorePlannerBackup(
  store: PlannerArchiveStore,
  source: string,
): Promise<PlannerBackup> {
  const backup = parsePlannerBackup(source);
  await store.replaceAllData({
    tasks: backup.tasks,
    recurrenceSeries: backup.recurrenceSeries,
    focusRecords: backup.focusRecords,
  });
  clearUndoReceipts(store);
  return backup;
}

function normalizeVersionTwoTask(
  task: z.infer<typeof versionTwoTaskSchema>,
): Task {
  return taskSchema.parse({
    ...task,
    completedOn: null,
  });
}

function parseAndValidateCurrentBackup(candidate: unknown): PlannerBackup {
  const backup = parseSchema(plannerBackupSchema, candidate);
  validatePlannerBackup(backup);
  return backup;
}

function parseSchema<T>(schema: z.ZodType<T>, candidate: unknown): T {
  const result = schema.safeParse(candidate);

  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "备份文件格式无效");
  }

  return result.data;
}

function validatePlannerBackup(backup: PlannerBackup) {
  assertUnique(backup.tasks, (task) => task.id, "任务 ID");
  assertUnique(backup.recurrenceSeries, (series) => series.id, "重复系列 ID");
  assertUnique(backup.focusRecords, (record) => record.id, "重点记录 ID");

  const occurrenceTasks = backup.tasks.filter(
    (task): task is Task & { occurrenceKey: string; seriesId: string } =>
      task.occurrenceKey !== undefined && task.seriesId !== undefined,
  );
  assertUnique(
    occurrenceTasks,
    (task) => task.occurrenceKey,
    "重复任务实例键",
  );

  const seriesById = new Map(
    backup.recurrenceSeries.map((series) => [series.id, series]),
  );
  const taskById = new Map(backup.tasks.map((task) => [task.id, task]));

  for (const task of occurrenceTasks) {
    if (!seriesById.has(task.seriesId)) {
      throw new Error(`重复任务引用了不存在的系列：${task.seriesId}`);
    }
  }

  for (const series of backup.recurrenceSeries) {
    assertUniqueStrings(series.excludedDates, `重复系列排除日期：${series.id}`);
  }

  const focusByDate = new Map<string, FocusRecord[]>();
  const focusKeys = new Set<string>();

  for (const record of backup.focusRecords) {
    const task = taskById.get(record.taskId);

    if (!task) {
      throw new Error(`重点记录引用了不存在的任务：${record.taskId}`);
    }

    if (task.status !== "open") {
      throw new Error(`已完成任务不能设为今日重点：${task.id}`);
    }

    const visible =
      (task.startDate <= record.date && task.endDate >= record.date) ||
      task.endDate < record.date;
    if (!visible) {
      throw new Error(`重点任务在对应日期不可见：${task.id}`);
    }

    const focusKey = `${record.date}:${record.taskId}`;
    if (focusKeys.has(focusKey)) {
      throw new Error(`任务在该日期重复设为重点：${record.taskId}`);
    }
    focusKeys.add(focusKey);

    const records = focusByDate.get(record.date) ?? [];
    records.push(record);
    focusByDate.set(record.date, records);
  }

  for (const [date, records] of focusByDate) {
    if (records.length > 3) {
      throw new Error(`每日重点不能超过 3 项：${date}`);
    }
  }
}

function assertUnique<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
) {
  const keys = new Set<string>();

  for (const value of values) {
    const key = keyOf(value);
    if (keys.has(key)) {
      throw new Error(`${label} 重复：${key}`);
    }
    keys.add(key);
  }
}

function assertUniqueStrings(values: readonly string[], label: string) {
  const keys = new Set(values);

  if (keys.size !== values.length) {
    throw new Error(`${label}包含重复值`);
  }
}
