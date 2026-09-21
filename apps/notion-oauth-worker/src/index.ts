import { DurableObject } from "cloudflare:workers";

type Credential = {
  access_token: string;
  refresh_token: string;
  bot_id: string;
  workspace_id: string;
  workspace_name?: string | null;
};

type AuthorizationRecord = {
  kind: "authorization";
  status: "pending" | "exchanging" | "ready" | "claimed" | "spent" | "cancelled" | "failed";
  challenge: string;
  expiresAt: number;
  ticketHash?: string;
  credential?: Credential;
};

type RefreshRecord = {
  kind: "refresh";
  status: "exchanging" | "ready" | "failed";
  attemptId: string;
  expiresAt: number;
  credential?: Credential;
};

type SessionRecord = AuthorizationRecord | RefreshRecord;

const AUTHORIZATION_LIFETIME_MS = 10 * 60_000;
const REFRESH_RESULT_LIFETIME_MS = 24 * 60 * 60_000;
const MAX_JSON_BODY_BYTES = 4096;
const MAX_UPSTREAM_JSON_BYTES = 16 * 1024;
const MAX_TOKEN_LENGTH = 8192;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_WORKSPACE_NAME_LENGTH = 512;
const opaqueToken = /^[A-Za-z0-9_-]{43}$/;
const digest = /^[a-f0-9]{64}$/;

/** Each random OAuth state or refresh-token fingerprint has one strongly
 * consistent SQLite-backed object. No token is sent to the browser. */
export class OAuthSession extends DurableObject<Env> {
  private read(): SessionRecord | undefined {
    return this.ctx.storage.kv.get<SessionRecord>("record");
  }

  async begin(challenge: string, now: number): Promise<boolean> {
    if (this.read()) return false;
    const record: AuthorizationRecord = {
      kind: "authorization", status: "pending", challenge,
      expiresAt: now + AUTHORIZATION_LIFETIME_MS,
    };
    await this.ctx.storage.setAlarm(record.expiresAt);
    this.ctx.storage.kv.put("record", record);
    return true;
  }

  beginCallback(now: number): boolean {
    const record = this.read();
    if (!record || record.kind !== "authorization" || record.status !== "pending" || record.expiresAt <= now) return false;
    this.ctx.storage.kv.put("record", { ...record, status: "exchanging" });
    return true;
  }

  cancel(now: number): boolean {
    const record = this.read();
    if (!record || record.kind !== "authorization" || record.status !== "pending" || record.expiresAt <= now) return false;
    this.ctx.storage.kv.put("record", { ...record, status: "cancelled" });
    return true;
  }

  fail(): void {
    const record = this.read();
    if (record?.kind === "authorization" && record.status === "exchanging") {
      this.ctx.storage.kv.put("record", { ...record, status: "failed" });
    }
  }

  finish(ticketHash: string, credential: Credential, now: number): boolean {
    const record = this.read();
    if (!record || record.kind !== "authorization" || record.status !== "exchanging" || record.expiresAt <= now) return false;
    this.ctx.storage.kv.put("record", { ...record, status: "ready", ticketHash, credential });
    return true;
  }

  claim(ticketHash: string, challenge: string, now: number): Credential | null {
    const record = this.read();
    if (!record || record.kind !== "authorization" || !["ready", "claimed"].includes(record.status) ||
      record.expiresAt <= now || record.ticketHash !== ticketHash || record.challenge !== challenge || !record.credential) return null;
    // The local API acknowledges after its encrypted SQLite commit. Repeated
    // delivery with the same verifier is safe if that commit was interrupted.
    this.ctx.storage.kv.put("record", { ...record, status: "claimed" });
    return record.credential;
  }

  acknowledge(ticketHash: string, challenge: string, now: number): boolean {
    const record = this.read();
    if (!record || record.kind !== "authorization" || record.status !== "claimed" ||
      record.expiresAt <= now || record.ticketHash !== ticketHash || record.challenge !== challenge) return false;
    this.ctx.storage.kv.put("record", { ...record, status: "spent", credential: undefined });
    return true;
  }

  async beginRefresh(attemptId: string, now: number): Promise<"start" | "ready" | "inflight" | "failed" | "conflict"> {
    const record = this.read();
    if (record) {
      if (record.kind !== "refresh" || record.attemptId !== attemptId || record.expiresAt <= now) return "conflict";
      return record.status === "exchanging" ? "inflight" : record.status;
    }
    const next: RefreshRecord = {
      kind: "refresh", status: "exchanging", attemptId,
      expiresAt: now + REFRESH_RESULT_LIFETIME_MS,
    };
    await this.ctx.storage.setAlarm(next.expiresAt);
    this.ctx.storage.kv.put("record", next);
    return "start";
  }

  finishRefresh(attemptId: string, credential: Credential, now: number): boolean {
    const record = this.read();
    if (!record || record.kind !== "refresh" || record.status !== "exchanging" ||
      record.attemptId !== attemptId || record.expiresAt <= now) return false;
    this.ctx.storage.kv.put("record", { ...record, status: "ready", credential });
    return true;
  }

