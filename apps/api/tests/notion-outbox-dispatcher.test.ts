import assert from "node:assert/strict";
import test from "node:test";

import { notionClientKey, type NotionConnection, type NotionOutboxOperation, type NotionTaskFields, type NotionTaskMapping } from "@newday/core/contracts/notion-sync";

import { NotionOutboxDispatcher, type NotionTaskPage, type NotionTaskTransport } from "../src/services/notion-outbox-dispatcher.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";
import { task } from "./fixtures.js";

const at = "2026-09-21T00:00:00.000Z";
const fields: NotionTaskFields = { title: "整理项目", date: ["2026-09-08", "2026-09-08"], completed: false };

function connection(): NotionConnection {
  return { workspaceId: "workspace-1", installationId: "install-1", rootPageId: "root-1", dataSources: {}, status: "active", updatedAt: at };
}

function mapping(remotePageId: string | null = null): NotionTaskMapping {
  return {
    localTaskId: "task-1", workspaceId: "workspace-1", dataSourceId: "tasks-source-1", remotePageId,
    clientKey: notionClientKey("install-1", "task-1"), baseline: remotePageId ? fields : null,
    status: remotePageId ? "active" : "pending_create", updatedAt: at,
  };
}

async function setup(remotePageId: string | null = null, desired: NotionTaskFields = fields) {
  const store = new SQLitePlannerStore(":memory:");
  await store.putTask(task("task-1", {
    title: desired.title, startDate: desired.date![0], endDate: desired.date![1],
    status: desired.completed ? "completed" : "open",
  }));
  await store.putNotionConnection(connection());
  await store.putNotionTaskMapping(mapping(remotePageId));
  const operation: NotionOutboxOperation = {
    operationId: "operation-1", localTaskId: "task-1", workspaceId: "workspace-1",
    datasetEpoch: (await store.getPlanningVersion()).datasetEpoch, desired,
    baseline: remotePageId ? fields : null, status: "pending", attemptCount: 0,
    createdAt: at, lastAttemptAt: null, confirmedAt: null,
  };
  await store.enqueueNotionOutbox(operation);
  return store;
}

function fakeTransport() {
  const pages = new Map<string, NotionTaskPage>();
  const calls = { create: 0, update: 0 };
  let searchComplete = true;
  const transport: NotionTaskTransport = {
    async findByClientKey(_connection, candidate) {
      return { complete: searchComplete, pages: [...pages.values()].filter((page) => page.clientKey === candidate.clientKey) };
    },
    async readPage(_connection, candidate) { return pages.get(candidate.remotePageId ?? "") ?? null; },
    async createPage(_connection, candidate, desired) {
      calls.create += 1;
      pages.set("remote-1", { workspaceId: candidate.workspaceId, dataSourceId: candidate.dataSourceId,
        remotePageId: "remote-1", clientKey: candidate.clientKey, fields: desired, inTrash: false });
    },
    async updatePage(_connection, candidate, desired) {
      calls.update += 1;
      pages.set(candidate.remotePageId!, { workspaceId: candidate.workspaceId, dataSourceId: candidate.dataSourceId,
        remotePageId: candidate.remotePageId!, clientKey: null, fields: desired, inTrash: false });
    },
  };
  return { transport, pages, calls, setSearchComplete(value: boolean) { searchComplete = value; } };
}

test("a create response lost after remote success binds one page by stable key", async () => {
  const store = await setup();
  const fake = fakeTransport();
  const create = fake.transport.createPage;
  fake.transport.createPage = async (...args) => { await create(...args); throw new Error("response lost"); };
  try {
    const dispatcher = new NotionOutboxDispatcher(store, fake.transport, () => at);
    assert.equal(await dispatcher.dispatch("operation-1"), "confirmed");
    assert.equal(fake.calls.create, 1);
    assert.equal((await store.getNotionTaskMapping("task-1"))?.remotePageId, "remote-1");
    await assert.rejects(dispatcher.dispatch("operation-1"), /not pending/);
    assert.equal(fake.calls.create, 1);
  } finally { store.close(); }
});

