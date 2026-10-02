import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { NotionConnection } from "@newday/core/contracts/notion-sync";
import { createApp } from "../src/app.js";
import { NotionCredentialVault } from "../src/storage/notion-credential-vault.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";
import type { NotionTaskPage, NotionTaskTransport } from "../src/services/notion-outbox-dispatcher.js";
import type { NotionReadGateway, TaskRow } from "../src/services/notion-read-gateway.js";

// Adapted from the release QA HTTP reproducer. All imports point at this
// candidate; success means a confirmed write, never a reproduced 409.
const at = "2026-09-22T00:00:00.000Z";
const workspaceId = "agent-import-workspace";
const syncPath = `/api/notion/connections/${workspaceId}/sync`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function connection(): NotionConnection {
  const source = (name: string) => ({ databaseId: `${name}-db`, dataSourceId: `${name}-src`, schemaFingerprint: "fixture", propertyIds: {} });
  return { workspaceId, installationId: "agent-import-install", rootPageId: "root", credentialRevision: 2,
    status: "active", updatedAt: at, dataSources: { areas: source("areas"), projects: source("projects"), rules: source("rules"), tasks: source("tasks") } };
}
async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "newday-agent-import-notion-"));
  const databasePath = join(directory, "planner.sqlite");
  const vaultPath = join(directory, "vault.sqlite");
  const key = Buffer.alloc(32, 7);
  const pages = new Map<string, NotionTaskPage>();
  const writes = { create: 0, update: 0 };
  const transport: NotionTaskTransport = {
    async findByClientKey(_connection, mapping) { return { complete: true, pages: [...pages.values()].filter((page) => page.clientKey === mapping.clientKey) }; },
    async readPage(_connection, mapping) { return pages.get(mapping.remotePageId ?? "") ?? null; },
    async createPage(_connection, mapping, fields) {
      writes.create += 1;
      const remotePageId = `remote-${mapping.localTaskId}`;
      pages.set(remotePageId, { workspaceId, dataSourceId: mapping.dataSourceId, remotePageId, clientKey: mapping.clientKey, fields, inTrash: false });
    },
    async updatePage(_connection, mapping, fields) {
      writes.update += 1;
      const page = pages.get(mapping.remotePageId!);
      assert.ok(page);
      pages.set(page.remotePageId, { ...page, fields: { ...page.fields, ...fields } });
    },
  };
  const gateway: NotionReadGateway = {
    async scan(_token, _connection, table) {
      if (table !== "tasks") return [];
      return [...pages.values()].map((page): TaskRow => ({ id: page.remotePageId, url: `https://www.notion.so/${page.remotePageId}`,
        createdAt: at, editedAt: at, inTrash: false, kind: "task", title: page.fields.title,
        date: page.fields.date, completed: page.fields.completed, projectIds: [], directAreaIds: [], ruleIds: [],
        clientKey: page.clientKey, occurrenceKey: null }));
    },
    async readKnownPage(_token, id) { return pages.has(id) ? { id, inTrash: false } : null; },
  };
  const options = { databasePath, planningModel: null, notionOAuth: {
    workerOrigin: "https://unit.invalid", workerApiKey: "x".repeat(43), encryptionKey: key, vaultPath,
  }, notionTaskTransport: transport, notionReadGateway: gateway };
  let app = createApp(options);
  await app.ready();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const store = new SQLitePlannerStore(databasePath);
  const vault = new NotionCredentialVault(vaultPath, key);
  const state = "s".repeat(43);
  vault.putPending(state, "fixture verifier", Date.parse(at) + 60_000, Date.parse(at));
  vault.storeClaimed(state, { access_token: "fixture-access", refresh_token: "fixture-refresh", bot_id: "bot", workspace_id: workspaceId, workspace_name: "isolated" }, at);
  vault.close();
  await store.putNotionConnection(connection());
  await store.putNotionScanWatermark({ workspaceId, dataSourceId: "tasks-src", completedThrough: at,
    lastAttemptAt: at, lastSuccessAt: at, lastError: null, lastErrorAt: null });
  t.after(async () => { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const post = (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: "POST", url, payload });
  const importAgent = async (importPreferences = false) => {
    const exported = await app.inject("/api/agent/backup");
    assert.equal(exported.statusCode, 200, exported.body);
    const imported = await post("/api/agent/backup", { source: exported.body, importPreferences });
    assert.equal(imported.statusCode, 200, imported.body);
    return imported.json();
  };
  const create = async (id = "linked-task") => {
    const response = await app.inject({ method: "POST", url: "/api/planner/commands", headers: { "x-newday-client": "agent-import-test" },
      payload: { commands: [{ type: "createTask", input: { id, title: "Keep this intent", startDate: "2026-09-22", endDate: "2026-09-22", now: at, notionWorkspaceId: workspaceId } }] } });
    assert.equal(response.statusCode, 200, response.body);
    return (await store.listNotionOutboxOperations()).find((operation) => operation.localTaskId === id)!;
  };
  return { store, transport, gateway, writes, pages, post, create, importAgent,
    get: (url: string) => app.inject(url),
    async reopen() { await app.close(); app = createApp(options); await app.ready(); await new Promise<void>((resolve) => setImmediate(resolve)); },
  };
}