  failRefresh(attemptId: string): void {
    const record = this.read();
    if (record?.kind === "refresh" && record.status === "exchanging" && record.attemptId === attemptId) {
      this.ctx.storage.kv.put("record", { ...record, status: "failed" });
    }
  }

  refreshResult(attemptId: string, now: number): Credential | null {
    const record = this.read();
    return record?.kind === "refresh" && record.status === "ready" &&
      record.attemptId === attemptId && record.expiresAt > now ? record.credential ?? null : null;
  }

  alarm(): void {
    this.ctx.storage.kv.delete("record");
  }
}

function validConfiguration(env: Env): boolean {
  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET || !env.OAUTH_SESSIONS ||
    !env.LOCAL_API_KEY || !opaqueToken.test(env.LOCAL_API_KEY)) return false;
  try {
    const redirect = new URL(env.NOTION_REDIRECT_URI);
    const local = new URL(env.LOCAL_RETURN_ORIGIN);
    return redirect.protocol === "https:" && redirect.pathname === "/oauth/callback" &&
      !redirect.username && !redirect.password && !redirect.search && !redirect.hash &&
      local.protocol === "http:" && local.hostname === "127.0.0.1" &&
      local.origin === env.LOCAL_RETURN_ORIGIN;
  } catch { return false; }
}

