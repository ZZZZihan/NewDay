import {
  answerRunRequestSchema, applyProposalRequestSchema,
  type AnswerRunRequest, type ApplyProposalRequest,
} from "@newday/core/contracts/agent-planning";

export const AGENT_SESSION_KEY = "newday.agent.session.v1";
export type PendingOperation =
  | { kind: "apply"; request: ApplyProposalRequest }
  | { kind: "revert"; operationId: string; targetOperationId: string };
export type AgentSession = {
  date: string; requestId?: string; runId?: string; pending?: PendingOperation;
  abandonedRun?: { requestId: string; runId?: string };
  answer?: { runId: string; request: AnswerRunRequest };
};
export type SessionStore = { load(): AgentSession | null; save(value: AgentSession | null): void };

/** Only recovery identities and the exact submitted task IDs are persisted.
 * Browser data never substitutes for the authoritative server snapshot. */
export const browserSessionStore: SessionStore = {
  load() {
    try {
      const raw = window.sessionStorage.getItem(AGENT_SESSION_KEY);
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object") return null;
      const record = value as Record<string, unknown>;
      if (typeof record.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return null;
      const result: AgentSession = { date: record.date };
      if (typeof record.requestId === "string") result.requestId = record.requestId;
      if (typeof record.runId === "string") result.runId = record.runId;
      if (record.abandonedRun && typeof record.abandonedRun === "object") {
        const abandoned = record.abandonedRun as Record<string, unknown>;
        if (typeof abandoned.requestId === "string") result.abandonedRun = { requestId: abandoned.requestId, ...(typeof abandoned.runId === "string" ? { runId: abandoned.runId } : {}) };
      }
      if (record.answer && typeof record.answer === "object") {
        const answer = record.answer as Record<string, unknown>;
        if (typeof answer.runId === "string") result.answer = { runId: answer.runId, request: answerRunRequestSchema.parse(answer.request) };
      }
      if (record.pending && typeof record.pending === "object") {
        const pending = record.pending as Record<string, unknown>;
        if (pending.kind === "apply") result.pending = { kind: "apply", request: applyProposalRequestSchema.parse(pending.request) };
        else if (pending.kind === "revert" && typeof pending.operationId === "string" && typeof pending.targetOperationId === "string")
          result.pending = { kind: "revert", operationId: pending.operationId, targetOperationId: pending.targetOperationId };
      }
      return result;
    } catch { return null; }
  },
  save(value) {
    if (value) window.sessionStorage.setItem(AGENT_SESSION_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(AGENT_SESSION_KEY);
  },
};

export function operationId(pending: PendingOperation): string {
  return pending.kind === "apply" ? pending.request.operationId : pending.operationId;
}
