import { z } from "zod";

import { shiftDate } from "../domain/planner-date";
import { recursOnDate } from "../domain/planner-recurrence";
import {
  inboxItemSchema, lifeFolderSchema, lifeResourceSchema, resourceTaskLinkSchema,
} from "../domain/life-model";
import {
  focusRecordSchema,
  instantSchema,
  localDateSchema,
  recurrenceEndSchema,
  recurrencePatternSchema,
  recurrenceSeriesSchema,
  taskSchema,
  type FocusRecord,
  type LocalDate,
  type Task,
} from "../domain/planner-model";
import { notionClientKey, notionSyncArchiveSchema } from "./notion-sync";

const versionFivePlannerBackupSchema = z.object({
  format: z.literal("newday-backup"),
  version: z.literal(5),
  exportedAt: instantSchema,
  tasks: z.array(taskSchema),
  recurrenceSeries: z.array(recurrenceSeriesSchema),
  focusRecords: z.array(focusRecordSchema),
  inboxItems: z.array(inboxItemSchema),
  folders: z.array(lifeFolderSchema),
  resources: z.array(lifeResourceSchema),
  resourceTaskLinks: z.array(resourceTaskLinkSchema),
});

const versionSixPlannerBackupSchema = versionFivePlannerBackupSchema.extend({
  version: z.literal(6),
  notionSync: notionSyncArchiveSchema,
}).strict();

export const plannerBackupSchema = z.discriminatedUnion("version", [
  versionFivePlannerBackupSchema,
  versionSixPlannerBackupSchema,
]);

const versionFourBackupSchema = versionFivePlannerBackupSchema.omit({
  inboxItems: true, folders: true, resources: true, resourceTaskLinks: true,
}).extend({ version: z.literal(4) });

const versionThreeTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10_000).default(""),
  startDate: localDateSchema,
  endDate: localDateSchema,
  status: z.enum(["open", "completed"]),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  completedAt: instantSchema.nullable(),
  completedOn: localDateSchema.nullable().default(null),
  seriesId: z.string().min(1).optional(),
  occurrenceDate: localDateSchema.optional(),
  occurrenceKey: z.string().min(1).optional(),
  isSeriesException: z.boolean().optional(),
});

const versionThreeRecurrenceSeriesSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10_000).default(""),
  startDate: localDateSchema,
  pattern: recurrencePatternSchema,
  end: recurrenceEndSchema,
  excludedDates: z.array(localDateSchema).default([]),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

