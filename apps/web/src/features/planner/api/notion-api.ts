import { request } from "@/shared/http/request";

export type NotionConnection = {
  workspaceId: string;
  workspaceName: string | null;
  botId: string;
  status: "active" | "refresh_pending" | "reauthorization_required";
  updatedAt: string;
};

export type NotionStatus = { configured: boolean; connections: NotionConnection[] };

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
};
