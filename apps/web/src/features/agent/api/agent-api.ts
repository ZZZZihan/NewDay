import {
  agentPreferencesSchema, agentRunResponseSchema, agentStatusSchema,
  applyProposalResponseSchema, operationResultSchema, planningFeedbackSchema,
  planningHistoryResponseSchema, todayContextResponseSchema,
  type AnswerRunRequest, type ApplyProposalRequest, type CreateRunRequest,
  type FeedbackRequest, type UpdateContextRequest, type UpdatePreferencesRequest,
} from "@newday/core/contracts/agent-planning";
import { HttpError, request } from "@/shared/http/request";

async function read<T>(path: string, schema: { parse(value: unknown): T }, options?: RequestInit): Promise<T> {
  const body = await request<unknown>(`/api/agent${path}`, options);
  try { return schema.parse(body); }
  catch { throw new HttpError("规划服务返回了无法确认的结果，请重新查询", "RESULT_UNKNOWN", 0, true); }
}
const json = (body: unknown, method = "POST"): RequestInit => ({ method, body: JSON.stringify(body) });
const encoded = encodeURIComponent;

export const agentApi = {
  status: () => read("/status", agentStatusSchema),
  preferences: () => read("/preferences", agentPreferencesSchema),
  savePreferences: (body: UpdatePreferencesRequest) => read("/preferences", agentPreferencesSchema, json(body, "PUT")),
  context: () => read("/context/today", todayContextResponseSchema),
  saveContext: (body: UpdateContextRequest) => read("/context/today", todayContextResponseSchema, json(body, "PUT")),
  createRun: (body: CreateRunRequest) => read("/runs", agentRunResponseSchema, json(body)),
  run: (id: string) => read(`/runs/${encoded(id)}`, agentRunResponseSchema),
  answer: (id: string, body: AnswerRunRequest) => read(`/runs/${encoded(id)}/answer`, agentRunResponseSchema, json(body)),
  cancel: (id: string) => read(`/runs/${encoded(id)}/cancel`, agentRunResponseSchema, json({})),
  apply: (body: ApplyProposalRequest) => read(`/proposals/${encoded(body.proposalId)}/apply`, applyProposalResponseSchema, json(body)),
  operation: (id: string) => read(`/operations/${encoded(id)}`, operationResultSchema),
  revert: (id: string, operationId: string) => read(`/operations/${encoded(id)}/revert`, applyProposalResponseSchema, json({ operationId })),
  history: (date: string) => read(`/history?${new URLSearchParams({ date })}`, planningHistoryResponseSchema),
  feedback: (body: FeedbackRequest) => read("/feedback", planningFeedbackSchema, json(body)),
};

/** The real HTTP client and controlled test implementations share this contract. */
export type AgentApi = typeof agentApi;
