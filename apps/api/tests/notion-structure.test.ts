import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import { NotionSdkStructureGateway, type NotionStructureGateway, type StructureDatabase, type StructurePage,
  type StructureProperty } from "../src/services/notion-structure-gateway.js";
import { NotionCredentialVault } from "../src/storage/notion-credential-vault.js";

const workspaceId = "test-workspace";
const credentialKey = Buffer.alloc(32, 17);
const notionOAuth = (path: string) => ({ workerOrigin: "https://oauth.example.test", workerApiKey: "k".repeat(43),
  vaultPath: path, encryptionKey: credentialKey });

function seedVault(path: string) {
  const vault = new NotionCredentialVault(path, credentialKey);
  vault.putPending("s".repeat(43), "test verifier", Date.now() + 60_000);
  vault.storeClaimed("s".repeat(43), { access_token: "isolated-fake-access-token", refresh_token: "isolated-fake-refresh-token",
    bot_id: "test-bot", workspace_id: workspaceId, workspace_name: "隔离测试空间" }, new Date().toISOString());
  vault.close();
}

class FakeStructureGateway implements NotionStructureGateway {
  pages = new Map<string, StructurePage>();
  databases = new Map<string, StructureDatabase>();
  properties = new Map<string, Record<string, StructureProperty>>();
  creates = { root: 0, database: 0, relation: 0 };
  lostOnce: "root" | "projects" | "tasks_rule" | null = null;
  hideRootOnce = false;
  rateLimitRootOnce = false;
  rootLookups = 0;
  beforeCreateRoot: (() => Promise<void>) | null = null;

  async createRoot(token: string, title: string) {
    this.checkToken(token);
    if (this.beforeCreateRoot) await this.beforeCreateRoot();
    const id = `page-${++this.creates.root}`;
    if (this.rateLimitRootOnce) {
      this.rateLimitRootOnce = false;
      throw Object.assign(new Error("rate limited"), { status: 429, headers: new Headers({ "retry-after": "120" }) });
    }
    this.pages.set(id, { id, title, workspaceParent: true });
    if (this.lostOnce === "root") { this.lostOnce = null; throw new Error("response lost after create"); }
    return id;
  }
  async findRoots(token: string, title: string) {
    this.checkToken(token);
    this.rootLookups += 1;
    if (this.hideRootOnce) { this.hideRootOnce = false; return []; }
    return [...this.pages.values()].filter((page) => page.title === title).map((page) => page.id);
  }
  async getRoot(token: string, pageId: string) {
    this.checkToken(token);
    const page = this.pages.get(pageId);
    if (!page) throw new Error("missing page");
    return page;
  }
  async createDatabase(token: string, parentPageId: string, title: string, properties: Record<string, unknown>) {
    this.checkToken(token);
    const number = ++this.creates.database;
    const id = `db-${number}`;
    const dataSourceId = `ds-${number}`;
    this.databases.set(id, { id, title, parentPageId, dataSourceIds: [dataSourceId] });
    const normalized: Record<string, StructureProperty> = {};
    for (const [name, value] of Object.entries(properties)) {
      const entry = value as Record<string, { options?: Array<{ name: string }> }>;
      const type = Object.keys(entry)[0];
      normalized[name] = { id: `prop-${number}-${name}`, type,
        ...(entry[type]?.options ? { options: entry[type].options.map((option) => option.name) } : {}) };
    }
    this.properties.set(dataSourceId, normalized);
    if (title.toLowerCase() === this.lostOnce) { this.lostOnce = null; throw new Error("response lost after database create"); }
    return id;
  }
  async listChildDatabases(token: string, parentPageId: string) {
    this.checkToken(token);
    return [...this.databases.values()].filter((database) => database.parentPageId === parentPageId).map((database) => database.id);
  }
  async getDatabase(token: string, databaseId: string) {
    this.checkToken(token);
    const database = this.databases.get(databaseId);
    if (!database) throw new Error("missing database");
    return database;
  }
  async getDataSourceProperties(token: string, dataSourceId: string) {
    this.checkToken(token);
    const properties = this.properties.get(dataSourceId);
    if (!properties) throw new Error("missing data source");
    return properties;
  }
  async addRelation(token: string, dataSourceId: string, name: string, targetDataSourceId: string) {
    this.checkToken(token);
    this.creates.relation += 1;
    const properties = await this.getDataSourceProperties(token, dataSourceId);
    properties[name] = { id: `relation-${name}`, type: "relation", relationTarget: targetDataSourceId };
    if (name === "Rule" && this.lostOnce === "tasks_rule") { this.lostOnce = null; throw new Error("response lost after relation patch"); }
  }
  private checkToken(token: string) { assert.equal(token, "isolated-fake-access-token"); }
}

