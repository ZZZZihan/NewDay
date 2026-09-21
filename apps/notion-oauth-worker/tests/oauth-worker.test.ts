import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { handleOAuthRequest } from "../src/index";

const workerEnv = env as Env;

function post(path: string, body: object): Promise<Response> {
  return handleOAuthRequest(new Request(`https://oauth.example.test${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${workerEnv.LOCAL_API_KEY}` }, body: JSON.stringify(body),
  }), workerEnv);
}

async function hash(value: string): Promise<string> {
  const output = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(output)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const credential = { access_token: "access-test", refresh_token: "refresh-test", bot_id: "bot-test", workspace_id: "workspace-test" };

describe("OAuth Worker handoff", () => {
  it("rejects unauthenticated server calls", async () => {
    const response = await handleOAuthRequest(new Request("https://oauth.example.test/oauth/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: "a".repeat(64) }),
    }), workerEnv);
    expect(response.status).toBe(401);
  });

  it("rejects oversized JSON before consuming a declared body", async () => {
    let bodyRead = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyRead = true;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const response = await handleOAuthRequest(new Request("https://oauth.example.test/oauth/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "4097",
        authorization: `Bearer ${workerEnv.LOCAL_API_KEY}`,
      },
      body,
    }), workerEnv);
    expect(response.status).toBe(400);
    expect(bodyRead).toBe(false);
  });

  it("rejects chunked JSON as soon as it exceeds the byte limit", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(4097);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handleOAuthRequest(new Request("https://oauth.example.test/oauth/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${workerEnv.LOCAL_API_KEY}`,
      },
      body,
    }), workerEnv);
    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
  });

  it("requires a bound verifier, allows committed redelivery, and rejects replay after acknowledgement", async () => {
    const verifier = "v".repeat(43);
    const challenge = await hash(verifier);
    const started = await post("/oauth/start", { challenge });
    expect(started.status).toBe(200);
    const { state, authorizationUrl } = await started.json() as { state: string; authorizationUrl: string };
    expect(new URL(authorizationUrl).searchParams.get("state")).toBe(state);
    const session = workerEnv.OAUTH_SESSIONS.getByName(state);
    expect(await session.beginCallback(Date.now())).toBe(true);
    const ticket = "t".repeat(43);
    expect(await session.finish(await hash(ticket), credential, Date.now())).toBe(true);
    expect((await post("/oauth/claim", { state, ticket, verifier: "x".repeat(43) })).status).toBe(409);
    const first = await post("/oauth/claim", { state, ticket, verifier });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject(credential);
    expect((await post("/oauth/claim", { state, ticket, verifier })).status).toBe(200);
    expect((await post("/oauth/ack", { state, ticket, verifier })).status).toBe(200);
    expect((await post("/oauth/claim", { state, ticket, verifier })).status).toBe(409);
    expect((await post("/oauth/ack", { state, ticket, verifier })).status).toBe(409);
  });

  it("cancellation marks a state unusable and returns only a fixed loopback URL", async () => {
    const started = await post("/oauth/start", { challenge: await hash("v".repeat(43)) });
    const { state } = await started.json() as { state: string };
    const callback = await handleOAuthRequest(new Request(`https://oauth.example.test/oauth/callback?state=${state}&error=access_denied`), workerEnv);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`http://127.0.0.1:3000/#notion-oauth=cancelled:${state}`);
    expect((await post("/oauth/claim", { state, ticket: "t".repeat(43), verifier: "v".repeat(43) })).status).toBe(409);
  });

  it("rejects forged public callback states before opening a session object", async () => {
    const response = await handleOAuthRequest(new Request(
      `https://oauth.example.test/oauth/callback?state=${"s".repeat(43)}&code=attacker-code`), workerEnv);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_state" });

    const started = await post("/oauth/start", { challenge: await hash("c".repeat(43)) });
    const { state } = await started.json() as { state: string };
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalIndex = alphabet.indexOf(state.at(-1)!);
    const nonCanonicalState = `${state.slice(0, -1)}${alphabet[finalIndex + 1]}`;
    const nonCanonical = await handleOAuthRequest(new Request(
      `https://oauth.example.test/oauth/callback?state=${nonCanonicalState}&code=attacker-code`), workerEnv);
    expect(nonCanonical.status).toBe(400);
  });

  it("bounds token responses and keeps only credential fields required by the local vault", async () => {
    const verifier = "z".repeat(43);
    const started = await post("/oauth/start", { challenge: await hash(verifier) });
    const { state } = await started.json() as { state: string };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...credential,
      workspace_name: "隔离工作区",
      owner: { user: { person: { email: "must-not-be-persisted@example.test" } } },
      duplicated_template_id: "not-needed",
    })));
    try {
      const callback = await handleOAuthRequest(new Request(
        `https://oauth.example.test/oauth/callback?state=${state}&code=test-code`), workerEnv);
      expect(callback.status).toBe(303);
      const fragment = new URL(callback.headers.get("location")!).hash;
      const ticket = fragment.split(":")[2]!;
      const claimed = await post("/oauth/claim", { state, ticket, verifier });
      expect(await claimed.json()).toEqual({ ...credential, workspace_name: "隔离工作区" });
    } finally {
      vi.unstubAllGlobals();
    }

    const oversizedStarted = await post("/oauth/start", { challenge: await hash("y".repeat(43)) });
    const oversizedState = ((await oversizedStarted.json()) as { state: string }).state;
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(16 * 1024 + 1)); },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(oversized, {
      status: 200, headers: { "content-type": "application/json" },
    })));
    try {
      const callback = await handleOAuthRequest(new Request(
        `https://oauth.example.test/oauth/callback?state=${oversizedState}&code=test-code`), workerEnv);
      expect(callback.headers.get("location")).toBe(
        `http://127.0.0.1:3000/#notion-oauth=error:${oversizedState}`);
      expect(cancelled).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns a persisted rotated refresh result for the same attempt without another exchange", async () => {
    const oldRefreshToken = "old-refresh-secret-for-test";
    const attemptId = "a".repeat(43);
    const session = workerEnv.OAUTH_SESSIONS.getByName(`refresh:${await hash(oldRefreshToken)}`);
    expect(await session.beginRefresh(attemptId, Date.now())).toBe("start");
    expect(await session.finishRefresh(attemptId, credential, Date.now())).toBe(true);
    const response = await post("/oauth/refresh", { refreshToken: oldRefreshToken, attemptId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(credential);
    expect((await post("/oauth/refresh", { refreshToken: oldRefreshToken, attemptId: "b".repeat(43) })).status).toBe(409);
  });
});
