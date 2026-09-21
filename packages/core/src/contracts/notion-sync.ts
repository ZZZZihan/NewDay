import { z } from "zod";

import { localDateSchema, recurrencePatternSchema } from "../domain/planner-model";

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
const notionPageUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && (url.hostname === "notion.so" || url.hostname.endsWith(".notion.so"));
}, "Notion 页面链接必须使用 notion.so 的 HTTPS 地址");

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
  pauseReason: z.enum(["preflight_read", "manual"]).optional(),
  retryAfterAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type NotionConnection = z.infer<typeof notionConnectionSchema>;

export const notionInitializationStepNameSchema = z.enum([
  "root", "areas", "projects", "tasks", "rules",
  "projects_area", "tasks_project", "tasks_direct_area", "tasks_rule",
]);
export type NotionInitializationStepName = z.infer<typeof notionInitializationStepNameSchema>;

/** A durable POST/PATCH intent. Once attempted, only readback can confirm it;
 * an ambiguous result never grants another automatic create request. */
export const notionInitializationStepSchema = z.object({
  workspaceId: nonEmptyId,
  step: notionInitializationStepNameSchema,
  expectedTitle: nonEmptyId,
  parentId: nonEmptyId.nullable(),
  schemaFingerprint: nonEmptyId,
  status: z.enum(["attempted", "needs_review", "confirmed"]),
  reviewReason: z.enum(["not_found", "ambiguous", "unreadable", "schema_mismatch", "permission", "rate_limited", "request_unknown"]).nullable(),
  retryAfterAt: z.string().datetime({ offset: true }).nullable().optional(),
  attemptedAt: z.string().datetime({ offset: true }),
  confirmedAt: z.string().datetime({ offset: true }).nullable(),
  remoteId: nonEmptyId.nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === "confirmed" && (!value.remoteId || !value.confirmedAt || value.reviewReason)) {
    context.addIssue({ code: "custom", message: "已确认的 Notion 初始化步骤必须有读回标识和时间" });
  }
  if (value.status !== "confirmed" && (value.remoteId !== null || value.confirmedAt !== null)) {
    context.addIssue({ code: "custom", message: "未确认的 Notion 初始化步骤不能绑定远端标识" });
  }
});
export type NotionInitializationStep = z.infer<typeof notionInitializationStepSchema>;

