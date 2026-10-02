import { z } from "zod";
import { applyCaptureRequestSchema, createCaptureRequestSchema } from "@newday/core/contracts/task-capture";

export const CAPTURE_SESSION_KEY = "newday.task-capture.session.v1";
const editSchema = z.strictObject({
  draftId: z.string(), selected: z.boolean(), title: z.string().max(200), notes: z.string().max(10000),
  startDate: z.string().max(10), endDate: z.string().max(10),
});
const sessionSchema = z.strictObject({
  mode: z.enum(["direct", "transcript"]), text: z.string().max(20000),
  request: createCaptureRequestSchema.nullable(), captureId: z.string().nullable(),
  edits: z.array(editSchema).max(20), pendingApply: applyCaptureRequestSchema.nullable(),
  notifiedOperationId: z.string().nullable(),
});
export type CaptureEdit = z.infer<typeof editSchema>;
export type CaptureSession = z.infer<typeof sessionSchema>;
export type CaptureSessionStore = { load(): CaptureSession | null; save(value: CaptureSession): void };

/** Same-tab recovery keeps the exact authorized input and apply body. Server
 * responses remain the only source of execution receipts. */
export const browserCaptureSessionStore: CaptureSessionStore = {
  load() {
    try {
      const raw = window.sessionStorage.getItem(CAPTURE_SESSION_KEY);
      return raw ? sessionSchema.parse(JSON.parse(raw)) : null;
    } catch { return null; }
  },
  save(value) { window.sessionStorage.setItem(CAPTURE_SESSION_KEY, JSON.stringify(value)); },
};