const versionThreeBackupSchema = z.object({
  format: z.literal("newday-backup"),
  version: z.literal(3),
  exportedAt: instantSchema,
  tasks: z.array(versionThreeTaskSchema),
  recurrenceSeries: z.array(versionThreeRecurrenceSeriesSchema),
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

  if (version === 6 || version === 5) {
    return parseAndValidateCurrentBackup(candidate);
  }

  if (version === 4) {
    const backup = parseSchema(versionFourBackupSchema, candidate);
    return parseAndValidateCurrentBackup({ ...backup, version: 5, ...emptyLifeData() });
  }

  if (version === 3) {
    const backup = parseSchema(versionThreeBackupSchema, candidate);

    return parseAndValidateCurrentBackup({
      format: "newday-backup",
      version: 5,
      exportedAt: backup.exportedAt,
      tasks: backup.tasks.map(normalizeVersionThreeTask),
      recurrenceSeries: backup.recurrenceSeries.map((series) =>
        recurrenceSeriesSchema.parse({
          ...series,
          logicalSeriesId: series.id,
          effectiveEndDate: null,
        }),
      ),
      focusRecords: backup.focusRecords,
      ...emptyLifeData(),
    });
  }

  if (version === 2) {
    const backup = parseSchema(versionTwoBackupSchema, candidate);

    return parseAndValidateCurrentBackup({
      format: "newday-backup",
      version: 5,
      exportedAt: backup.exportedAt,
      tasks: backup.tasks.map(normalizeVersionTwoTask),
      recurrenceSeries: [],
      focusRecords: [],
      ...emptyLifeData(),
    });
  }

  if (version === 1) {
    const backup = parseSchema(legacyPlannerBackupSchema, candidate);

    return parseAndValidateCurrentBackup({
      format: "newday-backup",
      version: 5,
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
      ...emptyLifeData(),
    });
  }

  throw new Error("备份版本不受支持");
}

function normalizeVersionThreeTask(
  task: z.infer<typeof versionThreeTaskSchema>,
): Task {
  return taskSchema.parse({
    ...task,
    logicalSeriesId: task.seriesId,
  });
}

function normalizeVersionTwoTask(
  task: z.infer<typeof versionTwoTaskSchema>,
): Task {
  return taskSchema.parse({
    ...task,
    completedOn: null,
  });
}

function emptyLifeData() {
  return { inboxItems: [], folders: [], resources: [], resourceTaskLinks: [] };
}

export function parseAndValidateCurrentBackup(candidate: unknown): PlannerBackup {
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
  assertUnique(backup.inboxItems, (item) => item.id, "收集箱条目 ID");
  assertUnique(backup.folders, (folder) => folder.id, "文件夹 ID");
  assertUnique(backup.resources, (resource) => resource.id, "资料 ID");
  assertUnique(backup.resourceTaskLinks, (link) => JSON.stringify([link.resourceId, link.taskId]), "任务资料关联");

  const folderById = new Map(backup.folders.map((folder) => [folder.id, folder]));
  const siblingNames = new Set<string>();
  for (const folder of backup.folders) {
    if (folder.parentId !== null) {
      const parent = folderById.get(folder.parentId);
      if (!parent) throw new Error(`文件夹引用了不存在的上级目录：${folder.id}`);
      if (parent.parentId !== null) throw new Error(`文件夹超过两级：${folder.id}`);
    }
    const siblingKey = JSON.stringify([folder.parentId, folder.name.toLocaleLowerCase()]);
    if (siblingNames.has(siblingKey)) throw new Error(`同级文件夹名称重复：${folder.name}`);
    siblingNames.add(siblingKey);
  }
  const resourceIds = new Set(backup.resources.map((resource) => resource.id));
  const taskIds = new Set(backup.tasks.map((task) => task.id));
  const linkedTaskIds = new Set(backup.version === 6
    ? backup.notionSync.taskMappings.map((mapping) => mapping.localTaskId) : []);
  for (const task of backup.tasks) {
    if (task.startDate === null && !linkedTaskIds.has(task.id)) {
      throw new Error(`未关联 Notion 的任务必须有计划日期：${task.id}`);
    }
    if (task.archived && !linkedTaskIds.has(task.id)) {
      throw new Error(`未关联 Notion 的任务不能标记为远端归档：${task.id}`);
    }
  }
  for (const item of backup.inboxItems) {
    if (item.sourceResourceId !== null && !resourceIds.has(item.sourceResourceId)) {
      throw new Error(`收集箱条目引用了不存在的资料：${item.id}`);
    }
  }
  for (const resource of backup.resources) {
    if (resource.folderId !== null && !folderById.has(resource.folderId)) {
      throw new Error(`资料引用了不存在的文件夹：${resource.id}`);
    }
  }
  for (const link of backup.resourceTaskLinks) {
    if (!resourceIds.has(link.resourceId) || !taskIds.has(link.taskId)) {
      throw new Error(`任务资料关联引用了不存在的记录：${link.resourceId}:${link.taskId}`);
    }
  }

  const occurrenceTasks = backup.tasks.filter(
    (
      task,
    ): task is Task & {
      occurrenceKey: string;
      seriesId: string;
      logicalSeriesId: string;
      occurrenceDate: LocalDate;
    } =>
      task.occurrenceKey !== undefined &&
      task.seriesId !== undefined &&
      task.logicalSeriesId !== undefined &&
      task.occurrenceDate !== undefined,
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
    const series = seriesById.get(task.seriesId);
    if (!series) {
      throw new Error(`重复任务引用了不存在的系列：${task.seriesId}`);
    }
    if (series.logicalSeriesId !== task.logicalSeriesId) {
      throw new Error(`重复任务逻辑系列不匹配：${task.id}`);
    }
    if (
      task.status === "open" &&
      task.isSeriesException === false &&
      !recursOnDate(series, task.occurrenceDate)
    ) {
      throw new Error(`普通重复任务不在规则段内：${task.id}`);
    }
  }

  const seriesByLogicalId = new Map<string, typeof backup.recurrenceSeries>();
  for (const series of backup.recurrenceSeries) {
    assertUniqueStrings(series.excludedDates, `重复系列排除日期：${series.id}`);
    const chain = seriesByLogicalId.get(series.logicalSeriesId) ?? [];
    chain.push(series);
    seriesByLogicalId.set(series.logicalSeriesId, chain);
  }

  for (const [logicalSeriesId, unsortedChain] of seriesByLogicalId) {
    const chain = [...unsortedChain].sort((left, right) =>
      left.startDate.localeCompare(right.startDate) || left.id.localeCompare(right.id),
    );

    for (let index = 0; index < chain.length; index += 1) {
      const segment = chain[index];
      const successor = chain[index + 1];
      if (!successor) {
        if (segment.effectiveEndDate !== null) {
          throw new Error(`重复系列最后规则段必须持续有效：${logicalSeriesId}`);
        }
        continue;
      }

      if (segment.effectiveEndDate !== shiftDate(successor.startDate, -1)) {
        throw new Error(`重复系列规则段不连续：${logicalSeriesId}`);
      }
    }
  }

  const focusByDate = new Map<string, FocusRecord[]>();
  const focusKeys = new Set<string>();

  for (const record of backup.focusRecords) {
    const task = taskById.get(record.taskId);

    if (!task) {
      throw new Error(`重点记录引用了不存在的任务：${record.taskId}`);
    }

    if (task.status !== "open" || task.archived) {
      throw new Error(`已完成任务不能设为今日重点：${task.id}`);
    }

    const visible = task.startDate !== null && task.endDate !== null && (
      (task.startDate <= record.date && task.endDate >= record.date) ||
      task.endDate < record.date);
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

  if (backup.version === 6) validateNotionSyncBackup(backup);
}

function validateNotionSyncBackup(backup: Extract<PlannerBackup, { version: 6 }>) {
  const sync = backup.notionSync;
  const taskIds = new Set(backup.tasks.map((task) => task.id));
  assertUnique(sync.connections, (value) => value.workspaceId, "Notion 工作区 ID");
  assertUnique(sync.initializationSteps ?? [], (value) => JSON.stringify([value.workspaceId, value.step]), "Notion 初始化步骤");
  assertUnique(sync.taskMappings, (value) => value.localTaskId, "Notion 本地任务映射");
  assertUnique(sync.outbox, (value) => value.operationId, "Notion 待发送操作 ID");
  assertUnique(sync.conflicts, (value) => value.id, "Notion 冲突 ID");
  assertUnique(sync.watermarks, (value) => JSON.stringify([value.workspaceId, value.dataSourceId]), "Notion 扫描水位");
  assertUnique(sync.readNodes ?? [], (value) => JSON.stringify([value.workspaceId, value.dataSourceId, value.remotePageId]), "Notion 主线或项目缓存");
  assertUnique(sync.readTaskContexts ?? [], (value) => value.localTaskId, "Notion 任务归属缓存");
  assertUnique(sync.restoreQuarantine, (value) => JSON.stringify([value.operation.datasetEpoch, value.operation.operationId]), "Notion 恢复隔离操作");

  const connections = new Map(sync.connections.map((value) => [value.workspaceId, value]));
  for (const step of sync.initializationSteps ?? []) {
    const connection = connections.get(step.workspaceId);
    if (!connection) {
      throw new Error(`Notion 初始化步骤引用了不存在的工作区：${step.workspaceId}`);
    }
    if (step.status !== "confirmed") continue;
    const table = ["areas", "projects", "tasks", "rules"].includes(step.step)
      ? step.step as keyof typeof connection.dataSources : null;
    const relationSources: Record<string, readonly ["projects" | "tasks", string]> = {
      projects_area: ["projects", "Area"], tasks_project: ["tasks", "Project"],
      tasks_direct_area: ["tasks", "Direct Area"], tasks_rule: ["tasks", "Rule"],
    };
    const relation = relationSources[step.step];
    const boundId = step.step === "root" ? connection.rootPageId
      : table ? connection.dataSources[table]?.databaseId
        : relation ? connection.dataSources[relation[0]]?.propertyIds[relation[1]] : null;
    if (step.remoteId !== boundId) {
      throw new Error(`Notion 初始化步骤与工作区结构不一致：${step.step}`);
    }
  }
  const mappings = new Map(sync.taskMappings.map((value) => [value.localTaskId, value]));
  const remoteKeys = new Set<string>();
  const clientKeys = new Set<string>();
  for (const mapping of sync.taskMappings) {
    const connection = connections.get(mapping.workspaceId);
    if (!connection || !taskIds.has(mapping.localTaskId)) {
      throw new Error(`Notion 映射引用了不存在的任务或工作区：${mapping.localTaskId}`);
    }
    if (mapping.clientKey !== notionClientKey(connection.installationId, mapping.localTaskId)) {
      throw new Error(`Notion 映射客户端键不匹配：${mapping.localTaskId}`);
    }
    const clientKey = JSON.stringify([mapping.workspaceId, mapping.clientKey]);
    if (clientKeys.has(clientKey)) throw new Error(`Notion 客户端键重复：${mapping.clientKey}`);
    clientKeys.add(clientKey);
    if (mapping.remotePageId !== null) {
      const remoteKey = JSON.stringify([mapping.workspaceId, mapping.dataSourceId, mapping.remotePageId]);
      if (remoteKeys.has(remoteKey)) throw new Error(`Notion 远端映射重复：${mapping.remotePageId}`);
      remoteKeys.add(remoteKey);
    }
  }
  for (const operation of sync.outbox) {
    const mapping = mappings.get(operation.localTaskId);
    if (!mapping || mapping.workspaceId !== operation.workspaceId) {
      throw new Error(`Notion 操作引用了不存在的映射：${operation.operationId}`);
    }
  }
  for (const conflict of sync.conflicts) {
    const mapping = mappings.get(conflict.localTaskId);
    if (!mapping || mapping.workspaceId !== conflict.workspaceId) {
      throw new Error(`Notion 冲突引用了不存在的映射：${conflict.id}`);
    }
  }
  for (const watermark of sync.watermarks) {
    if (!connections.has(watermark.workspaceId)) {
      throw new Error(`Notion 水位引用了不存在的工作区：${watermark.workspaceId}`);
    }
  }
  for (const node of sync.readNodes ?? []) {
    const connection = connections.get(node.workspaceId);
    const expected = connection?.dataSources[node.kind === "area" ? "areas" : "projects"]?.dataSourceId;
    if (!expected || expected !== node.dataSourceId) {
      throw new Error(`Notion 主线或项目缓存命名空间不匹配：${node.remotePageId}`);
    }
  }
  for (const context of sync.readTaskContexts ?? []) {
    const mapping = mappings.get(context.localTaskId);
    if (!mapping || mapping.workspaceId !== context.workspaceId || mapping.remotePageId !== context.remotePageId) {
      throw new Error(`Notion 任务归属缓存与映射不匹配：${context.localTaskId}`);
    }
  }
  for (const quarantined of sync.restoreQuarantine) {
    if (quarantined.operation.localTaskId !== quarantined.mapping.localTaskId ||
      quarantined.operation.workspaceId !== quarantined.mapping.workspaceId) {
      throw new Error(`Notion 恢复隔离操作与原映射不匹配：${quarantined.operation.operationId}`);
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
