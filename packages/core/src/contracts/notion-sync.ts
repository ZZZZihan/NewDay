import { z } from "zod";

import { localDateSchema } from "../domain/planner-model";

/** A date range is one shared field. Both ends are absent or both are dates. */
export const notionPlanDateSchema = z.tuple([localDateSchema, localDateSchema]).nullable()
  .superRefine((value, context) => {
    if (value !== null && value[1] < value[0]) {
      context.addIssue({ code: "custom", message: "计划结束日期不能早于开始日期" });
    }
  });

export const notionTaskFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  date: notionPlanDateSchema,
  completed: z.boolean(),
}).strict();

export type NotionTaskFields = z.infer<typeof notionTaskFieldsSchema>;
export type NotionSharedField = keyof NotionTaskFields;

const nonEmptyId = z.string().min(1);

export const notionDataSourceRefSchema = z.object({
  databaseId: nonEmptyId,
  dataSourceId: nonEmptyId,
  propertyIds: z.record(z.string(), nonEmptyId),
  schemaFingerprint: nonEmptyId,
}).strict();

export const notionConnectionSchema = z.object({
  workspaceId: nonEmptyId,
  installationId: nonEmptyId,
  rootPageId: nonEmptyId.nullable(),
  dataSources: z.object({
    areas: notionDataSourceRefSchema.optional(),
    projects: notionDataSourceRefSchema.optional(),
    tasks: notionDataSourceRefSchema.optional(),
    rules: notionDataSourceRefSchema.optional(),
  }).strict(),
  status: z.enum(["disconnected", "active", "paused", "paused_after_restore", "paused_unknown"]),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type NotionConnection = z.infer<typeof notionConnectionSchema>;

export const notionTaskMappingSchema = z.object({
  localTaskId: nonEmptyId,
  workspaceId: nonEmptyId,
  dataSourceId: nonEmptyId,
  remotePageId: nonEmptyId.nullable(),
  clientKey: nonEmptyId,
  baseline: notionTaskFieldsSchema.nullable(),
  status: z.enum(["pending_create", "active", "needs_review", "archived"]),
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((mapping, context) => {
  if (mapping.status === "active" && (mapping.remotePageId === null || mapping.baseline === null)) {
    context.addIssue({ code: "custom", message: "已关联任务必须有远端页面和已确认共同基准" });
  }
});
export type NotionTaskMapping = z.infer<typeof notionTaskMappingSchema>;

export const notionOutboxOperationSchema = z.object({
  operationId: nonEmptyId,
  localTaskId: nonEmptyId,
  workspaceId: nonEmptyId,
  datasetEpoch: nonEmptyId,
  desired: notionTaskFieldsSchema,
  baseline: notionTaskFieldsSchema.nullable(),
  status: z.enum(["pending", "sending", "unknown", "confirmed", "superseded", "quarantined"]),
  attemptCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
  confirmedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export type NotionOutboxOperation = z.infer<typeof notionOutboxOperationSchema>;

export const notionConflictRecordSchema = z.object({
  id: nonEmptyId,
  localTaskId: nonEmptyId,
  workspaceId: nonEmptyId,
  field: z.enum(["title", "date", "completed"]),
  baseline: z.unknown(),
  local: z.unknown(),
  remote: z.unknown(),
  winner: z.literal("notion"),
  recordedAt: z.string().datetime({ offset: true }),
}).strict();
export type NotionConflictRecord = z.infer<typeof notionConflictRecordSchema>;

export const notionScanWatermarkSchema = z.object({
  workspaceId: nonEmptyId,
  dataSourceId: nonEmptyId,
  completedThrough: z.string().datetime({ offset: true }).nullable(),
  lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
  lastSuccessAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export type NotionScanWatermark = z.infer<typeof notionScanWatermarkSchema>;

export const notionRestoreQuarantineSchema = z.object({
  operation: notionOutboxOperationSchema,
  mapping: notionTaskMappingSchema,
  quarantinedAt: z.string().datetime({ offset: true }),
}).strict();
export type NotionRestoreQuarantine = z.infer<typeof notionRestoreQuarantineSchema>;

export const notionSyncArchiveSchema = z.object({
  version: z.literal(1),
  connections: z.array(notionConnectionSchema),
  taskMappings: z.array(notionTaskMappingSchema),
  outbox: z.array(notionOutboxOperationSchema),
  conflicts: z.array(notionConflictRecordSchema),
  watermarks: z.array(notionScanWatermarkSchema),
  restoreQuarantine: z.array(notionRestoreQuarantineSchema),
}).strict();
export type NotionSyncArchive = z.infer<typeof notionSyncArchiveSchema>;

export function emptyNotionSyncArchive(): NotionSyncArchive {
  return { version: 1, connections: [], taskMappings: [], outbox: [], conflicts: [], watermarks: [], restoreQuarantine: [] };
}

/** The rich-text key is stable across retries and a restored installation. */
export function notionClientKey(installationId: string, localTaskId: string) {
  if (!installationId || !localTaskId) throw new Error("Notion client key requires installation and task IDs");
  return `newday:${installationId}:${localTaskId}`;
}

export type NotionFieldConflict = {
  field: NotionSharedField;
  baseline: NotionTaskFields[NotionSharedField];
  local: NotionTaskFields[NotionSharedField];
  remote: NotionTaskFields[NotionSharedField];
  winner: "notion";
};