for (const importPreferences of [false, true]) {
test(`ND-QA-02: HTTP Agent import with preferences=${importPreferences} preserves pending intent across pause/resume and API restart`, async (t) => {
  const h = await setup(t);
  const operation = await h.create();
  const version = await h.store.getPlanningVersion();
  const imported = await h.importAgent(importPreferences);
  assert.equal(imported.datasetEpoch, version.datasetEpoch, "Agent-only import must not replace the task/Notion dataset");
  assert.deepEqual(await h.store.getPlanningVersion(), version);
  assert.deepEqual(await h.store.getNotionOutboxOperation(operation.operationId), operation);
  assert.equal((await h.post(`${syncPath}/pause`)).statusCode, 200);
  await h.reopen();
  assert.equal((await h.get(syncPath)).json().connectionStatus, "paused");
  assert.equal((await h.post(`${syncPath}/resume`)).statusCode, 200);
  const drained = await h.post(`${syncPath}/drain`);
  assert.equal(drained.statusCode, 200, drained.body);
  assert.equal(drained.json().operations[0].status, "confirmed");
  assert.deepEqual(h.writes, { create: 1, update: 0 });
  const scan = await h.post(`/api/notion/connections/${workspaceId}/read/scan`);
  assert.equal(scan.statusCode, 200, scan.body);
  assert.equal(scan.json().connectionStatus, "active");
  assert.equal((await h.store.getTask("linked-task"))?.title, "Keep this intent");
  assert.deepEqual(await h.store.listNotionRestoreQuarantine(), []);
});
}

for (const phase of ["preflight", "write"] as const) {
  test(`ND-QA-02: Agent HTTP import during Notion ${phase} preserves the in-flight send and confirms once`, async (t) => {
    const h = await setup(t);
    const operation = await h.create();
    const entered = deferred();
    const released = deferred();
    t.after(released.resolve);
    if (phase === "preflight") {
      const original = h.transport.findByClientKey;
      let first = true;
      h.transport.findByClientKey = async (...args) => {
        if (first) { first = false; entered.resolve(); await released.promise; }
        return original(...args);
      };
    } else {
      const original = h.transport.createPage;
      h.transport.createPage = async (...args) => { await original(...args); entered.resolve(); await released.promise; };
    }
    const drained = h.post(`${syncPath}/drain`);
    await entered.promise;
    assert.equal((await h.store.getNotionOutboxOperation(operation.operationId))?.status, "sending");
    await h.importAgent();
    released.resolve();
    const result = await drained;
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().operations[0].status, "confirmed");
    assert.equal(result.json().connectionStatus, "active");
    assert.deepEqual(h.writes, { create: 1, update: 0 });
  });
}

test("ND-QA-02: importing Agent history preserves unknown writes and only read-only reconciliation can settle them after restart", async (t) => {
  const h = await setup(t);
  const operation = await h.create();
  const create = h.transport.createPage;
  let hidePages = true;
  const find = h.transport.findByClientKey;
  h.transport.findByClientKey = async (...args) => hidePages ? { complete: true, pages: [] } : find(...args);
  h.transport.createPage = async (...args) => { await create(...args); throw new Error("success response lost"); };
  const first = await h.post(`${syncPath}/drain`);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().operations[0].status, "unknown");
  const before = await h.store.getNotionOutboxOperation(operation.operationId);
  await h.importAgent(true);
  await h.reopen();
  assert.deepEqual(await h.store.getNotionOutboxOperation(operation.operationId), before);
  assert.equal((await h.post(`${syncPath}/resume`)).statusCode, 409);
  assert.equal((await h.post(`${syncPath}/drain`)).statusCode, 409);
  const unresolved = await h.post(`${syncPath}/operations/${operation.operationId}/reconcile`);
  assert.equal(unresolved.statusCode, 200, unresolved.body);
  assert.equal(unresolved.json().operations[0].status, "unknown");
  hidePages = false;
  const settled = await h.post(`${syncPath}/operations/${operation.operationId}/reconcile`);
  assert.equal(settled.statusCode, 200, settled.body);
  assert.equal(settled.json().operations[0].status, "confirmed");
  assert.equal((await h.post(`${syncPath}/resume`)).statusCode, 200);
  assert.equal((await h.post(`${syncPath}/drain`)).statusCode, 200);
  assert.deepEqual(h.writes, { create: 1, update: 0 });
});

test("ND-QA-02: an in-flight Notion read remains valid across an Agent-only import", async (t) => {
  const h = await setup(t);
  await h.create();
  assert.equal((await h.post(`${syncPath}/drain`)).statusCode, 200);
  const version = await h.store.getPlanningVersion();
  const entered = deferred();
  const released = deferred();
  t.after(released.resolve);
  const scan = h.gateway.scan;
  h.gateway.scan = async (...args) => { if (args[2] === "tasks") { entered.resolve(); await released.promise; } return scan(...args); };
  const reading = h.post(`/api/notion/connections/${workspaceId}/read/scan`);
  await entered.promise;
  await h.importAgent();
  released.resolve();
  const result = await reading;
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().connectionStatus, "active");
  assert.equal(result.json().sources.find((item: { table: string }) => item.table === "tasks").watermark.lastError, null);
  assert.equal((await h.store.getPlanningVersion()).datasetEpoch, version.datasetEpoch);
  assert.deepEqual(h.writes, { create: 1, update: 0 });
});
