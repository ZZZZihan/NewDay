import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Client } from "@notionhq/client";

import type { NotionConnection, NotionTaskFields } from "@newday/core/contracts/notion-sync";

import { NotionOutboxDispatcher, type NotionTaskPage, type NotionTaskTransport } from "../src/services/notion-outbox-dispatcher.js";
import { createApp } from "../src/app.js";
import { NotionSyncService } from "../src/services/notion-sync-service.js";
import { PlannerService } from "../src/services/planner-service.js";
import { NotionSdkTaskTransport } from "../src/services/notion-task-transport.js";
import { NotionCredentialVault } from "../src/storage/notion-credential-vault.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";

const at = "2026-09-21T00:00:00.000Z";
const workspaceId = "test-workspace";
const taskId = "linked-task";
const initial: NotionTaskFields = { title: "第一项", date: ["2026-09-21", "2026-09-21"], completed: false };

function connection(): NotionConnection {
  const source = (name: string) => {
    const propertyIds: Record<string, string> = name === "tasks"
      ? { Name: "title", "Plan Date": "date", Completed: "done", "NewDay Key": "key" } : {};
    return { databaseId: `${name}-db`, dataSourceId: `${name}-source`,
      schemaFingerprint: "test-fingerprint", propertyIds };
  };
  return { workspaceId, installationId: "test-installation", rootPageId: "test-root",
    status: "active", updatedAt: at, dataSources: {
      areas: source("areas"), projects: source("projects"), tasks: source("tasks"), rules: source("rules"),
    } };
}

async function seedReady(store: SQLitePlannerStore) {
  await store.putNotionConnection(connection());
  await store.putNotionScanWatermark({ workspaceId, dataSourceId: "tasks-source",
    completedThrough: at, lastAttemptAt: at, lastSuccessAt: at, lastError: null, lastErrorAt: null });
}

function transport() {
  let page: NotionTaskPage | null = null;
  const writes: Array<{ kind: "create" | "update"; fields: Partial<NotionTaskFields> }> = [];
  const fake: NotionTaskTransport = {
    async findByClientKey(_connection, mapping) {
      return { complete: true, pages: page?.clientKey === mapping.clientKey ? [page] : [] };
    },
    async readPage(_connection, mapping) {
      return page?.remotePageId === mapping.remotePageId ? page : null;
    },
    async createPage(_connection, mapping, fields) {
      writes.push({ kind: "create", fields });
      page = { workspaceId, dataSourceId: mapping.dataSourceId, remotePageId: "remote-task",
        clientKey: mapping.clientKey, fields, inTrash: false };
    },
    async updatePage(_connection, _mapping, patch) {
      writes.push({ kind: "update", fields: patch });
      if (!page) throw new Error("Remote page was not created");
      page = { ...page, fields: { ...page.fields, ...patch } };
    },
  };
  return { fake, writes, getPage: () => page };
}

