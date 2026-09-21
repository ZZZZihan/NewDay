import { createHash, randomBytes } from "node:crypto";

import { ApiError } from "../http/api-error.js";
import { NotionCredentialVault, type NotionCredential, type NotionCredentialSummary } from "../storage/notion-credential-vault.js";

const opaqueToken = /^[A-Za-z0-9_-]{43}$/;
const MAX_WORKER_RESPONSE_BYTES = 16 * 1024;
const MAX_TOKEN_LENGTH = 8192;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_WORKSPACE_NAME_LENGTH = 512;

export class NotionOAuthService {
  constructor(
    private readonly workerOrigin: string,
    private readonly workerApiKey: string,
    private readonly vault: NotionCredentialVault,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  listConnections(): NotionCredentialSummary[] { return this.vault.list(); }

  async start(): Promise<{ authorizationUrl: string }> {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("hex");
    // Reserve order before waiting for the Worker. A workspace can be
    // disconnected while /oauth/start is still in flight.
    const startSequence = this.vault.beginAuthorization();
    const response = await this.request("/oauth/start", { challenge });
    if (typeof response.state !== "string" || !opaqueToken.test(response.state) ||
      typeof response.authorizationUrl !== "string") throw new ApiError(502, "Notion 授权服务返回无效会话");
    let authorizationUrl: URL;
    try { authorizationUrl = new URL(response.authorizationUrl); }
    catch { throw new ApiError(502, "Notion 授权服务返回无效地址"); }
    if (authorizationUrl.origin !== "https://api.notion.com" || authorizationUrl.pathname !== "/v1/oauth/authorize" ||
      authorizationUrl.searchParams.get("state") !== response.state ||
      authorizationUrl.searchParams.get("redirect_uri") !== `${this.workerOrigin}/oauth/callback`) {
      throw new ApiError(502, "Notion 授权服务返回无效地址");
    }
    const now = this.now();
    this.vault.putPending(response.state, verifier, now + 10 * 60_000, now, startSequence);
    return { authorizationUrl: authorizationUrl.href };
  }

  cancel(state: string): void {
    if (!opaqueToken.test(state)) throw new ApiError(400, "授权会话无效");
    this.vault.removePending(state);
  }

  async claim(state: string, ticket: string): Promise<NotionCredentialSummary> {
    if (!opaqueToken.test(state) || !opaqueToken.test(ticket)) throw new ApiError(400, "授权结果无效");
    const verifier = this.vault.getPending(state, this.now());
    if (!verifier) throw new ApiError(409, "授权会话已过期或已处理，请重新授权");
    const response = await this.request("/oauth/claim", { state, ticket, verifier });
    const credential = parseCredential(response);
    const summary = this.vault.storeClaimed(state, credential, new Date(this.now()).toISOString());
    if (!summary) {
      // The disconnect won the local transaction. Clear the temporary Worker
      // result when possible; its TTL is the fallback if ACK is unavailable.
      try { await this.request("/oauth/ack", { state, ticket, verifier }); }
      catch { /* The rejected token remains unusable locally. */ }
      throw new ApiError(409, "授权会话已取消、过期或该工作区已断开，请重新开始授权");
    }
    // The Worker can safely redeliver the same claim until this ACK. If the
    // ACK is lost, the temporary copy expires; local storage is authoritative.
    try { await this.request("/oauth/ack", { state, ticket, verifier }); }
    catch { /* A committed local credential must not be rolled back. */ }
    return summary;
  }

  async refresh(workspaceId: string): Promise<NotionCredentialSummary> {
    const attempt = this.vault.beginRefresh(workspaceId);
    if (!attempt) throw new ApiError(409, "Notion 连接不存在或需要重新授权");
    let response: Record<string, unknown>;
    try {
      response = await this.request("/oauth/refresh", {
        refreshToken: attempt.credential.refresh_token, attemptId: attempt.attemptId,
      });
    } catch (error) {
      if (error instanceof WorkerOAuthError && error.code === "refresh_inflight") {
        throw new ApiError(503, "Notion 凭据正在刷新，请稍后重试");
      }
      if (error instanceof WorkerOAuthError && error.code === "refresh_unavailable") {
        this.vault.requireReauthorization(workspaceId, attempt.attemptId, new Date(this.now()).toISOString());
        throw new ApiError(409, "Notion 凭据刷新失败，需要重新授权");
      }
      // A lost response may follow a successful rotation. Keep the persisted
      // attempt ID and block use of the old token until retry retrieves the
      // Worker's cached result or proves the outcome unavailable.
      throw new ApiError(503, "Notion 凭据刷新结果待确认，请重试");
    }
    let credential: NotionCredential;
    try { credential = parseCredential(response); }
    catch {
      this.vault.requireReauthorization(workspaceId, attempt.attemptId, new Date(this.now()).toISOString());
      throw new ApiError(409, "Notion 凭据刷新结果无法确认，需要重新授权");
    }
    try { return this.vault.completeRefresh(workspaceId, attempt.attemptId, credential, new Date(this.now()).toISOString()); }
    catch {
      this.vault.requireReauthorization(workspaceId, attempt.attemptId, new Date(this.now()).toISOString());
      throw new ApiError(409, "Notion 连接在刷新期间已改变，需要重新授权");
    }
  }

  disconnect(workspaceId: string): boolean {
    return this.vault.disconnect(workspaceId);
  }

  private async request(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.workerOrigin), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${this.workerApiKey}` },
        body: JSON.stringify(body),
      });
    } catch { throw new ApiError(503, "Notion 授权服务暂时不可用"); }
    const result = await readWorkerJson(response);
    if (!response.ok) {
      throw new WorkerOAuthError(response.status, typeof result.error === "string" ? result.error : "oauth_error");
    }
    return result;
  }
}

class WorkerOAuthError extends ApiError {
  constructor(readonly status: number, readonly code: string) {
    super(status === 409 ? 409 : status >= 500 || status === 429 ? 503 : 502,
      status === 409 ? "Notion 授权会话已失效，请重新授权" : "Notion 授权服务暂时无法完成请求");
  }
}

function parseCredential(value: Record<string, unknown>): NotionCredential {
  const accessToken = boundedString(value.access_token, MAX_TOKEN_LENGTH);
  const refreshToken = boundedString(value.refresh_token, MAX_TOKEN_LENGTH);
  const botId = boundedString(value.bot_id, MAX_IDENTIFIER_LENGTH);
  const workspaceId = boundedString(value.workspace_id, MAX_IDENTIFIER_LENGTH);
  const workspaceName = value.workspace_name;
  if (!accessToken || !refreshToken || !botId || !workspaceId ||
    (workspaceName !== undefined && workspaceName !== null &&
      (typeof workspaceName !== "string" || workspaceName.length > MAX_WORKSPACE_NAME_LENGTH))) {
    throw new ApiError(502, "Notion 授权服务返回无效凭据");
  }
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    bot_id: botId,
    workspace_id: workspaceId,
    ...(workspaceName === undefined ? {} : { workspace_name: workspaceName }),
  };
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try { await body.cancel(); }
  catch { /* Preserve the original sanitized rejection. */ }
}

async function readWorkerJson(response: Response): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await cancelBody(response.body);
    throw new ApiError(502, "Notion 授权服务返回无效响应");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isInteger(length) || length < 0 || length > MAX_WORKER_RESPONSE_BYTES) {
      await cancelBody(response.body);
      throw new ApiError(502, "Notion 授权服务返回无效响应");
    }
  }
  if (!response.body) throw new ApiError(502, "Notion 授权服务返回无效响应");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_WORKER_RESPONSE_BYTES) {
        try { await reader.cancel(); }
        catch { /* Preserve the original sanitized rejection. */ }
        throw new ApiError(502, "Notion 授权服务返回无效响应");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    try { await reader.cancel(); }
    catch { /* The stream is already errored or closed. */ }
    throw new ApiError(502, "Notion 授权服务返回无效响应");
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try {
    const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    value = JSON.parse(body);
  } catch { throw new ApiError(502, "Notion 授权服务返回无效响应"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(502, "Notion 授权服务返回无效响应");
  }
  return value as Record<string, unknown>;
}