test("an ambiguous create stays unknown and read-only reconciliation never creates again", async () => {
  const store = await setup();
  const fake = fakeTransport();
  fake.transport.createPage = async () => { fake.calls.create += 1; throw new Error("timeout"); };
  try {
    const dispatcher = new NotionOutboxDispatcher(store, fake.transport, () => at);
    assert.equal(await dispatcher.dispatch("operation-1"), "unknown");
    assert.equal((await store.getNotionConnection("workspace-1"))?.status, "paused_unknown");
    assert.equal(await dispatcher.reconcileUnknown("operation-1"), "unknown");
    assert.equal(fake.calls.create, 1);
  } finally { store.close(); }
});

test("incomplete or duplicate key search forbids remote create", async () => {
  for (const duplicate of [false, true]) {
    const store = await setup();
    const fake = fakeTransport();
    if (duplicate) {
      fake.pages.set("remote-1", { workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
        remotePageId: "remote-1", clientKey: mapping().clientKey, fields, inTrash: false });
      fake.pages.set("remote-2", { workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
        remotePageId: "remote-2", clientKey: mapping().clientKey, fields, inTrash: false });
    } else fake.setSearchComplete(false);
    try {
      assert.equal(await new NotionOutboxDispatcher(store, fake.transport, () => at).dispatch("operation-1"), "unknown");
      assert.equal(fake.calls.create, 0);
    } finally { store.close(); }
  }
});

test("a matching key outside the mapped data source cannot be adopted", async () => {
  const store = await setup();
  const fake = fakeTransport();
  fake.pages.set("remote-1", {
    workspaceId: "workspace-1", dataSourceId: "unrelated-source",
    remotePageId: "remote-1", clientKey: mapping().clientKey, fields, inTrash: false,
  });
  try {
    assert.equal(await new NotionOutboxDispatcher(store, fake.transport, () => at).dispatch("operation-1"), "unknown");
    assert.equal(fake.calls.create, 0);
    assert.equal((await store.getNotionTaskMapping("task-1"))?.remotePageId, null);
  } finally { store.close(); }
});

test("a changed remote field pauses the write and records a three-way conflict", async () => {
  const local = { ...fields, title: "本地标题" };
  const store = await setup("remote-1", local);
  const fake = fakeTransport();
  fake.pages.set("remote-1", {
    workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
    remotePageId: "remote-1", clientKey: null,
    fields: { ...fields, title: "Notion 标题" }, inTrash: false,
  });
  try {
    assert.equal(await new NotionOutboxDispatcher(store, fake.transport, () => at).dispatch("operation-1"), "unknown");
    assert.equal(fake.calls.update, 0);
    assert.deepEqual((await store.listNotionConflicts()).map(({ field, baseline, local: localValue, remote }) =>
      ({ field, baseline, local: localValue, remote })), [
      { field: "title", baseline: "整理项目", local: "本地标题", remote: "Notion 标题" },
    ]);
  } finally { store.close(); }
});

test("a restore during an in-flight send keeps the late result out of the new dataset", async () => {
  const store = await setup();
  const fake = fakeTransport();
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const create = fake.transport.createPage;
  fake.transport.createPage = async (...args) => {
    entered();
    await releasePromise;
    await create(...args);
  };
  try {
    const dispatch = new NotionOutboxDispatcher(store, fake.transport, () => at).dispatch("operation-1");
    await enteredPromise;
    await store.pauseNotionForRestore();
    await store.replaceAllData({ tasks: [task()] });
    release();
    assert.equal(await dispatch, "quarantined");
    assert.equal((await store.listNotionRestoreQuarantine()).length, 1);
    assert.equal(await store.getNotionTaskMapping("task-1"), undefined);
    assert.deepEqual(await store.listNotionOutboxOperations(), []);
  } finally { store.close(); }
});

test("a restore during remote preflight prevents a new HTTP write", async () => {
  const store = await setup();
  const fake = fakeTransport();
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const find = fake.transport.findByClientKey;
  fake.transport.findByClientKey = async (...args) => {
    entered();
    await releasePromise;
    return find(...args);
  };
  try {
    const dispatch = new NotionOutboxDispatcher(store, fake.transport, () => at).dispatch("operation-1");
    await enteredPromise;
    await store.pauseNotionForRestore();
    await store.replaceAllData({ tasks: [task()] });
    release();
    assert.equal(await dispatch, "quarantined");
    assert.equal(fake.calls.create, 0);
  } finally { store.close(); }
});