test("opt-in task creation commits its mapping and intent, then confirms one remote page", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const remote = transport();
  try {
    await store.putNotionConnection(connection());
    const planner = new PlannerService(store, () => Date.parse(at));
    await assert.rejects(planner.commands([{ type: "createTask", input: {
      id: "before-scan", title: "不能提前创建", startDate: "2026-09-21",
      endDate: "2026-09-21", now: at, notionWorkspaceId: workspaceId,
    } }], "test-client"), /首次成功扫描/);
    assert.equal(await store.getTask("before-scan"), undefined);
    await seedReady(store);
    await assert.rejects(planner.commands([{ type: "createTask", input: {
      id: "wrong-workspace", title: "不能创建", startDate: "2026-09-21", endDate: "2026-09-21",
      now: at, notionWorkspaceId: "missing",
    } }], "test-client"), /工作区尚未准备好/);
    assert.equal(await store.getTask("wrong-workspace"), undefined);

    await assert.rejects(planner.commands([
      { type: "createTask", input: { id: "rolled-back", title: "回滚", startDate: "2026-09-21",
        endDate: "2026-09-21", now: at, notionWorkspaceId: workspaceId } },
      { type: "rescheduleTask", input: { taskId: "absent", startDate: "2026-09-22",
        endDate: "2026-09-22", now: at } },
    ], "test-client"), /任务不存在/);
    assert.equal(await store.getTask("rolled-back"), undefined);
    assert.equal(await store.getNotionTaskMapping("rolled-back"), undefined);
    assert.deepEqual(await store.listNotionOutboxOperations(), []);

    await assert.rejects(planner.commands([
      { type: "createTask", input: { id: "deleted-in-batch", title: "不留下幽灵任务",
        startDate: "2026-09-21", endDate: "2026-09-21", now: at,
        notionWorkspaceId: workspaceId } },
      { type: "deleteTask", input: { taskId: "deleted-in-batch", now: at } },
    ], "test-client"), /只支持一次性任务操作/);
    assert.equal(await store.getTask("deleted-in-batch"), undefined);

    const created = await planner.commands([{ type: "createTask", input: {
      id: taskId, title: initial.title, startDate: initial.date![0], endDate: initial.date![1],
      now: at, notionWorkspaceId: workspaceId,
    } }], "test-client");
    assert.equal(created.receipt, null, "a remote create cannot be undone as a local-only deletion");
    const mapping = await store.getNotionTaskMapping(taskId);
    assert.equal(mapping?.status, "pending_create");
    assert.equal(mapping?.remotePageId, null);
    assert.equal((await store.listNotionOutboxOperations()).length, 1);
    const sync = new NotionSyncService(store, new NotionOutboxDispatcher(store, remote.fake, () => at));
    const status = await sync.drain(workspaceId);
    assert.equal(status.operations[0]?.status, "confirmed");
    assert.equal((await store.getNotionTaskMapping(taskId))?.remotePageId, "remote-task");
    assert.deepEqual(remote.getPage()?.fields, initial);
    assert.deepEqual(remote.writes.map((write) => write.kind), ["create"]);
  } finally { store.close(); }
});

test("a failed remote preflight pauses sending but keeps later linked local changes durable", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await seedReady(store);
    const planner = new PlannerService(store, () => Date.parse(at));
    await planner.commands([{ type: "createTask", input: { id: "offline-one", title: "初稿",
      startDate: "2026-09-21", endDate: "2026-09-21", now: at,
      notionWorkspaceId: workspaceId } }], "test-client");
    const remote = transport();
    remote.fake.findByClientKey = async () => { throw new Error("offline before write"); };
    const sync = new NotionSyncService(store, new NotionOutboxDispatcher(store, remote.fake, () => at));
    await sync.drain(workspaceId);
    assert.equal((await store.getNotionConnection(workspaceId))?.status, "paused");
    assert.equal(remote.writes.length, 0);

    await planner.commands([{ type: "updateTaskDetails", input: {
      taskId: "offline-one", title: "离线改名", now: at,
    } }], "test-client");
    await store.putNotionScanWatermark({ workspaceId, dataSourceId: "tasks-source",
      completedThrough: at, lastAttemptAt: at, lastSuccessAt: at,
      lastError: "local", lastErrorAt: at });
    await planner.commands([{ type: "createTask", input: { id: "offline-two", title: "离线新任务",
      startDate: "2026-09-22", endDate: "2026-09-22", now: at,
      notionWorkspaceId: workspaceId } }], "test-client");
    assert.equal((await store.getTask("offline-one"))?.title, "离线改名");
    assert.equal((await store.getTask("offline-two"))?.title, "离线新任务");
    const pending = (await store.listNotionOutboxOperations()).filter((item) => item.status === "pending");
    assert.equal(pending.length, 2);
    assert.equal(pending.find((item) => item.localTaskId === "offline-one")?.desired.title, "离线改名");
    assert.equal(pending.find((item) => item.localTaskId === "offline-two")?.desired.title, "离线新任务");
    assert.equal(remote.writes.length, 0);
    await sync.resume(workspaceId);
    assert.equal((await store.getNotionConnection(workspaceId))?.status, "active");
    assert.equal((await store.getNotionConnection(workspaceId))?.pauseReason, undefined);
  } finally { store.close(); }
});