test("root response loss survives API restart; four databases and relations are read back once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-structure-"));
  const vaultPath = join(directory, "vault", "credentials.sqlite");
  const databasePath = join(directory, "planner.sqlite");
  seedVault(vaultPath);
  const fake = new FakeStructureGateway();
  fake.lostOnce = "root";
  let app = createApp({ databasePath, notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
  const advance = () => app.inject({ method: "POST", url: `/api/notion/connections/${workspaceId}/structure/advance`, payload: {} });
  try {
    const first = await advance();
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().state, "needs_review");
    assert.equal(first.json().reviewReason, "request_unknown");
    assert.equal(fake.creates.root, 1);
    await app.close();
    app = createApp({ databasePath, notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
    fake.hideRootOnce = true;
    assert.equal((await advance()).json().reviewReason, "not_found");
    assert.equal(fake.creates.root, 1);
    assert.equal((await advance()).json().completedSteps[0], "root");
    fake.lostOnce = "projects";
    let sawTableUncertainty = false;
    let sawRelationUncertainty = false;
    for (let i = 0; i < 14; i += 1) {
      const response = await advance();
      assert.equal(response.statusCode, 200);
      const progress = response.json();
      if (progress.state === "needs_review" && progress.reviewReason === "request_unknown") {
        if (progress.nextStep === "projects") sawTableUncertainty = true;
        if (progress.nextStep === "tasks_rule") sawRelationUncertainty = true;
      }
      if (progress.nextStep === "tasks_rule" && fake.lostOnce === null && !sawRelationUncertainty) fake.lostOnce = "tasks_rule";
      if (progress.state === "ready") break;
    }
    const result = (await app.inject(`/api/notion/connections/${workspaceId}/structure`)).json();
    assert.equal(result.state, "ready");
    assert.equal(result.completedSteps.length, 9);
    assert.equal(sawTableUncertainty, true);
    assert.equal(sawRelationUncertainty, true);
    assert.deepEqual(fake.creates, { root: 1, database: 4, relation: 4 });
    assert.equal(result.rootPageId, "page-1");
    for (const table of ["areas", "projects", "tasks", "rules"]) {
      assert.ok(result.dataSources[table].databaseId);
      assert.ok(result.dataSources[table].dataSourceId);
      assert.ok(result.dataSources[table].propertyIds.Name);
    }
    assert.equal(result.dataSources.projects.propertyIds.Area, "relation-Area");
    assert.equal(result.dataSources.tasks.propertyIds.Rule, "relation-Rule");
    const backup = (await app.inject("/api/planner/backup")).json();
    assert.equal(backup.version, 6);
    assert.equal(backup.notionSync.initializationSteps.length, 9);
    assert.equal(JSON.stringify(backup).includes("isolated-fake-access-token"), false);
    assert.equal(JSON.stringify(backup).includes("isolated-fake-refresh-token"), false);
    const restored = await app.inject({ method: "POST", url: "/api/planner/backup", payload: { source: JSON.stringify(backup) } });
    assert.equal(restored.statusCode, 200);
    const afterRestore = (await app.inject(`/api/notion/connections/${workspaceId}/structure`)).json();
    assert.equal(afterRestore.state, "paused_after_restore");
    assert.equal(afterRestore.completedSteps.length, 9);
    assert.equal((await advance()).statusCode, 409);
    assert.deepEqual(fake.creates, { root: 1, database: 4, relation: 4 });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("429 Retry-After blocks readback until due and never replays the create request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-structure-"));
  const vaultPath = join(directory, "vault.sqlite");
  seedVault(vaultPath);
  const fake = new FakeStructureGateway();
  fake.rateLimitRootOnce = true;
  let now = Date.parse("2026-09-21T00:00:00.000Z");
  const app = createApp({ databasePath: ":memory:", notionOAuth: notionOAuth(vaultPath),
    notionStructureGateway: fake, clock: () => now });
  try {
    const path = `/api/notion/connections/${workspaceId}/structure/advance`;
    const first = (await app.inject({ method: "POST", url: path, payload: {} })).json();
    assert.equal(first.state, "needs_review");
    assert.equal(first.reviewReason, "rate_limited");
    assert.equal(first.retryAfterAt, "2026-09-21T00:02:00.000Z");
    assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).json().reviewReason, "rate_limited");
    assert.equal(fake.rootLookups, 0);
    now += 120_001;
    assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).json().reviewReason, "not_found");
    assert.equal(fake.rootLookups, 1);
    assert.equal(fake.creates.root, 1);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ambiguous root search pauses without a second create", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-structure-"));
  const vaultPath = join(directory, "vault.sqlite");
  seedVault(vaultPath);
  const fake = new FakeStructureGateway();
  fake.lostOnce = "root";
  const app = createApp({ databasePath: ":memory:", notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
  try {
    const path = `/api/notion/connections/${workspaceId}/structure/advance`;
    assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).json().state, "needs_review");
    const first = [...fake.pages.values()][0];
    fake.pages.set("duplicate", { ...first, id: "duplicate" });
    const next = (await app.inject({ method: "POST", url: path, payload: {} })).json();
    assert.equal(next.reviewReason, "ambiguous");
    assert.equal(fake.creates.root, 1);
    assert.equal(fake.databases.size, 0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two simultaneous advances serialize remote steps for one workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-structure-"));
  const vaultPath = join(directory, "vault.sqlite");
  seedVault(vaultPath);
  const fake = new FakeStructureGateway();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fake.beforeCreateRoot = async () => { entered(); await gate; };
  const app = createApp({ databasePath: ":memory:", notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
  try {
    const path = `/api/notion/connections/${workspaceId}/structure/advance`;
    const first = app.inject({ method: "POST", url: path, payload: {} });
    await started;
    const second = app.inject({ method: "POST", url: path, payload: {} });
    release();
    assert.equal((await first).statusCode, 200);
    const result = await second;
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json().completedSteps, ["root", "areas"]);
    assert.deepEqual(fake.creates, { root: 1, database: 1, relation: 0 });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disconnect waits for an in-flight create and blocks later initialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-structure-"));
  const vaultPath = join(directory, "vault.sqlite");
  seedVault(vaultPath);
  const fake = new FakeStructureGateway();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fake.beforeCreateRoot = async () => { entered(); await gate; };
  const app = createApp({ databasePath: ":memory:", notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
  try {
    const path = `/api/notion/connections/${workspaceId}/structure/advance`;
    const first = app.inject({ method: "POST", url: path, payload: {} });
    await started;
    const disconnect = app.inject({ method: "POST", url: `/api/notion/connections/${workspaceId}/disconnect`, payload: {} });
    release();
    assert.equal((await first).statusCode, 200);
    assert.equal((await disconnect).json().removed, true);
    assert.equal((await app.inject(`/api/notion/connections/${workspaceId}/structure`)).json().state, "disconnected");
    assert.deepEqual((await app.inject("/api/notion/status")).json().connections, []);
    assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).statusCode, 409);
    const reauthorized = new NotionCredentialVault(vaultPath, credentialKey);
    try {
      const newState = "r".repeat(43);
      reauthorized.putPending(newState, "new verifier", Date.now() + 60_000);
      reauthorized.storeClaimed(newState, { access_token: "isolated-fake-access-token",
        refresh_token: "isolated-fake-refresh-token", bot_id: "test-bot",
        workspace_id: workspaceId, workspace_name: "隔离测试空间" }, new Date().toISOString());
    } finally { reauthorized.close(); }
    assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).statusCode, 409);
    assert.equal((await app.inject(`/api/notion/connections/${workspaceId}/structure`)).json().state, "disconnected");
    assert.deepEqual(fake.creates, { root: 1, database: 0, relation: 0 });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("database creation detects a matching sibling already under the root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-structure-"));
  const vaultPath = join(directory, "vault.sqlite");
  seedVault(vaultPath);
  const fake = new FakeStructureGateway();
  const app = createApp({ databasePath: ":memory:", notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
  try {
    const path = `/api/notion/connections/${workspaceId}/structure/advance`;
    const root = (await app.inject({ method: "POST", url: path, payload: {} })).json();
    fake.databases.set("legacy", { id: "legacy", title: "Areas", parentPageId: root.rootPageId,
      dataSourceIds: ["legacy-source"] });
    fake.properties.set("legacy-source", { Name: { id: "legacy-name", type: "title" } });
    const result = (await app.inject({ method: "POST", url: path, payload: {} })).json();
    assert.equal(result.state, "needs_review");
    assert.equal(result.reviewReason, "ambiguous");
    assert.deepEqual(fake.creates, { root: 1, database: 0, relation: 0 });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restoring a backup from before structure creation fences the prior root identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-restore-root-"));
  const vaultPath = join(directory, "vault.sqlite");
  const databasePath = join(directory, "planner.sqlite");
  seedVault(vaultPath);
  const fake = new FakeStructureGateway();
  let app = createApp({ databasePath, notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
  const path = `/api/notion/connections/${workspaceId}/structure/advance`;
  try {
    const before = (await app.inject("/api/planner/backup")).json();
    assert.deepEqual(before.notionSync.connections, []);
    assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).json().completedSteps[0], "root");
    assert.equal(fake.creates.root, 1);
    const restored = await app.inject({ method: "POST", url: "/api/planner/backup", payload: { source: JSON.stringify(before) } });
    assert.equal(restored.statusCode, 200);
    let progress = (await app.inject(`/api/notion/connections/${workspaceId}/structure`)).json();
    assert.equal(progress.state, "paused_after_restore");
    assert.equal(progress.rootPageId, "page-1");
    await app.close();
    app = createApp({ databasePath, notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
    progress = (await app.inject(`/api/notion/connections/${workspaceId}/structure`)).json();
    assert.equal(progress.state, "paused_after_restore");
    assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).statusCode, 409);
    assert.equal(fake.creates.root, 1);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a same-title database with invalid schema cannot be ignored as a duplicate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-invalid-sibling-"));
  const vaultPath = join(directory, "vault.sqlite");
  seedVault(vaultPath);
  const fake = new FakeStructureGateway();
  const app = createApp({ databasePath: ":memory:", notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
  const path = `/api/notion/connections/${workspaceId}/structure/advance`;
  try {
    const root = (await app.inject({ method: "POST", url: path, payload: {} })).json();
    fake.databases.set("wrong-schema", { id: "wrong-schema", title: "Areas", parentPageId: root.rootPageId,
      dataSourceIds: ["wrong-source"] });
    fake.properties.set("wrong-source", { Name: { id: "wrong-name", type: "rich_text" } });
    const progress = (await app.inject({ method: "POST", url: path, payload: {} })).json();
    assert.equal(progress.state, "needs_review");
    assert.equal(progress.reviewReason, "ambiguous");
    assert.deepEqual(progress.completedSteps, ["root"]);
    assert.equal(fake.creates.database, 0);
    const retried = (await app.inject({ method: "POST", url: path, payload: {} })).json();
    assert.equal(retried.reviewReason, "schema_mismatch");
    assert.equal(fake.creates.database, 0);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an existing relation is checked before any property update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-relation-preflight-"));
  const vaultPath = join(directory, "vault.sqlite");
  seedVault(vaultPath);
  const fake = new FakeStructureGateway();
  const app = createApp({ databasePath: ":memory:", notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
  const path = `/api/notion/connections/${workspaceId}/structure/advance`;
  try {
    let progress;
    for (let index = 0; index < 5; index += 1) progress = (await app.inject({ method: "POST", url: path, payload: {} })).json();
    const projectSource = progress.dataSources.projects.dataSourceId as string;
    const areaSource = progress.dataSources.areas.dataSourceId as string;
    const properties = fake.properties.get(projectSource)!;
    properties.Area = { id: "existing-area", type: "relation", relationTarget: "other-source" };
    progress = (await app.inject({ method: "POST", url: path, payload: {} })).json();
    assert.equal(progress.reviewReason, "schema_mismatch");
    assert.equal(fake.creates.relation, 0);
    assert.equal(properties.Area.relationTarget, "other-source");
    properties.Area = { ...properties.Area, relationTarget: areaSource };
    progress = (await app.inject({ method: "POST", url: path, payload: {} })).json();
    assert.equal(progress.completedSteps.at(-1), "projects_area");
    assert.equal(fake.creates.relation, 0);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an explicitly incomplete Notion root search cannot identify a unique page", async () => {
  const gateway = new NotionSdkStructureGateway();
  Object.assign(gateway, { client: () => ({ search: async () => ({
    results: [{ object: "page", id: "visible-page" }], has_more: false, next_cursor: null,
    request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
  }) }) });
  await assert.rejects(gateway.findRoots("fake-token", "NewDay (test)"), /incomplete/);
});
