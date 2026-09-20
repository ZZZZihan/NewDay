import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { NotionOAuthService } from "../src/services/notion-oauth-service.js";
import { NotionCredentialVault, type NotionCredential } from "../src/storage/notion-credential-vault.js";

const origin = "https://oauth.example.test";
const state = "s".repeat(43);
const ticket = "t".repeat(43);
const workerApiKey = "k".repeat(43);
const credential: NotionCredential = {
  access_token: "access-secret-marker", refresh_token: "refresh-secret-marker",
  bot_id: "bot-one", workspace_id: "workspace-one", workspace_name: "测试空间",
};
const key = Buffer.alloc(32, 29);

function workerStub() {
  let challenge = "";
  let acknowledged = false;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${workerApiKey}`);
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    if (path === "/oauth/start") {
      challenge = body.challenge;
      const authorization = new URL("https://api.notion.com/v1/oauth/authorize");
      authorization.searchParams.set("state", state);
      authorization.searchParams.set("redirect_uri", `${origin}/oauth/callback`);
      return Response.json({ state, authorizationUrl: authorization.href });
    }
    if (path === "/oauth/claim" && body.state === state && body.ticket === ticket &&
      createHash("sha256").update(body.verifier).digest("hex") === challenge && !acknowledged) {
      return Response.json(credential);
    }
    if (path === "/oauth/ack") {
      acknowledged = true;
      return Response.json({ status: "acknowledged" });
    }
    return Response.json({ error: "claim_unavailable" }, { status: 409 });
  };
  return { fetcher, wasAcknowledged: () => acknowledged };
}

test("Notion API keeps OAuth secrets out of responses and business backup; replay and disconnect fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-oauth-"));
  const vaultPath = join(directory, "vault", "credentials.sqlite");
  const fake = workerStub();
  const app = createApp({ databasePath: ":memory:", notionOAuth: { workerOrigin: origin, workerApiKey, vaultPath, encryptionKey: key }, notionFetcher: fake.fetcher });
  try {
    const post = (path: string, payload: object = {}) => app.inject({ method: "POST", url: `/api/notion${path}`, payload });
    assert.deepEqual((await app.inject("/api/notion/status")).json(), { configured: true, connections: [] });
    const started = await post("/oauth/start");
    assert.equal(started.statusCode, 200);
    assert.equal(new URL(started.json().authorizationUrl).origin, "https://api.notion.com");
    assert.equal((await post("/oauth/claim", { state, ticket })).statusCode, 200);
    assert.equal(fake.wasAcknowledged(), true);
    const status = await app.inject("/api/notion/status");
    assert.deepEqual(status.json().connections.map((item: { status: string; workspaceId: string }) =>
      ({ status: item.status, workspaceId: item.workspaceId })), [{ status: "active", workspaceId: "workspace-one" }]);
    assert.equal(status.body.includes("secret-marker"), false);
    assert.equal((await app.inject("/api/planner/backup")).body.includes("secret-marker"), false);
    assert.equal((await app.inject("/api/agent/backup")).body.includes("secret-marker"), false);
    assert.equal((await readFile(vaultPath, "utf8")).includes("secret-marker"), false);
    assert.equal((await post("/oauth/claim", { state, ticket })).statusCode, 409);
    assert.equal((await post("/connections/workspace-one/disconnect")).json().removed, true);
    assert.deepEqual((await app.inject("/api/notion/status")).json().connections, []);
    const wrongOrigin = await app.inject({ method: "POST", url: "/api/notion/oauth/start", headers: { origin: "https://evil.example" }, payload: {} });
    assert.equal(wrongOrigin.statusCode, 403);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelled local state cannot claim a valid Worker ticket", async () => {
  const fake = workerStub();
  const app = createApp({ databasePath: ":memory:", notionOAuth: {
    workerOrigin: origin, workerApiKey, vaultPath: ":memory:", encryptionKey: key,
  }, notionFetcher: fake.fetcher });
  try {
    const post = (path: string, payload: object = {}) => app.inject({ method: "POST", url: `/api/notion${path}`, payload });
    assert.equal((await post("/oauth/start")).statusCode, 200);
    assert.equal((await post("/oauth/cancel", { state })).statusCode, 200);
    assert.equal((await post("/oauth/claim", { state, ticket })).statusCode, 409);
    assert.deepEqual((await app.inject("/api/notion/status")).json().connections, []);
  } finally { await app.close(); }
});

test("disconnecting one workspace preserves a different pending authorization", () => {
  const vault = new NotionCredentialVault(":memory:", key);
  const pendingForAnotherWorkspace = "b".repeat(43);
  try {
    vault.putPending(state, "first verifier", Date.now() + 60_000);
    vault.storeClaimed(state, credential, new Date().toISOString());
    vault.putPending(pendingForAnotherWorkspace, "second verifier", Date.now() + 60_000);
    assert.equal(vault.disconnect("workspace-one"), true);
    assert.equal(vault.getCredential("workspace-one"), null);
    assert.equal(vault.getPending(pendingForAnotherWorkspace, Date.now()), "second verifier");
  } finally { vault.close(); }
});

test("disconnect rejects an older claim for that workspace across restart, but permits another workspace and a new claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-disconnect-"));
  const path = join(directory, "vault.sqlite");
  const oldA = "a".repeat(43);
  const pendingB = "b".repeat(43);
  const newA = "c".repeat(43);
  const now = Date.parse("2026-09-21T00:00:00.000Z");
  const acknowledged: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const endpoint = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    if (endpoint === "/oauth/ack") {
      acknowledged.push(body.state);
      return Response.json({ status: "acknowledged" });
    }
    assert.equal(endpoint, "/oauth/claim");
    return Response.json({ ...credential, workspace_id: body.state === pendingB ? "workspace-two" : "workspace-one" });
  };
  let vault = new NotionCredentialVault(path, key);
  try {
    vault.putPending(state, "initial", now + 60_000, now);
    assert.ok(vault.storeClaimed(state, credential, new Date(now).toISOString()));
    vault.putPending(oldA, "old-A", now + 60_000, now);
    vault.putPending(pendingB, "pending-B", now + 60_000, now);
    assert.equal(vault.disconnect("workspace-one"), true);
    vault.close();
    vault = new NotionCredentialVault(path, key);
    const service = new NotionOAuthService(origin, workerApiKey, vault, fetcher, () => now);
    await assert.rejects(service.claim(oldA, ticket), /已断开/);
    assert.equal(vault.getCredential("workspace-one"), null);
    assert.equal(vault.getPending(oldA, now), null);
    assert.equal((await service.claim(pendingB, ticket)).workspaceId, "workspace-two");
    vault.putPending(newA, "new-A", now + 60_000, now);
    assert.equal((await service.claim(newA, ticket)).workspaceId, "workspace-one");
    assert.deepEqual(acknowledged, [oldA, pendingB, newA]);
  } finally {
    vault.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disconnect rejects an authorization whose Worker start response arrives afterward", async () => {
  const vault = new NotionCredentialVault(":memory:", key);
  const delayedState = "d".repeat(43);
  let workerEntered!: () => void;
  let releaseWorker!: () => void;
  const entered = new Promise<void>((resolve) => { workerEntered = resolve; });
  const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
  const fetcher: typeof fetch = async (input) => {
    const endpoint = new URL(String(input)).pathname;
    if (endpoint === "/oauth/start") {
      workerEntered();
      await workerGate;
      const authorization = new URL("https://api.notion.com/v1/oauth/authorize");
      authorization.searchParams.set("state", delayedState);
      authorization.searchParams.set("redirect_uri", `${origin}/oauth/callback`);
      return Response.json({ state: delayedState, authorizationUrl: authorization.href });
    }
    if (endpoint === "/oauth/claim") return Response.json(credential);
    return Response.json({ status: "acknowledged" });
  };
  const now = Date.parse("2026-09-21T00:00:00.000Z");
  try {
    vault.putPending(state, "initial", now + 60_000, now);
    vault.storeClaimed(state, credential, new Date(now).toISOString());
    const service = new NotionOAuthService(origin, workerApiKey, vault, fetcher, () => now);
    const starting = service.start();
    await entered;
    assert.equal(service.disconnect("workspace-one"), true);
    releaseWorker();
    assert.equal(new URL((await starting).authorizationUrl).searchParams.get("state"), delayedState);
    await assert.rejects(service.claim(delayedState, ticket), /已断开/);
    assert.equal(vault.getCredential("workspace-one"), null);
  } finally { vault.close(); }
});

test("lost refresh response keeps one persisted attempt and blocks stale token until a retry confirms rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-refresh-"));
  const path = join(directory, "vault.sqlite");
  const attempts: string[] = [];
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    attempts.push(body.attemptId);
    calls += 1;
    if (calls === 1) throw new Error("response lost after remote rotation");
    return Response.json({ ...credential, access_token: "access-rotated", refresh_token: "refresh-rotated" });
  };
  let vault = new NotionCredentialVault(path, key);
  try {
    vault.putPending(state, "verifier", Date.now() + 60_000);
    vault.storeClaimed(state, credential, new Date().toISOString());
    const service = new NotionOAuthService(origin, workerApiKey, vault, fetcher);
    await assert.rejects(service.refresh("workspace-one"), /待确认/);
    assert.equal(vault.list()[0]?.status, "refresh_pending");
    assert.equal(vault.getCredential("workspace-one"), null);
    vault.close();
    vault = new NotionCredentialVault(path, key);
    const resumed = new NotionOAuthService(origin, workerApiKey, vault, fetcher);
    assert.equal((await resumed.refresh("workspace-one")).status, "active");
    assert.deepEqual(attempts, [attempts[0], attempts[0]]);
    assert.equal(vault.getCredential("workspace-one")?.refresh_token, "refresh-rotated");
  } finally {
    vault.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicitly unavailable refresh requires reauthorization, and config requires an isolated vault key", async () => {
  const vault = new NotionCredentialVault(":memory:", key);
  try {
    vault.putPending(state, "verifier", Date.now() + 60_000);
    vault.storeClaimed(state, credential, new Date().toISOString());
    const fetcher: typeof fetch = async () => Response.json({ error: "refresh_unavailable" }, { status: 409 });
    const service = new NotionOAuthService(origin, workerApiKey, vault, fetcher);
    await assert.rejects(service.refresh("workspace-one"), /重新授权/);
    assert.equal(vault.list()[0]?.status, "reauthorization_required");
    assert.equal(vault.getCredential("workspace-one"), null);
  } finally { vault.close(); }
  assert.equal(loadConfig({}).notionOAuth, null);
  assert.throws(() => loadConfig({ NEWDAY_NOTION_WORKER_ORIGIN: origin }), /requires/);
  assert.throws(() => loadConfig({ NEWDAY_NOTION_WORKER_ORIGIN: "http://oauth.example.test", NEWDAY_NOTION_WORKER_API_KEY: workerApiKey, NEWDAY_NOTION_CREDENTIAL_KEY: key.toString("base64url") }), /HTTPS/);
  assert.throws(() => loadConfig({ NEWDAY_NOTION_WORKER_ORIGIN: origin, NEWDAY_NOTION_WORKER_API_KEY: workerApiKey, NEWDAY_NOTION_CREDENTIAL_KEY: "bad" }), /32-byte/);
  const valid = loadConfig({ NEWDAY_NOTION_WORKER_ORIGIN: origin, NEWDAY_NOTION_WORKER_API_KEY: workerApiKey, NEWDAY_NOTION_CREDENTIAL_KEY: key.toString("base64url") });
  assert.equal(valid.notionOAuth?.workerOrigin, origin);
});
