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
  reviewAttemptedAt: string | null;
  rootPageId: string | null;
  dataSources: Record<string, { databaseId: string; dataSourceId: string; propertyIds: Record<string, string> }>;
  completedSteps: string[];
};

export type NotionRestoreStructureReview = {
  workspaceId: string;
  checkedAt: string;
  outcome: "matches" | "needs_review";
  checks: Array<{ step: string;
    result: "matches" | "record_incomplete" | "identity_mismatch" | "schema_mismatch" | "trashed" |
      "permission" | "rate_limited" | "unreadable" | "not_checked" }>;
};

export type NotionReadStatus = {
  workspaceId: string;
  connectionStatus: "active" | "disconnected" | "paused" | "paused_after_restore" | "paused_unknown" | "not_initialized";
  pauseReason: "preflight_read" | "manual" | null;
  sources: Array<{
    table: "areas" | "projects" | "rules" | "tasks";
    dataSourceId: string | null;
    watermark: {
      completedThrough: string | null; lastAttemptAt: string | null; lastSuccessAt: string | null;
      lastError?: "authorization" | "permission" | "rate_limited" | "schema" | "incomplete" | "network" | "remote" | "local" | null;
      lastErrorAt?: string | null;
    } | null;
  }>;
};

export type NotionTaskFields = { title: string; date: [string, string] | null; completed: boolean };
export type NotionRestoreReview = {
  checkedAt: string;
  outcome: "matches_intent" | "different" | "not_observed" | "incomplete" | "ambiguous" |
    "identity_mismatch" | "unreadable" | "trashed";
  remotePageId: string | null;
  remoteFields: NotionTaskFields | null;
};

export type NotionSyncStatus = {
  workspaceId: string;
  connectionStatus: NotionReadStatus["connectionStatus"];
  pauseReason: NotionReadStatus["pauseReason"];
  retryAfterAt: string | null;
  operations: Array<{ operationId: string; localTaskId: string;
    status: "pending" | "sending" | "unknown" | "confirmed" | "superseded" | "quarantined";
    attemptCount: number; createdAt: string; lastAttemptAt: string | null }>;
  restoreQuarantine: Array<{ sourceEpoch: string; operationId: string; localTaskId: string;
    originalStatus: "pending" | "sending" | "unknown" | "confirmed" | "superseded" | "quarantined";
    attemptCount: number; lastAttemptAt: string | null; dataSourceId: string;
    remotePageId: string | null; clientKey: string; quarantinedAt: string;
    inCurrentOutbox?: boolean;
    desired?: NotionTaskFields; baseline?: NotionTaskFields | null; latestReview?: NotionRestoreReview }>;
  conflicts: Array<{ id: string; localTaskId: string; field: "title" | "date" | "completed";
    baseline: unknown; local: unknown; remote: unknown; winner: "notion"; recordedAt: string }>;
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
  reconcileStructure: (workspaceId: string, step: NonNullable<NotionStructureProgress["nextStep"]>,
    attemptedAt: string) => post<NotionStructureProgress>(
    `/connections/${encodeURIComponent(workspaceId)}/structure/reconcile`, { step, attemptedAt }),
  verifyRestoredStructure: (workspaceId: string) => post<NotionRestoreStructureReview>(
    `/connections/${encodeURIComponent(workspaceId)}/structure/restore/verify`, {}),
  readStatus: (workspaceId: string) => request<NotionReadStatus>(`/api/notion/connections/${encodeURIComponent(workspaceId)}/read`),
  scan: (workspaceId: string) => post<NotionReadStatus>(`/connections/${encodeURIComponent(workspaceId)}/read/scan`, {}),
  syncStatus: (workspaceId: string) => request<NotionSyncStatus>(`/api/notion/connections/${encodeURIComponent(workspaceId)}/sync`),
  drain: (workspaceId: string) => post<NotionSyncStatus>(`/connections/${encodeURIComponent(workspaceId)}/sync/drain`, {}),
  pause: (workspaceId: string) => post<NotionSyncStatus>(`/connections/${encodeURIComponent(workspaceId)}/sync/pause`, {}),
  reconcile: (workspaceId: string, operationId: string) => post<NotionSyncStatus>(
    `/connections/${encodeURIComponent(workspaceId)}/sync/operations/${encodeURIComponent(operationId)}/reconcile`, {}),
  reconcileRestore: (workspaceId: string, sourceEpoch: string, operationId: string) => post<NotionSyncStatus>(
    `/connections/${encodeURIComponent(workspaceId)}/sync/restore/${encodeURIComponent(operationId)}/reconcile`, { sourceEpoch }),
  resume: (workspaceId: string) => post<NotionSyncStatus>(`/connections/${encodeURIComponent(workspaceId)}/sync/resume`, {}),
};
