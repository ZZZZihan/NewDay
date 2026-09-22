import { z } from "zod";
import { instantSchema, localDateSchema } from "../domain/planner-model";

export const CAPTURE_SCHEMA_VERSION = "task-capture-v1";
export const CAPTURE_NAMESPACES = { runs: "task-capture-runs-v1", operations: "task-capture-operations-v1" } as const;
const id = z.string().min(1).max(200);

export const createCaptureRequestSchema = z.strictObject({
  requestId: id,
  mode: z.enum(["direct", "transcript"]),
  text: z.string().trim().min(1).max(20_000),
});
export type CreateCaptureRequest = z.infer<typeof createCaptureRequestSchema>;

/** The model proposes data only; identifiers and execution authority are server owned. */
export const captureModelDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(8_000),
  startDate: localDateSchema.nullable(),
  endDate: localDateSchema.nullable(),
  sourceText: z.string().min(1).max(2_000),
  needsReview: z.boolean(),
});
export const captureModelOutputSchema = z.strictObject({
  drafts: z.array(captureModelDraftSchema).max(20),
  message: z.string().max(2_000),
});
export type CaptureModelOutput = z.infer<typeof captureModelOutputSchema>;
export const captureDraftSchema = captureModelDraftSchema.extend({ id });
export type CaptureDraft = z.infer<typeof captureDraftSchema>;

export const captureTaskInputSchema = z.strictObject({
  draftId: id,
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10_000),
  startDate: localDateSchema,
  endDate: localDateSchema,
}).refine((item) => item.startDate <= item.endDate, { message: "结束日期不能早于开始日期" });
export const applyCaptureRequestSchema = z.strictObject({
  operationId: id,
  tasks: z.array(captureTaskInputSchema).min(1).max(20),
}).refine((request) => new Set(request.tasks.map((task) => task.draftId)).size === request.tasks.length,
  { message: "同一条提取结果不能重复加入" });
export type ApplyCaptureRequest = z.infer<typeof applyCaptureRequestSchema>;

export const captureReceiptSchema = z.strictObject({
  operationId: id,
  captureId: id,
  createdAt: instantSchema,
  tasks: z.array(z.strictObject({
    id, title: z.string(), notes: z.string(), startDate: localDateSchema, endDate: localDateSchema,
  })).min(1).max(20),
});
export type CaptureReceipt = z.infer<typeof captureReceiptSchema>;
export const captureRunSchema = z.strictObject({
  captureId: id,
  mode: z.enum(["direct", "transcript"]),
  status: z.enum(["running", "ready", "applied", "failed", "interrupted", "details_deleted"]),
  today: localDateSchema,
  timeZone: z.string(),
  datasetEpoch: z.string(),
  createdAt: instantSchema,
  drafts: z.array(captureDraftSchema).max(20),
  message: z.string(),
  receipt: captureReceiptSchema.nullable(),
  error: z.string().nullable(),
});
export type CaptureRun = z.infer<typeof captureRunSchema>;
export type CaptureModelInput = { text: string; mode: CreateCaptureRequest["mode"]; today: string; timeZone: string };