test("SDK write preflight refuses a page when Rules source readability is lost", async () => {
  const credentials = new NotionCredentialVault(":memory:", Buffer.alloc(32, 31));
  try {
    const state = "s".repeat(43);
    credentials.putPending(state, "verifier", Date.parse(at) + 60_000, Date.parse(at));
    credentials.storeClaimed(state, { access_token: "test-access", refresh_token: "test-refresh",
      bot_id: "test-bot", workspace_id: workspaceId, workspace_name: "隔离测试" }, at);
    const base = connection();
    const configured = { ...base, dataSources: { ...base.dataSources,
      rules: { ...base.dataSources.rules!, propertyIds: { Name: "rule-title" } } } };
    let taskPageRead = false;
    const fakeClient = { dataSources: {
      async retrieve() { return { properties: { Name: { id: "rule-title", type: "title" } } }; },
      async query() { throw new Error("Rules access denied"); },
    }, pages: { async retrieve() { taskPageRead = true; throw new Error("should not read task"); } } } as unknown as Client;
    const sdk = new NotionSdkTaskTransport(credentials, () => fakeClient);
    await assert.rejects(sdk.readPage(configured, { localTaskId: taskId, workspaceId,
      dataSourceId: "tasks-source", remotePageId: "remote-task", clientKey: "client-key",
      baseline: initial, status: "active", updatedAt: at }), /Rules access denied/);
    assert.equal(taskPageRead, false);
  } finally { credentials.close(); }
});

test("linked edits and undo enqueue the final intent without a stale remote write", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const remote = transport();
  try {
    await seedReady(store);
    const planner = new PlannerService(store, () => Date.parse(at));
    await planner.commands([{ type: "createTask", input: { id: taskId, title: initial.title,
      startDate: initial.date![0], endDate: initial.date![1], now: at,
      notionWorkspaceId: workspaceId } }], "test-client");
    const sync = new NotionSyncService(store, new NotionOutboxDispatcher(store, remote.fake, () => at));
    await sync.drain(workspaceId);

    const edit = await planner.commands([
      { type: "updateTaskDetails", input: { taskId, title: "改名", now: at } },
      { type: "rescheduleTask", input: { taskId, startDate: "2026-09-22", endDate: "2026-09-22", now: at } },
    ], "test-client");
    assert.ok(edit.receipt);
    assert.equal((await store.listNotionOutboxOperations()).filter((item) => item.status === "pending").length, 1);
    await planner.undo(edit.receipt!, "test-client");
    const operations = await store.listNotionOutboxOperations();
    assert.equal(operations.filter((item) => item.status === "superseded").length, 1);
    assert.deepEqual(operations.find((item) => item.status === "pending")?.desired, initial);
    await sync.drain(workspaceId);
    assert.deepEqual(remote.writes.map((write) => write.kind), ["create"]);
    assert.deepEqual(remote.getPage()?.fields, initial);

    await planner.commands([{ type: "completeTask", input: { taskId, now: at, asOfDate: "2026-09-21" } }], "test-client");
    await sync.drain(workspaceId);
    assert.equal(remote.getPage()?.fields.completed, true);
    await planner.commands([{ type: "reopenTask", input: { taskId, now: at } }], "test-client");
    await sync.drain(workspaceId);
    assert.equal(remote.getPage()?.fields.completed, false);
    assert.deepEqual(remote.writes.map((write) => write.kind), ["create", "update", "update"]);
  } finally { store.close(); }
});

