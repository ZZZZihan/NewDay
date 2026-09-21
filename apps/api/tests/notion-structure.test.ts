import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import { NotionSdkStructureGateway, type NotionStructureGateway, type StructureDatabase, type StructurePage,
  type StructureProperty } from "../src/services/notion-structure-gateway.js";
import { NotionCredentialVault } from "../src/storage/notion-credential-vault.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";

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
  beforeGetRoot: (() => Promise<void>) | null = null;
  beforeGetDatabase: (() => Promise<void>) | null = null;
  databaseReads = 0;

  async createRoot(token: string, title: string) {
    this.checkToken(token);
    if (this.beforeCreateRoot) await this.beforeCreateRoot();
    const id = `page-${++this.creates.root}`;
    if (this.rateLimitRootOnce) {
      this.rateLimitRootOnce = false;
      throw Object.assign(new Error("rate limited"), { status: 429, headers: new Headers({ "retry-after": "120" }) });
    }
    this.pages.set(id, { id, title, workspaceParent: true, inTrash: false });
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
    if (this.beforeGetRoot) await this.beforeGetRoot();
    const page = this.pages.get(pageId);
    if (!page) throw new Error("missing page");
    return page;
  }
  async createDatabase(token: string, parentPageId: string, title: string, properties: Record<string, unknown>) {
    this.checkToken(token);
    const number = ++this.creates.database;
    const id = `db-${number}`;
    const dataSourceId = `ds-${number}`;
    this.databases.set(id, { id, title, parentPageId, dataSourceIds: [dataSourceId], inTrash: false });
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
    this.databaseReads += 1;
    if (this.beforeGetDatabase) await this.beforeGetDatabase();
    const database = this.databases.get(databaseId);
    if (!database) throw new Error("missing database");
    return database;
  }
  async getDataSourceProperties(token: string, dataSourceId: string, databaseId: string) {
    this.checkToken(token);
    assert.ok(this.databases.get(databaseId)?.dataSourceIds.includes(dataSourceId));
    const properties = this.properties.get(dataSourceId);
    if (!properties) throw new Error("missing data source");
    return properties;
  }
  async addRelation(token: string, dataSourceId: string, name: string, targetDataSourceId: string) {
    this.checkToken(token);
    this.creates.relation += 1;
    const databaseId = [...this.databases.values()].find((database) =>
      database.dataSourceIds.includes(dataSourceId))?.id;
    assert.ok(databaseId);
    const properties = await this.getDataSourceProperties(token, dataSourceId, databaseId);
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
    const plannerStore = new SQLitePlannerStore(databasePath);
    try {
      const connection = await plannerStore.getNotionConnection(workspaceId);
      assert.ok(connection);
      await plannerStore.putNotionConnection({ ...connection, status: "paused",
        pauseReason: "preflight_read", updatedAt: new Date().toISOString() });
      assert.equal((await app.inject(`/api/notion/connections/${workspaceId}/structure`)).json().state, "ready");
      assert.equal((await app.inject(`/api/notion/connections/${workspaceId}/read`)).json().pauseReason, "preflight_read");
      assert.equal((await app.inject(`/api/notion/connections/${workspaceId}/sync`)).json().pauseReason, "preflight_read");
      await plannerStore.putNotionConnection({ ...connection, status: "active", updatedAt: new Date().toISOString() });
    } finally { plannerStore.close(); }
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

test("restored structure review checks exact remote identities and never releases synchronization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-restore-verify-"));
  const vaultPath = join(directory, "vault.sqlite");
  const databasePath = join(directory, "planner.sqlite");
  seedVault(vaultPath);
  const fake = new FakeStructureGateway();
  const app = createApp({ databasePath, notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
  const base = `/api/notion/connections/${workspaceId}/structure`;
  const verify = () => app.inject({ method: "POST", url: `${base}/restore/verify`, payload: {} });
  try {
    for (let index = 0; index < 9; index += 1) {
      const result = await app.inject({ method: "POST", url: `${base}/advance`, payload: {} });
      assert.equal(result.statusCode, 200, result.body);
    }
    const backup = (await app.inject("/api/planner/backup")).json();
    const restored = await app.inject({ method: "POST", url: "/api/planner/backup",
      payload: { source: JSON.stringify(backup) } });
    assert.equal(restored.statusCode, 200, restored.body);
    const store = new SQLitePlannerStore(databasePath);
    try {
      const version = await store.getPlanningVersion();
      const good = await verify();
      assert.equal(good.statusCode, 200, good.body);
      assert.equal(good.json().outcome, "matches");
      assert.equal(good.json().checks.length, 9);
      assert.ok(good.json().checks.every((check: { result: string }) => check.result === "matches"));
      assert.deepEqual(await store.getPlanningVersion(), version);
      assert.deepEqual(fake.creates, { root: 1, database: 4, relation: 4 });
      assert.equal((await app.inject(base)).json().state, "paused_after_restore");
      assert.equal((await app.inject(`/api/notion/connections/${workspaceId}/sync`)).json().connectionStatus,
        "paused_after_restore");
      assert.equal((await app.inject({ method: "POST", url: `${base}/advance`, payload: {} })).statusCode, 409);
      assert.equal((await app.inject({ method: "POST", url: `/api/notion/connections/${workspaceId}/sync/resume`,
        payload: {} })).statusCode, 409);

      const priorDatabaseReads = fake.databaseReads;
      fake.beforeGetRoot = async () => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      };
      const throttled = (await verify()).json();
      assert.equal(throttled.outcome, "needs_review");
      assert.equal(throttled.checks[0].result, "rate_limited");
      assert.ok(throttled.checks.slice(1).every((check: { result: string }) => check.result === "not_checked"));
      assert.equal(fake.databaseReads, priorDatabaseReads, "one 429 must stop further remote reads");
      fake.beforeGetRoot = null;

      const tasks = fake.databases.get("db-3")!;
      fake.databases.set(tasks.id, { ...tasks, dataSourceIds: ["different-source"] });
      const wrongSource = (await verify()).json();
      assert.equal(wrongSource.outcome, "needs_review");
      assert.deepEqual(wrongSource.checks.find((check: { step: string }) => check.step === "tasks"),
        { step: "tasks", result: "identity_mismatch" });
      fake.databases.set(tasks.id, tasks);

      const taskProperties = fake.properties.get("ds-3")!;
      const oldRelation = taskProperties.Rule;
      taskProperties.Rule = { ...oldRelation, relationTarget: "different-source" };
      const wrongRelation = (await verify()).json();
      assert.equal(wrongRelation.outcome, "needs_review");
      assert.deepEqual(wrongRelation.checks.find((check: { step: string }) => check.step === "tasks_rule"),
        { step: "tasks_rule", result: "schema_mismatch" });
      taskProperties.Rule = oldRelation;

      const root = fake.pages.get("page-1")!;
      fake.pages.set(root.id, { ...root, inTrash: true });
      const trashed = (await verify()).json();
      assert.deepEqual(trashed.checks.find((check: { step: string }) => check.step === "root"),
        { step: "root", result: "trashed" });
      assert.deepEqual(fake.creates, { root: 1, database: 4, relation: 4 });
      assert.deepEqual(await store.getPlanningVersion(), version);
      assert.equal((await app.inject(base)).json().state, "paused_after_restore");
    } finally { store.close(); }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("restore structure review rejects a backup replacement during remote readback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-restore-stale-"));
  const vaultPath = join(directory, "vault.sqlite");
  const databasePath = join(directory, "planner.sqlite");
  seedVault(vaultPath);
  const fake = new FakeStructureGateway();
  const app = createApp({ databasePath, notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
  const base = `/api/notion/connections/${workspaceId}/structure`;
  try {
    for (let index = 0; index < 9; index += 1) {
      assert.equal((await app.inject({ method: "POST", url: `${base}/advance`, payload: {} })).statusCode, 200);
    }
    const backup = (await app.inject("/api/planner/backup")).json();
    assert.equal((await app.inject({ method: "POST", url: "/api/planner/backup",
      payload: { source: JSON.stringify(backup) } })).statusCode, 200);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fake.beforeGetDatabase = async () => { fake.beforeGetDatabase = null; entered(); await gate; };
    const review = app.inject({ method: "POST", url: `${base}/restore/verify`, payload: {} });
    await started;
    try {
      const replacement = await app.inject({ method: "POST", url: "/api/planner/backup",
        payload: { source: JSON.stringify(backup) } });
      assert.equal(replacement.statusCode, 200, replacement.body);
    } finally { release(); }
    const result = await review;
    assert.equal(result.statusCode, 409, result.body);
    assert.equal((await app.inject(base)).json().state, "paused_after_restore");
    assert.deepEqual(fake.creates, { root: 1, database: 4, relation: 4 });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a stale structure review cannot advance into the next remote create step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-review-"));
  const vaultPath = join(directory, "vault.sqlite");
  seedVault(vaultPath);
  const fake = new FakeStructureGateway();
  fake.lostOnce = "root";
  const app = createApp({ databasePath: ":memory:", notionOAuth: notionOAuth(vaultPath), notionStructureGateway: fake });
  try {
    const base = `/api/notion/connections/${workspaceId}/structure`;
    const first = await app.inject({ method: "POST", url: `${base}/advance`, payload: {} });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().state, "needs_review");
    assert.equal(first.json().nextStep, "root");
    const staleReview = { step: first.json().nextStep, attemptedAt: first.json().reviewAttemptedAt };
    assert.ok(staleReview.attemptedAt);
    const [confirmed, stale] = await Promise.all([
      app.inject({ method: "POST", url: `${base}/reconcile`, payload: staleReview }),
      app.inject({ method: "POST", url: `${base}/reconcile`, payload: staleReview }),
    ]);
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().nextStep, "areas");
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(fake.creates.root, 1);
    assert.equal(fake.creates.database, 0, "a stale review must not create Areas");
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
      dataSourceIds: ["legacy-source"], inTrash: false });
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
      dataSourceIds: ["wrong-source"], inTrash: false });
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

