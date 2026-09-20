import { request } from "@/shared/http/request";

export type NotionConnection = {
  workspaceId: string;
  workspaceName: string | null;
  botId: string;
  status: "active" | "refresh_pending" | "reauthorization_required";
  updatedAt: string;
};

export type NotionStatus = { configured: boolean; connections: NotionConnection[] };

export type NotionStructureProgress = {
  workspaceId: string;
  state: "not_started" | "in_progress" | "needs_review" | "ready" | "paused_after_restore" | "disconnected";
  nextStep: string | null;
  reviewReason: "not_found" | "ambiguous" | "unreadable" | "schema_mismatch" | "permission" | "rate_limited" | "request_unknown" | null;
  retryAfterAt: string | null;
  rootPageId: string | null;
  dataSources: Record<string, { databaseId: string; dataSourceId: string; propertyIds: Record<string, string> }>;
  completedSteps: string[];
};

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(`/api/notion${path}`, { method: "POST", body: JSON.stringify(body) });
}

export const notionApi = {
  status: () => request<NotionStatus>("/api/notion/status"),
  start: () => post<{ authorizationUrl: string }>("/oauth/start", {}),
  claim: (state: string, ticket: string) => post<{ connection: NotionConnection }>("/oauth/claim", { state, ticket }),
  cancel: (state: string) => post<{ ok: true }>("/oauth/cancel", { state }),
  disconnect: (workspaceId: string) => post<{ ok: true; removed: boolean }>(`/connections/${encodeURIComponent(workspaceId)}/disconnect`, {}),
  refresh: (workspaceId: string) => post<{ connection: NotionConnection }>(`/connections/${encodeURIComponent(workspaceId)}/refresh`, {}),
  structure: (workspaceId: string) => request<NotionStructureProgress>(`/api/notion/connections/${encodeURIComponent(workspaceId)}/structure`),
  advanceStructure: (workspaceId: string) => post<NotionStructureProgress>(`/connections/${encodeURIComponent(workspaceId)}/structure/advance`, {}),
};
