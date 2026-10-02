import { z } from "zod";
import { captureRunSchema, type ApplyCaptureRequest, type CreateCaptureRequest } from "@newday/core/contracts/task-capture";
import { HttpError, request } from "@/shared/http/request";

const statusSchema = z.strictObject({ configured: z.boolean(), modelId: z.string().nullable() });
async function read<T>(path: string, schema: { parse(value: unknown): T }, options?: RequestInit): Promise<T> {
  const value = await request<unknown>(`/api/agent/captures${path}`, options);
  try { return schema.parse(value); }
  catch { throw new HttpError("无法确认待办提取结果，请查询原请求。", "RESULT_UNKNOWN", 0, true); }
}
const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
export const taskCaptureApi = {
  status: () => read("/status", statusSchema),
  create: (body: CreateCaptureRequest) => read("", captureRunSchema, json(body)),
  run: (id: string) => read(`/${encodeURIComponent(id)}`, captureRunSchema),
  apply: (id: string, body: ApplyCaptureRequest) => read(`/${encodeURIComponent(id)}/apply`, captureRunSchema, json(body)),
  cancel: (id: string) => read(`/${encodeURIComponent(id)}/cancel`, captureRunSchema, json({})),
};
export type TaskCaptureApi = typeof taskCaptureApi;