export const notionTaskMappingSchema = z.object({
  localTaskId: nonEmptyId,
  workspaceId: nonEmptyId,
  dataSourceId: nonEmptyId,
  remotePageId: nonEmptyId.nullable(),
  clientKey: nonEmptyId,
  rulePageId: nonEmptyId.optional(),
  occurrenceKey: nonEmptyId.optional(),
  baseline: notionTaskFieldsSchema.nullable(),
  status: z.enum(["pending_create", "active", "needs_review", "archived"]),
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((mapping, context) => {
  if (Boolean(mapping.rulePageId) !== Boolean(mapping.occurrenceKey)) {
    context.addIssue({ code: "custom", message: "Notion 实例必须同时绑定规则和发生键" });
  }
  if (mapping.status === "active" && (mapping.remotePageId === null || mapping.baseline === null)) {
    context.addIssue({ code: "custom", message: "已关联任务必须有远端页面和已确认共同基准" });
  }
});
export type NotionTaskMapping = z.infer<typeof notionTaskMappingSchema>;

export const notionRuleSourceSchema = z.object({
  title: z.string().trim().min(1).max(200),
  startDate: localDateSchema,
  endDate: localDateSchema.nullable(),
  pattern: recurrencePatternSchema,
  excludedDates: z.array(localDateSchema),
}).strict().superRefine((source, context) => {
  if (source.endDate !== null && source.endDate < source.startDate) {
    context.addIssue({ code: "custom", message: "Notion 规则结束日不能早于开始日" });
  }
  if (new Set(source.excludedDates).size !== source.excludedDates.length) {
    context.addIssue({ code: "custom", message: "Notion 规则排除日期不能重复" });
  }
});
export type NotionRuleSource = z.infer<typeof notionRuleSourceSchema>;

export const notionRuleMappingSchema = z.object({
  workspaceId: nonEmptyId,
  dataSourceId: nonEmptyId,
  remotePageId: nonEmptyId,
  logicalSeriesId: nonEmptyId,
  source: notionRuleSourceSchema,
  generationAfter: localDateSchema.optional(),
  generationReconcilePending: z.boolean().optional(),
  status: z.enum(["active", "archived"]),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type NotionRuleMapping = z.infer<typeof notionRuleMappingSchema>;

export function notionLogicalSeriesId(workspaceId: string, rulePageId: string): string {
  if (!workspaceId || !rulePageId) throw new Error("Notion rule identity is incomplete");
  return `notion:${workspaceId}:${rulePageId}`;
}

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
  // Runtime ownership distinguishes a live second API process from a crash.
  // Earlier v6 exports have no owner and remain valid imports.
  sendingOwner: z.object({ pid: z.number().int().positive(), instanceId: nonEmptyId }).strict().optional(),
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
  // Early v6 candidate exports omitted the decision; its only supported
  // conflict rule was already Notion-wins, so normalize on import.
  winner: z.literal("notion").default("notion"),
  recordedAt: z.string().datetime({ offset: true }),
}).strict();
export type NotionConflictRecord = z.infer<typeof notionConflictRecordSchema>;

export const notionScanWatermarkSchema = z.object({
  workspaceId: nonEmptyId,
  dataSourceId: nonEmptyId,
  completedThrough: z.string().datetime({ offset: true }).nullable(),
  lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
  lastSuccessAt: z.string().datetime({ offset: true }).nullable(),
  lastError: z.enum(["authorization", "permission", "rate_limited", "schema", "incomplete", "network", "remote", "local"]).nullable().optional(),
  lastErrorAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();
export type NotionScanWatermark = z.infer<typeof notionScanWatermarkSchema>;

/** Read cache is scoped to the exact workspace and data source. It is never
 * used to infer a remote mapping by name. */
export const notionReadNodeSchema = z.object({
  workspaceId: nonEmptyId,
  dataSourceId: nonEmptyId,
  remotePageId: nonEmptyId,
  kind: z.enum(["area", "project"]),
  title: z.string().trim().min(1).max(200),
  url: notionPageUrl,
  areaPageId: nonEmptyId.nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type NotionReadNode = z.infer<typeof notionReadNodeSchema>;

export const notionReadTaskContextSchema = z.object({
  localTaskId: nonEmptyId,
  workspaceId: nonEmptyId,
  remotePageId: nonEmptyId,
  url: notionPageUrl,
  projectPageId: nonEmptyId.nullable(),
  areaPageId: nonEmptyId.nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type NotionReadTaskContext = z.infer<typeof notionReadTaskContextSchema>;

export const notionRestoreReviewSchema = z.object({
  checkedAt: z.string().datetime({ offset: true }),
  outcome: z.enum(["matches_intent", "different", "not_observed", "incomplete", "ambiguous", "identity_mismatch", "unreadable", "trashed"]),
  remotePageId: nonEmptyId.nullable(),
  remoteFields: notionTaskFieldsSchema.nullable(),
}).strict().superRefine((review, context) => {
  if (["matches_intent", "different", "trashed"].includes(review.outcome) &&
    (!review.remotePageId || !review.remoteFields)) {
    context.addIssue({ code: "custom", message: "已读取的 Notion 恢复核对结果缺少远端页面或字段" });
  }
  if (review.outcome === "not_observed" && (review.remotePageId !== null || review.remoteFields !== null)) {
    context.addIssue({ code: "custom", message: "未观察到的 Notion 页面不能附带远端字段" });
  }
});
export type NotionRestoreReview = z.infer<typeof notionRestoreReviewSchema>;

export const notionRestoreQuarantineSchema = z.object({
  operation: notionOutboxOperationSchema,
  mapping: notionTaskMappingSchema,
  quarantinedAt: z.string().datetime({ offset: true }),
  // Older v6 backups have no source marker. The marker describes where the
  // quarantined record came from, not whether a remote write was confirmed.
  source: z.enum(["pre_restore_send", "imported_backup"]).optional(),
  // A read-only observation, never permission to replay or release the fence.
  latestReview: notionRestoreReviewSchema.optional(),
}).strict().superRefine((entry, context) => {
  if (entry.mapping.remotePageId !== null && entry.latestReview?.remotePageId &&
    ["matches_intent", "different", "trashed"].includes(entry.latestReview.outcome) &&
    entry.latestReview.remotePageId !== entry.mapping.remotePageId) {
    context.addIssue({ code: "custom", message: "Notion 恢复核对页面与原映射不一致" });
  }
  if (!entry.latestReview?.remoteFields || !["matches_intent", "different"].includes(entry.latestReview.outcome)) return;
  const remote = entry.latestReview.remoteFields;
  const desired = entry.operation.desired;
  const matches = remote.title === desired.title && remote.completed === desired.completed &&
    (remote.date === null || desired.date === null
      ? remote.date === desired.date
      : remote.date[0] === desired.date[0] && remote.date[1] === desired.date[1]);
  if (matches !== (entry.latestReview.outcome === "matches_intent")) {
    context.addIssue({ code: "custom", message: "Notion 恢复核对结果与原意图不一致" });
  }
});
export type NotionRestoreQuarantine = z.infer<typeof notionRestoreQuarantineSchema>;

export const notionSyncArchiveSchema = z.object({
  version: z.literal(1),
  connections: z.array(notionConnectionSchema),
  initializationSteps: z.array(notionInitializationStepSchema).optional(),
  taskMappings: z.array(notionTaskMappingSchema),
  ruleMappings: z.array(notionRuleMappingSchema).optional(),
  outbox: z.array(notionOutboxOperationSchema),
  conflicts: z.array(notionConflictRecordSchema),
  watermarks: z.array(notionScanWatermarkSchema),
  readNodes: z.array(notionReadNodeSchema).optional(),
  readTaskContexts: z.array(notionReadTaskContextSchema).optional(),
  restoreQuarantine: z.array(notionRestoreQuarantineSchema),
}).strict();
export type NotionSyncArchive = z.infer<typeof notionSyncArchiveSchema>;

export function emptyNotionSyncArchive(): NotionSyncArchive {
  return { version: 1, connections: [], initializationSteps: [], taskMappings: [], ruleMappings: [], outbox: [], conflicts: [], watermarks: [], readNodes: [], readTaskContexts: [], restoreQuarantine: [] };
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