async function authorized(request: Request, apiKey: string): Promise<boolean> {
  const received = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${apiKey}`;
  const encoder = new TextEncoder();
  const [receivedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(receivedHash, expectedHash);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
  } });
}

function redirectToLocal(env: Env, result: string, state: string, ticket?: string): Response {
  const destination = new URL(env.LOCAL_RETURN_ORIGIN);
  destination.hash = `notion-oauth=${result}:${state}${ticket ? `:${ticket}` : ""}`;
  return new Response(null, { status: 303, headers: {
    location: destination.href, "cache-control": "no-store", "referrer-policy": "no-referrer",
  } });
}

async function readSmallJson(request: Request): Promise<Record<string, unknown> | null> {
  return readJsonObject(request.body, request.headers, MAX_JSON_BODY_BYTES);
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try { await body.cancel(); }
  catch { /* Preserve the original sanitized rejection. */ }
}

async function readJsonObject(body: ReadableStream<Uint8Array> | null, headers: Headers,
  maxBytes: number): Promise<Record<string, unknown> | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(headers.get("content-type") ?? "")) {
    await cancelBody(body);
    return null;
  }
  const declaredLength = headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isInteger(length) || length < 0 || length > maxBytes) {
      await cancelBody(body);
      return null;
    }
  }
  if (!body) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        try { await reader.cancel(); }
        catch { /* Preserve the original sanitized rejection. */ }
        return null;
      }
      chunks.push(value);
    }
  } catch {
    try { await reader.cancel(); }
    catch { /* The stream is already errored or closed. */ }
    return null;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { return null; }
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function parseCredential(value: Record<string, unknown>): Credential | null {
  const accessToken = boundedString(value.access_token, MAX_TOKEN_LENGTH);
  const refreshToken = boundedString(value.refresh_token, MAX_TOKEN_LENGTH);
  const botId = boundedString(value.bot_id, MAX_IDENTIFIER_LENGTH);
  const workspaceId = boundedString(value.workspace_id, MAX_IDENTIFIER_LENGTH);
  const workspaceName = value.workspace_name;
  if (!accessToken || !refreshToken || !botId || !workspaceId ||
    (workspaceName !== undefined && workspaceName !== null &&
      (typeof workspaceName !== "string" || workspaceName.length > MAX_WORKSPACE_NAME_LENGTH))) return null;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    bot_id: botId,
    workspace_id: workspaceId,
    ...(workspaceName === undefined ? {} : { workspace_name: workspaceName }),
  };
}

function encodeToken(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomToken(): string {
  return encodeToken(crypto.getRandomValues(new Uint8Array(32)));
}

async function stateTag(nonce: Uint8Array, apiKey: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(apiKey),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, nonce);
  return new Uint8Array(signature).slice(0, 16);
}

async function randomState(apiKey: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const state = new Uint8Array(32);
  state.set(nonce);
  state.set(await stateTag(nonce, apiKey), nonce.length);
  return encodeToken(state);
}

async function validState(value: string, apiKey: string): Promise<boolean> {
  if (!opaqueToken.test(value)) return false;
  let bytes: Uint8Array;
  try {
    const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=");
    bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch { return false; }
  if (bytes.length !== 32 || encodeToken(bytes) !== value) return false;
  const expected = await stateTag(bytes.slice(0, 16), apiKey);
  return crypto.subtle.timingSafeEqual(bytes.slice(16), expected);
}

async function hash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const output = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(output)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function exchangeToken(env: Env, payload: Record<string, string>): Promise<Credential | null> {
  let response: Response;
  try {
    response = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Basic ${btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`)}`,
        accept: "application/json", "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch { return null; }
  if (!response.ok) {
    await cancelBody(response.body);
    return null;
  }
  const token = await readJsonObject(response.body, response.headers, MAX_UPSTREAM_JSON_BYTES);
  return token ? parseCredential(token) : null;
}

export async function handleOAuthRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return json({ status: "ok" });
  if (!validConfiguration(env)) return json({ error: "oauth_not_configured" }, 503);
  if (url.pathname !== "/oauth/callback" && !await authorized(request, env.LOCAL_API_KEY)) return json({ error: "unauthorized" }, 401);

  if (url.pathname === "/oauth/start" && request.method === "POST") {
    const body = await readSmallJson(request);
    if (!body || typeof body.challenge !== "string" || !digest.test(body.challenge)) return json({ error: "invalid_request" }, 400);
    const state = await randomState(env.LOCAL_API_KEY);
    if (!await env.OAUTH_SESSIONS.getByName(state).begin(body.challenge, Date.now())) return json({ error: "state_unavailable" }, 503);
    const authorizationUrl = new URL("https://api.notion.com/v1/oauth/authorize");
    authorizationUrl.searchParams.set("owner", "user");
    authorizationUrl.searchParams.set("client_id", env.NOTION_CLIENT_ID);
    authorizationUrl.searchParams.set("redirect_uri", env.NOTION_REDIRECT_URI);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("state", state);
    return json({ state, authorizationUrl: authorizationUrl.href });
  }

  if (url.pathname === "/oauth/callback" && request.method === "GET") {
    const state = url.searchParams.get("state");
    if (!state || !await validState(state, env.LOCAL_API_KEY)) return json({ error: "invalid_state" }, 400);
    const session = env.OAUTH_SESSIONS.getByName(state);
    if (url.searchParams.has("error")) {
      if (!await session.cancel(Date.now())) return json({ error: "state_used_or_expired" }, 409);
      return redirectToLocal(env, url.searchParams.get("error") === "access_denied" ? "cancelled" : "error", state);
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 2048 || !await session.beginCallback(Date.now())) return json({ error: "state_used_or_expired" }, 409);
    const credential = await exchangeToken(env, {
      grant_type: "authorization_code", code, redirect_uri: env.NOTION_REDIRECT_URI,
    });
    if (!credential) { await session.fail(); return redirectToLocal(env, "error", state); }
    const ticket = randomToken();
    if (!await session.finish(await hash(ticket), credential, Date.now())) return json({ error: "state_used_or_expired" }, 409);
    return redirectToLocal(env, "ready", state, ticket);
  }

  if (url.pathname === "/oauth/claim" && request.method === "POST") {
    const body = await readSmallJson(request);
    if (!body || typeof body.state !== "string" || !opaqueToken.test(body.state) ||
      typeof body.ticket !== "string" || !opaqueToken.test(body.ticket) ||
      typeof body.verifier !== "string" || !opaqueToken.test(body.verifier)) return json({ error: "invalid_request" }, 400);
    const credential = await env.OAUTH_SESSIONS.getByName(body.state)
      .claim(await hash(body.ticket), await hash(body.verifier), Date.now());
    return credential ? json(credential) : json({ error: "claim_unavailable" }, 409);
  }

  if (url.pathname === "/oauth/ack" && request.method === "POST") {
    const body = await readSmallJson(request);
    if (!body || typeof body.state !== "string" || !opaqueToken.test(body.state) ||
      typeof body.ticket !== "string" || !opaqueToken.test(body.ticket) ||
      typeof body.verifier !== "string" || !opaqueToken.test(body.verifier)) return json({ error: "invalid_request" }, 400);
    const acknowledged = await env.OAUTH_SESSIONS.getByName(body.state)
      .acknowledge(await hash(body.ticket), await hash(body.verifier), Date.now());
    return acknowledged ? json({ status: "acknowledged" }) : json({ error: "claim_unavailable" }, 409);
  }

  if (url.pathname === "/oauth/refresh" && request.method === "POST") {
    const body = await readSmallJson(request);
    if (!body || typeof body.refreshToken !== "string" || body.refreshToken.length < 16 || body.refreshToken.length > 2048 ||
      typeof body.attemptId !== "string" || !opaqueToken.test(body.attemptId)) return json({ error: "invalid_request" }, 400);
    const session = env.OAUTH_SESSIONS.getByName(`refresh:${await hash(body.refreshToken)}`);
    const action = await session.beginRefresh(body.attemptId, Date.now());
    if (action === "ready") {
      const credential = await session.refreshResult(body.attemptId, Date.now());
      return credential ? json(credential) : json({ error: "refresh_unavailable" }, 409);
    }
    if (action !== "start") return json({ error: action === "inflight" ? "refresh_inflight" : "refresh_unavailable" }, 409);
    const credential = await exchangeToken(env, { grant_type: "refresh_token", refresh_token: body.refreshToken });
    if (!credential) { await session.failRefresh(body.attemptId); return json({ error: "refresh_unavailable" }, 502); }
    if (!await session.finishRefresh(body.attemptId, credential, Date.now())) return json({ error: "refresh_unavailable" }, 409);
    return json(credential);
  }

  return json({ error: "not_found" }, 404);
}

export default {
  fetch: handleOAuthRequest,
} satisfies ExportedHandler<Env>;