test("HTTP command and sync status routes expose a confirmed write across the SQLite boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-write-"));
  const databasePath = join(directory, "planner.sqlite");
  const seed = new SQLitePlannerStore(databasePath);
  await seedReady(seed);
  seed.close();
  const remote = transport();
  const app = createApp({ databasePath, planningModel: null, notionTaskTransport: remote.fake,
    notionOAuth: { workerOrigin: "https://worker.example", workerApiKey: "test-key",
      vaultPath: join(directory, "vault.sqlite"), encryptionKey: Buffer.alloc(32, 17) } });
  try {
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/api/planner/commands",
      headers: { "x-newday-client": "test-browser" }, payload: { commands: [{ type: "createTask",
        input: { id: taskId, title: initial.title, startDate: initial.date![0], endDate: initial.date![1],
          now: at, notionWorkspaceId: workspaceId } }] } });
    assert.equal(created.statusCode, 200, created.body);
    const before = await app.inject({ method: "GET", url: `/api/notion/connections/${workspaceId}/sync` });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().operations[0].status, "pending");
    const sent = await app.inject({ method: "POST", url: `/api/notion/connections/${workspaceId}/sync/drain`,
      payload: {} });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(sent.json().operations[0].status, "confirmed");
    assert.deepEqual(remote.getPage()?.fields, initial);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("HTTP pause persists a send fence until explicit resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-pause-"));
  const databasePath = join(directory, "planner.sqlite");
  const seed = new SQLitePlannerStore(databasePath);
  await seedReady(seed);
  seed.close();
  const remote = transport();
  const app = createApp({ databasePath, planningModel: null, notionTaskTransport: remote.fake,
    notionOAuth: { workerOrigin: "https://worker.example", workerApiKey: "test-key",
      vaultPath: join(directory, "vault.sqlite"), encryptionKey: Buffer.alloc(32, 18) } });
  try {
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/api/planner/commands",
      headers: { "x-newday-client": "test-browser" }, payload: { commands: [{ type: "createTask",
        input: { id: "paused-task", title: "待暂停", startDate: "2026-09-21", endDate: "2026-09-21",
          now: at, notionWorkspaceId: workspaceId } }] } });
    assert.equal(created.statusCode, 200, created.body);
    const pause = await app.inject({ method: "POST", url: `/api/notion/connections/${workspaceId}/sync/pause`, payload: {} });
    assert.equal(pause.statusCode, 200, pause.body);
    assert.equal(pause.json().pauseReason, "manual");
    const blocked = await app.inject({ method: "POST", url: `/api/notion/connections/${workspaceId}/sync/drain`, payload: {} });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(pause.json().operations.find((item: { localTaskId: string }) => item.localTaskId === "paused-task")?.status,
      "pending");
    assert.deepEqual(remote.writes, []);
    const observer = new SQLitePlannerStore(databasePath);
    try { assert.equal((await observer.getNotionConnection(workspaceId))?.pauseReason, "manual"); }
    finally { observer.close(); }
    const resume = await app.inject({ method: "POST", url: `/api/notion/connections/${workspaceId}/sync/resume`, payload: {} });
    assert.equal(resume.statusCode, 200, resume.body);
    assert.equal(resume.json().connectionStatus, "active");
    assert.equal(resume.json().pauseReason, null);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("HTTP restore audit requires the source epoch and cannot send the quarantined operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-restore-audit-"));
  const databasePath = join(directory, "planner.sqlite");
  const seed = new SQLitePlannerStore(databasePath);
  let sourceEpoch: string;
  let operationId: string;
  try {
    await seedReady(seed);
    await new PlannerService(seed, () => Date.parse(at)).commands([{ type: "createTask", input: {
      id: taskId, title: initial.title, startDate: initial.date![0], endDate: initial.date![1],
      now: at, notionWorkspaceId: workspaceId,
    } }], "test-client");
    sourceEpoch = (await seed.getPlanningVersion()).datasetEpoch;
    operationId = (await seed.listNotionOutboxOperations())[0]!.operationId;
    await seed.markNotionOutboxSending(operationId, at);
    await seed.pauseNotionForRestore();
    await seed.replaceAllData({ tasks: [(await seed.getTask(taskId))!] });
  } finally { seed.close(); }
  const remote = transport();
  const app = createApp({ databasePath, planningModel: null, notionTaskTransport: remote.fake,
    notionOAuth: { workerOrigin: "https://worker.example", workerApiKey: "test-key",
      vaultPath: join(directory, "vault.sqlite"), encryptionKey: Buffer.alloc(32, 19) } });
  try {
    await app.ready();
    const path = `/api/notion/connections/${workspaceId}/sync/restore/${operationId}/reconcile`;
    const missingEpoch = await app.inject({ method: "POST", url: path, payload: {} });
    assert.equal(missingEpoch.statusCode, 400, missingEpoch.body);
    const checked = await app.inject({ method: "POST", url: path, payload: { sourceEpoch } });
    assert.equal(checked.statusCode, 200, checked.body);
    assert.equal(checked.json().restoreQuarantine[0].latestReview.outcome, "not_observed");
    assert.equal(checked.json().connectionStatus, "paused_after_restore");
    assert.deepEqual(remote.writes, []);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
