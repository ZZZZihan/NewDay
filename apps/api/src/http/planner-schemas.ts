import { z } from "zod";
import {
  instantSchema,
  localDateSchema,
  recurrenceEndSchema,
  recurrencePatternSchema,
  recurrenceSeriesSchema,
  taskSchema,
} from "@newday/core/domain/planner-model";
import type { PlannerCommand } from "@newday/core/application/planner-command";

const identifier = z.string().min(1).max(512);
const title = z.string().trim().min(1).max(200);
const notes = z.string().max(10_000);
const now = instantSchema;
const details = { title: title.optional(), notes: notes.optional() };
const taskId = identifier;
const seriesId = identifier;

const hasDetails = (input: { title?: string; notes?: string }) =>
  input.title !== undefined || input.notes !== undefined;

export const stopImpactSchema = z.strictObject({
  openOrdinaryTaskCount: z.number().int().nonnegative(),
  focusRecordCount: z.number().int().nonnegative(),
  preservedTaskCount: z.number().int().nonnegative(),
  successorSegmentCount: z.number().int().nonnegative(),
  revision: z.string().min(1).max(1_000_000),
});

const materializationSchema = z.strictObject({
  asOfDate: localDateSchema,
  throughDate: localDateSchema,
  additionallyEnsureDate: localDateSchema.optional(),
}).refine((value) => {
  const days = (Date.parse(value.throughDate) - Date.parse(value.asOfDate)) / 86_400_000;
  return days >= 0 && days <= 366;
}, "单次重复任务生成范围必须在 366 天以内");

const commandSchema: z.ZodType<PlannerCommand> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("createTask"), input: z.strictObject({
    id: identifier, title, notes: notes.optional(), startDate: localDateSchema, endDate: localDateSchema, now,
    notionWorkspaceId: identifier.optional(),
  }) }),
  z.strictObject({ type: z.literal("updateTask"), input: z.strictObject({
    taskId, ...details, startDate: localDateSchema.optional(), endDate: localDateSchema.optional(), now,
  }).refine((input) => hasDetails(input) || input.startDate !== undefined || input.endDate !== undefined, "至少提供一项任务修改") }),
  z.strictObject({ type: z.literal("updateTaskDetails"), input: z.strictObject({
    taskId, ...details, now,
  }).refine(hasDetails, "至少提供标题或备注") }),
  z.strictObject({ type: z.literal("rescheduleTask"), input: z.strictObject({
    taskId, startDate: localDateSchema, endDate: localDateSchema, now,
  }) }),
  z.strictObject({ type: z.literal("completeTask"), input: z.strictObject({
    taskId, now, completedOn: localDateSchema.optional(), asOfDate: localDateSchema.optional(),
  }) }),
  z.strictObject({ type: z.literal("reopenTask"), input: z.strictObject({
    taskId, now, completedOn: localDateSchema.optional(), asOfDate: localDateSchema.optional(),
  }) }),
  z.strictObject({ type: z.literal("deleteTask"), input: z.strictObject({ taskId, now: now.optional() }) }),
  z.strictObject({ type: z.literal("setTodayFocus"), input: z.strictObject({ taskId, date: localDateSchema, now }) }),
  z.strictObject({ type: z.literal("removeTodayFocus"), input: z.strictObject({ taskId, date: localDateSchema }) }),
  z.strictObject({ type: z.literal("createRecurrenceSeries"), input: z.strictObject({
    id: identifier, title, notes: notes.optional(), startDate: localDateSchema,
    pattern: recurrencePatternSchema, end: recurrenceEndSchema,
    excludedDates: z.array(localDateSchema).max(10_000).optional(), now,
  }) }),
  z.strictObject({ type: z.literal("createRecurrenceSeriesFromTask"), input: z.strictObject({
    taskId, seriesId, ...details, occurrenceDate: localDateSchema.optional(),
    pattern: recurrencePatternSchema, end: recurrenceEndSchema, now,
  }) }),
  z.strictObject({ type: z.literal("updateRecurrenceSeries"), input: z.strictObject({
    seriesId, newSeriesId: identifier, ...details, pattern: recurrencePatternSchema.optional(),
    end: recurrenceEndSchema.optional(), effectiveDate: localDateSchema.optional(),
    materialization: materializationSchema, now,
  }).refine((input) => hasDetails(input) || input.pattern !== undefined || input.end !== undefined, "至少提供一项重复规则修改") }),
  z.strictObject({ type: z.literal("stopRecurrenceSeries"), input: z.strictObject({
    seriesId, endDate: localDateSchema, expectedImpact: stopImpactSchema.optional(), now,
  }) }),
]);

export const commandRequestSchema = z.strictObject({
  commands: z.array(commandSchema).min(1).max(100),
  expectedTask: taskSchema.optional(),
  expectedSeries: recurrenceSeriesSchema.optional(),
});
export const dayQuerySchema = z.strictObject({ selectedDate: localDateSchema, asOfDate: localDateSchema });
export const seriesParamsSchema = z.strictObject({ id: identifier });
export const stopPreviewSchema = z.strictObject({ seriesId, endDate: localDateSchema });
export const backupRequestSchema = z.strictObject({ source: z.string().min(1).max(10_000_000) });
export const undoRequestSchema = z.strictObject({ receipt: z.strictObject({ token: z.uuid() }) });
export const clientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "缺少有效的浏览器客户端标识");
