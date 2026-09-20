import assert from "node:assert/strict";
import test from "node:test";

import { notionClientKey, type NotionConnection, type NotionOutboxOperation, type NotionTaskFields, type NotionTaskMapping } from "@newday/core/contracts/notion-sync";

import { NotionOutboxDispatcher, type NotionTaskPage, type NotionTaskTransport } from "../src/services/notion-outbox-dispatcher.js";
import { NotionSyncService } from "../src/services/notion-sync-service.js";
import { PlannerService } from "../src/services/planner-service.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";
import { backup, task } from "./fixtures.js";

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
    async updatePage(_connection, candidate, patch) {
      calls.update += 1;
      const current = pages.get(candidate.remotePageId!);
      if (!current) throw new Error("remote page missing");
      pages.set(candidate.remotePageId!, { workspaceId: candidate.workspaceId, dataSourceId: candidate.dataSourceId,
        remotePageId: candidate.remotePageId!, clientKey: null,
        fields: { ...current.fields, ...patch }, inTrash: false });
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

test("failed remote preflight pauses an unsent intent and explicit resume retries safely", async () => {
  const desired = { ...fields, title: "本机改名" };
  const store = await setup("remote-1", desired);
  await store.putNotionConnection({ ...connection(), dataSources: { tasks: {
    databaseId: "tasks-db", dataSourceId: "tasks-source-1", propertyIds: {},
    schemaFingerprint: "test-fingerprint",
  } } });
  const fake = fakeTransport();
  fake.pages.set("remote-1", { workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
    remotePageId: "remote-1", clientKey: null, fields, inTrash: false });
  const read = fake.transport.readPage;
  let failOnce = true;
  fake.transport.readPage = async (...args) => {
    if (failOnce) { failOnce = false; throw new Error("temporary read outage"); }
    return read(...args);
  };
  try {
    const dispatcher = new NotionOutboxDispatcher(store, fake.transport, () => at);
    assert.equal(await dispatcher.dispatch("operation-1"), "paused");
    assert.equal(fake.calls.update, 0);
    assert.equal((await store.getNotionOutboxOperation("operation-1"))?.status, "pending");
    assert.equal((await store.getNotionConnection("workspace-1"))?.status, "paused");
    const sync = new NotionSyncService(store, dispatcher);
    await sync.resume("workspace-1");
    assert.equal((await sync.drain("workspace-1")).operations[0]?.status, "confirmed");
    assert.equal(fake.calls.update, 1);
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

test("a same-field conflict uses the remote value and records the three-way decision", async () => {
  const local = { ...fields, title: "本地标题" };
  const store = await setup("remote-1", local);
  const fake = fakeTransport();
  fake.pages.set("remote-1", {
    workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
    remotePageId: "remote-1", clientKey: null,
    fields: { ...fields, title: "Notion 标题" }, inTrash: false,
  });
  try {
    assert.equal(await new NotionOutboxDispatcher(store, fake.transport, () => at).dispatch("operation-1"), "confirmed");
    assert.equal(fake.calls.update, 0);
    assert.equal((await store.getTask("task-1"))?.title, "Notion 标题");
    assert.deepEqual((await store.listNotionConflicts()).map(({ field, baseline, local: localValue, remote }) =>
      ({ field, baseline, local: localValue, remote })), [
      { field: "title", baseline: "整理项目", local: "本地标题", remote: "Notion 标题" },
    ]);
    assert.equal((await store.listNotionConflicts())[0]?.winner, "notion");
  } finally { store.close(); }
});

test("different-field edits merge through a business command and send only the local date", async () => {
  const desired: NotionTaskFields = { ...fields, date: ["2026-09-09", "2026-09-09"] };
  const store = await setup("remote-1", desired);
  const fake = fakeTransport();
  fake.pages.set("remote-1", {
    workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
    remotePageId: "remote-1", clientKey: null,
    fields: { ...fields, title: "Notion 新标题" }, inTrash: false,
  });
  const before = await store.getPlanningVersion();
  const update = fake.transport.updatePage;
  let sentPatch: Partial<NotionTaskFields> | undefined;
  fake.transport.updatePage = async (...args) => { sentPatch = args[2]; await update(...args); };
  try {
    assert.equal(await new NotionOutboxDispatcher(store, fake.transport, () => at).dispatch("operation-1"), "confirmed");
    assert.deepEqual(sentPatch, { date: ["2026-09-09", "2026-09-09"] });
    assert.deepEqual(fake.pages.get("remote-1")?.fields,
      { title: "Notion 新标题", date: ["2026-09-09", "2026-09-09"], completed: false });
    assert.equal((await store.getTask("task-1"))?.title, "Notion 新标题");
    assert.equal((await store.getTask("task-1"))?.startDate, "2026-09-09");
    assert.equal((await store.getPlanningVersion()).plannerRevision, before.plannerRevision + 1);
    assert.deepEqual(await store.listNotionConflicts(), []);
    assert.equal((await store.getNotionConnection("workspace-1"))?.status, "active");
  } finally { store.close(); }
});

test("remote date removal and completion keep an unknown completion time while a local title is patched", async () => {
  const desired = { ...fields, title: "本地改名" };
  const store = await setup("remote-1", desired);
  const fake = fakeTransport();
  fake.pages.set("remote-1", { workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
    remotePageId: "remote-1", clientKey: null,
    fields: { ...fields, date: null, completed: true }, inTrash: false });
  let patch: Partial<NotionTaskFields> | undefined;
  const update = fake.transport.updatePage;
  fake.transport.updatePage = async (...args) => { patch = args[2]; await update(...args); };
  try {
    assert.equal(await new NotionOutboxDispatcher(store, fake.transport, () => at).dispatch("operation-1"), "confirmed");
    assert.deepEqual(patch, { title: "本地改名" });
    const task = await store.getTask("task-1");
    assert.equal(task?.startDate, null);
    assert.equal(task?.endDate, null);
    assert.equal(task?.status, "completed");
    assert.equal(task?.completedAt, null);
    assert.equal(task?.completedOn, null);
    assert.deepEqual(fake.pages.get("remote-1")?.fields, { title: "本地改名", date: null, completed: true });
  } finally { store.close(); }
});

test("a newer local intent during preflight supersedes the unsent attempt without pausing the workspace", async () => {
  const first: NotionTaskFields = { ...fields, date: ["2026-09-09", "2026-09-09"] };
  const second: NotionTaskFields = { ...fields, date: ["2026-09-10", "2026-09-10"] };
  const remote: NotionTaskFields = { ...fields, title: "Notion 新标题" };
  const store = await setup("remote-1", first);
  const fake = fakeTransport();
  fake.pages.set("remote-1", {
    workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
    remotePageId: "remote-1", clientKey: null, fields: remote, inTrash: false,
  });
  const read = fake.transport.readPage;
  let committedNewer = false;
  fake.transport.readPage = async (...args) => {
    const page = await read(...args);
    if (!committedNewer) {
      committedNewer = true;
      await store.transaction(async () => {
        const current = (await store.getTask("task-1"))!;
        await store.putTask({ ...current, startDate: second.date![0], endDate: second.date![1] });
        const older = (await store.getNotionOutboxOperation("operation-1"))!;
        await store.enqueueNotionOutbox({ ...older, operationId: "operation-2", desired: second,
          status: "pending", attemptCount: 0, lastAttemptAt: null, confirmedAt: null });
      });
    }
    return page;
  };
  try {
    const dispatcher = new NotionOutboxDispatcher(store, fake.transport, () => at);
    assert.equal(await dispatcher.dispatch("operation-1"), "superseded");
    assert.equal(fake.calls.update, 0);
    assert.equal((await store.getNotionOutboxOperation("operation-1"))?.status, "superseded");
    assert.equal((await store.getNotionOutboxOperation("operation-2"))?.status, "pending");
    assert.equal((await store.getNotionConnection("workspace-1"))?.status, "active");
    assert.equal(await dispatcher.dispatch("operation-2"), "confirmed");
    assert.deepEqual(fake.pages.get("remote-1")?.fields, { ...second, title: remote.title });
    assert.equal((await store.getTask("task-1"))?.title, remote.title);
  } finally { store.close(); }
});

test("a newer intent after the first supersession check is caught by the merge transaction", async () => {
  const first: NotionTaskFields = { ...fields, date: ["2026-09-09", "2026-09-09"] };
  const second: NotionTaskFields = { ...fields, date: ["2026-09-10", "2026-09-10"] };
  const remote: NotionTaskFields = { ...fields, title: "Notion 新标题" };
  const store = await setup("remote-1", first);
  const fake = fakeTransport();
  fake.pages.set("remote-1", {
    workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
    remotePageId: "remote-1", clientKey: null, fields: remote, inTrash: false,
  });
  const check = store.supersedeNotionUnsentIfNewer.bind(store);
  let committedNewer = false;
  store.supersedeNotionUnsentIfNewer = async (operationId) => {
    const result = await check(operationId);
    if (!committedNewer) {
      committedNewer = true;
      await store.transaction(async () => {
        const current = (await store.getTask("task-1"))!;
        await store.putTask({ ...current, startDate: second.date![0], endDate: second.date![1] });
        const older = (await store.getNotionOutboxOperation("operation-1"))!;
        await store.enqueueNotionOutbox({ ...older, operationId: "operation-2", desired: second,
          status: "pending", attemptCount: 0, lastAttemptAt: null, confirmedAt: null });
      });
    }
    return result;
  };
  try {
    const dispatcher = new NotionOutboxDispatcher(store, fake.transport, () => at);
    assert.equal(await dispatcher.dispatch("operation-1"), "superseded");
    assert.equal(fake.calls.update, 0);
    assert.equal((await store.getNotionConnection("workspace-1"))?.status, "active");
    assert.equal(await dispatcher.dispatch("operation-2"), "confirmed");
    assert.deepEqual(fake.pages.get("remote-1")?.fields, { ...second, title: remote.title });
    assert.equal((await store.getTask("task-1"))?.title, remote.title);
  } finally { store.close(); }
});

test("a remote edit after preflight survives a selective date patch", async () => {
  const desired: NotionTaskFields = { ...fields, date: ["2026-09-09", "2026-09-09"] };
  const store = await setup("remote-1", desired);
  const fake = fakeTransport();
  fake.pages.set("remote-1", {
    workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
    remotePageId: "remote-1", clientKey: null, fields, inTrash: false,
  });
  const update = fake.transport.updatePage;
  let sentPatch: Partial<NotionTaskFields> | undefined;
  fake.transport.updatePage = async (...args) => {
    sentPatch = args[2];
    const current = fake.pages.get("remote-1")!;
    fake.pages.set("remote-1", { ...current, fields: { ...current.fields, title: "Notion 新标题" } });
    await update(...args);
  };
  try {
    assert.equal(await new NotionOutboxDispatcher(store, fake.transport, () => at).dispatch("operation-1"), "unknown");
    assert.deepEqual(sentPatch, { date: ["2026-09-09", "2026-09-09"] });
    assert.deepEqual(fake.pages.get("remote-1")?.fields,
      { ...fields, title: "Notion 新标题", date: ["2026-09-09", "2026-09-09"] });
    assert.equal((await store.getNotionConnection("workspace-1"))?.status, "paused_unknown");
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

test("restore waits for a known send to finish before replacing the dataset", async () => {
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
    const restore = new PlannerService(store).restore(JSON.stringify(backup([task("replacement")])));
    for (let i = 0; i < 100 && (await store.getNotionConnection("workspace-1"))?.status !== "paused_after_restore"; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await store.getNotionConnection("workspace-1"))?.status, "paused_after_restore");
    assert.equal(await store.getTask("replacement"), undefined);
    release();
    assert.equal(await dispatch, "confirmed");
    await restore;
    assert.deepEqual(await store.listNotionRestoreQuarantine(), []);
    assert.deepEqual(await store.getTask("replacement"), task("replacement"));
  } finally { store.close(); }
});

test("restore timeout quarantines a send whose HTTP result is still unknown", async () => {
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
    await new PlannerService(store, Date.now, 10_000, 20).restore(JSON.stringify(backup([task("replacement")])));
    assert.equal((await store.listNotionRestoreQuarantine()).length, 1);
    release();
    assert.equal(await dispatch, "quarantined");
    assert.deepEqual(await store.getTask("replacement"), task("replacement"));
  } finally { store.close(); }
});
