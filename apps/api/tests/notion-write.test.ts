import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NotionConnection, NotionTaskFields } from "@newday/core/contracts/notion-sync";

import { NotionOutboxDispatcher, type NotionTaskPage, type NotionTaskTransport } from "../src/services/notion-outbox-dispatcher.js";
import { createApp } from "../src/app.js";
import { NotionSyncService } from "../src/services/notion-sync-service.js";
import { PlannerService } from "../src/services/planner-service.js";
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