test("SDK data source readback rejects a different ID or parent database", async () => {
  const gateway = new NotionSdkStructureGateway();
  let response: { object: string; id: string; in_trash: boolean;
    parent: { type: string; database_id: string; data_source_id?: string };
    properties: { Name: { id: string; type: string } } } = { object: "data_source", id: "other-source", in_trash: false,
    parent: { type: "database_id", database_id: "db-1" },
    properties: { Name: { id: "name-id", type: "title" } } };
  Object.assign(gateway, { client: () => ({ dataSources: { retrieve: async () => response } }) });
  await assert.rejects(gateway.getDataSourceProperties("fake-token", "source-1", "db-1"), /inaccessible data source/);
  response = { ...response, id: "source-1", parent: { type: "database_id", database_id: "db-2" } };
  await assert.rejects(gateway.getDataSourceProperties("fake-token", "source-1", "db-1"), /inaccessible data source/);
  response = { ...response, parent: { type: "data_source_id", data_source_id: "other-parent", database_id: "db-1" } };
  await assert.rejects(gateway.getDataSourceProperties("fake-token", "source-1", "db-1"), /inaccessible data source/);
  response = { ...response, parent: { type: "database_id", database_id: "db-1" } };
  assert.deepEqual(await gateway.getDataSourceProperties("fake-token", "source-1", "db-1"),
    { Name: { id: "name-id", type: "title" } });
});

test("SDK page and database readback reject a different object ID", async () => {
  const gateway = new NotionSdkStructureGateway();
  Object.assign(gateway, { client: () => ({
    pages: { retrieve: async () => ({ id: "other-page", parent: { type: "workspace", workspace: true },
      properties: { title: { title: [] } }, in_trash: false }) },
    databases: { retrieve: async () => ({ id: "other-db", parent: { type: "page_id", page_id: "root" },
      title: [], data_sources: [], in_trash: false }) },
  }) });
  await assert.rejects(gateway.getRoot("fake-token", "expected-page"), /inaccessible root page/);
  await assert.rejects(gateway.getDatabase("fake-token", "expected-db"), /incomplete database/);
});
