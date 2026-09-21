import assert from "node:assert/strict";
import test from "node:test";

import { notionClientKey, type NotionConnection, type NotionOutboxOperation, type NotionTaskFields, type NotionTaskMapping } from "@newday/core/contracts/notion-sync";
import { createPlannerBackup, restorePlannerBackup } from "@newday/core/application/planner-backup";
import { parsePlannerBackup } from "@newday/core/contracts/planner-backup";

import { NotionOutboxDispatcher, NotionWritePreflightFailure, type NotionTaskPage, type NotionTaskTransport } from "../src/services/notion-outbox-dispatcher.js";
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

test("manual pause fences a preflight before any page write and keeps its intent pending", async () => {
  const store = await setup();
  const fake = fakeTransport();
  let releaseRead!: () => void;
  let readStarted!: () => void;
  const readStartedPromise = new Promise<void>((resolve) => { readStarted = resolve; });
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
  fake.transport.findByClientKey = async () => {
    readStarted();
    await readReleased;
    return { complete: true, pages: [] };
  };
  try {
    const dispatcher = new NotionOutboxDispatcher(store, fake.transport, () => at);
    const sync = new NotionSyncService(store, dispatcher);
    const sending = dispatcher.dispatch("operation-1");
    await readStartedPromise;
    const paused = await sync.pause("workspace-1");
    assert.equal(paused.connectionStatus, "paused");
    assert.equal(paused.pauseReason, "manual");
    assert.equal(paused.operations[0]?.status, "sending", "the in-flight request stays visible");
    releaseRead();
    assert.equal(await sending, "paused");
    assert.equal((await store.getNotionOutboxOperation("operation-1"))?.status, "pending");
    assert.equal(fake.calls.create, 0);
    assert.equal(fake.calls.update, 0);
    await assert.rejects(sync.drain("workspace-1"), /已暂停/);
    await sync.resume("workspace-1");
    assert.equal((await store.getNotionConnection("workspace-1"))?.status, "active");
  } finally { store.close(); }
});

test("manual pause during an existing page preflight defers a conflict merge without inventing an unknown write", async () => {
  const desired: NotionTaskFields = { ...fields, date: ["2026-09-09", "2026-09-09"] };
  const store = await setup("remote-1", desired);
  const fake = fakeTransport();
  const remoteFields = { ...fields, title: "Notion 改名" };
  fake.pages.set("remote-1", { workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
    remotePageId: "remote-1", clientKey: null, fields: remoteFields, inTrash: false });
  let releaseRead!: () => void;
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseRead = resolve; });
  const read = fake.transport.readPage;
  fake.transport.readPage = async (...args) => {
    readStarted();
    await released;
    return read(...args);
  };
  try {
    const dispatcher = new NotionOutboxDispatcher(store, fake.transport, () => at);
    const sync = new NotionSyncService(store, dispatcher);
    const sending = dispatcher.dispatch("operation-1");
    await started;
    await sync.pause("workspace-1");
    releaseRead();
    assert.equal(await sending, "paused");
    assert.equal((await store.getNotionConnection("workspace-1"))?.pauseReason, "manual");
    assert.equal((await store.getNotionOutboxOperation("operation-1"))?.status, "pending");
    assert.deepEqual(fake.calls, { create: 0, update: 0 });
    assert.deepEqual(fake.pages.get("remote-1")?.fields, remoteFields);
    assert.equal((await store.getTask("task-1"))?.title, desired.title);
  } finally { store.close(); }
});

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

test("429 and 529 preflight retain Retry-After and block early resume", async () => {
  for (const [httpStatus, header] of [[429, "120"], [529, new Date(Date.now() + 120_000).toUTCString()]] as const) {
    const store = await setup();
    const fake = fakeTransport();
    fake.transport.findByClientKey = async () => {
      throw Object.assign(new Error("limited"), { status: httpStatus,
        headers: new Headers({ "retry-after": header }) });
    };
    try {
      const dispatcher = new NotionOutboxDispatcher(store, fake.transport);
      assert.equal(await dispatcher.dispatch("operation-1"), "paused");
      const sync = new NotionSyncService(store, dispatcher);
      const status = await sync.status("workspace-1");
      assert.equal(status.pauseReason, "preflight_read");
      assert.ok(status.retryAfterAt && Date.parse(status.retryAfterAt) > Date.now() + 110_000);
      assert.equal(status.operations[0]?.status, "pending");
      assert.equal(fake.calls.create, 0);
      await assert.rejects(sync.resume("workspace-1"), /限流退避至/);
    } finally { store.close(); }
  }
});

test("a setup failure after successful preflight stays retryable without claiming an ambiguous page write", async () => {
  const store = await setup();
  const fake = fakeTransport();
  fake.transport.createPage = async () => {
    throw new NotionWritePreflightFailure("credential disappeared before page request");
  };
  try {
    const dispatcher = new NotionOutboxDispatcher(store, fake.transport, () => at);
    assert.equal(await dispatcher.dispatch("operation-1"), "paused");
    assert.equal((await store.getNotionOutboxOperation("operation-1"))?.status, "pending");
    assert.equal((await store.getNotionConnection("workspace-1"))?.pauseReason, "preflight_read");
    assert.equal(fake.calls.create, 0);
    assert.equal(fake.pages.size, 0);
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

test("a newer intent also supersedes an unsent attempt when its remote preflight fails", async () => {
  const first: NotionTaskFields = { ...fields, date: ["2026-09-09", "2026-09-09"] };
  const second: NotionTaskFields = { ...fields, date: ["2026-09-10", "2026-09-10"] };
  const store = await setup("remote-1", first);
  const fake = fakeTransport();
  fake.pages.set("remote-1", { workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
    remotePageId: "remote-1", clientKey: null, fields, inTrash: false });
  const read = fake.transport.readPage;
  let failed = false;
  fake.transport.readPage = async (...args) => {
    if (!failed) {
      failed = true;
      await store.transaction(async () => {
        const current = (await store.getTask("task-1"))!;
        await store.putTask({ ...current, startDate: second.date![0], endDate: second.date![1] });
        const older = (await store.getNotionOutboxOperation("operation-1"))!;
        await store.enqueueNotionOutbox({ ...older, operationId: "operation-2", desired: second,
          status: "pending", attemptCount: 0, lastAttemptAt: null, confirmedAt: null });
      });
      throw new Error("read failed after a newer local edit");
    }
    return read(...args);
  };
  try {
    const dispatcher = new NotionOutboxDispatcher(store, fake.transport, () => at);
    assert.equal(await dispatcher.dispatch("operation-1"), "paused");
    assert.equal((await store.getNotionOutboxOperation("operation-1"))?.status, "superseded");
    assert.equal((await store.getNotionOutboxOperation("operation-2"))?.status, "pending");
    assert.equal(fake.calls.update, 0);
    const sync = new NotionSyncService(store, dispatcher);
    await sync.resume("workspace-1");
    assert.equal(await dispatcher.dispatch("operation-2"), "confirmed");
    assert.equal((await store.getNotionOutboxOperation("operation-2"))?.status, "confirmed");
    assert.deepEqual(fake.pages.get("remote-1")?.fields, second);
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
    const dispatcher = new NotionOutboxDispatcher(store, fake.transport, () => at);
    const sync = new NotionSyncService(store, dispatcher);
    const sourceEpoch = (await store.getPlanningVersion()).datasetEpoch;
    const dispatch = dispatcher.dispatch("operation-1");
    await enteredPromise;
    await store.pauseNotionForRestore();
    await store.replaceAllData({ tasks: [task()] });
    release();
    assert.equal(await dispatch, "quarantined");
    assert.equal((await store.listNotionRestoreQuarantine()).length, 1);
    assert.equal(await store.getNotionTaskMapping("task-1"), undefined);
    assert.deepEqual(await store.listNotionOutboxOperations(), []);
    const status = await sync.status("workspace-1");
    assert.deepEqual(status.operations, []);
    const quarantinedAt = status.restoreQuarantine[0]?.quarantinedAt;
    assert.ok(quarantinedAt && !Number.isNaN(Date.parse(quarantinedAt)));
    assert.deepEqual(status.restoreQuarantine, [{
      sourceEpoch, operationId: "operation-1", localTaskId: "task-1",
      originalStatus: "sending", attemptCount: 1, lastAttemptAt: at,
      dataSourceId: "tasks-source-1", remotePageId: null,
      clientKey: notionClientKey("install-1", "task-1"),
      quarantinedAt, desired: fields, baseline: null,
    }]);
    await store.putNotionConnection({ ...connection(), workspaceId: "workspace-2" });
    assert.deepEqual((await sync.status("workspace-2")).restoreQuarantine, []);
  } finally { store.close(); }
});

test("restore audit records a remote match without replaying an old operation or lifting its fence", async () => {
  const desired = { ...fields, title: "恢复前的改名" };
  const store = await setup("remote-1", desired);
  const fake = fakeTransport();
  try {
    await store.putNotionConnection({ ...connection(), dataSources: { tasks: {
      databaseId: "tasks-db", dataSourceId: "tasks-source-1", propertyIds: {}, schemaFingerprint: "test",
    } } });
    const sourceEpoch = (await store.getPlanningVersion()).datasetEpoch;
    await store.markNotionOutboxSending("operation-1", at);
    await store.pauseNotionForRestore();
    await store.replaceAllData({ tasks: [task()] });
    fake.pages.set("remote-1", { workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
      remotePageId: "remote-1", clientKey: notionClientKey("install-1", "task-1"),
      fields: desired, inTrash: false });

    const sync = new NotionSyncService(store, new NotionOutboxDispatcher(store, fake.transport, () => at));
    const status = await sync.reconcileRestore("workspace-1", sourceEpoch, "operation-1");
    assert.deepEqual(status.restoreQuarantine[0]?.latestReview, {
      checkedAt: at, outcome: "matches_intent", remotePageId: "remote-1", remoteFields: desired,
    });
    assert.deepEqual(fake.calls, { create: 0, update: 0 });
    assert.equal(status.connectionStatus, "paused_after_restore");
    assert.deepEqual(await store.listNotionOutboxOperations(), []);
    assert.equal((await store.listNotionRestoreQuarantine()).length, 1);
    await assert.rejects(sync.resume("workspace-1"), /无需恢复发送/);
    const exported = await createPlannerBackup(store, at);
    if (exported.version !== 6) throw new Error("expected v6 backup");
    assert.deepEqual(exported.notionSync.restoreQuarantine[0]?.latestReview,
      status.restoreQuarantine[0]?.latestReview);
    const invalidReview = structuredClone(exported);
    invalidReview.notionSync.restoreQuarantine[0]!.latestReview!.remoteFields!.title = "不匹配的伪造值";
    assert.throws(() => parsePlannerBackup(JSON.stringify(invalidReview)), /核对结果与原意图不一致/);
    const imported = new SQLitePlannerStore(":memory:");
    try {
      await restorePlannerBackup(imported, JSON.stringify(exported));
      assert.deepEqual((await imported.listNotionRestoreQuarantine())[0]?.latestReview,
        status.restoreQuarantine[0]?.latestReview);
      assert.equal((await imported.getNotionConnection("workspace-1"))?.status, "paused_after_restore");
    } finally { imported.close(); }
  } finally { store.close(); }
});

test("restore audit keeps missing, incomplete, and divergent remote results visible but fenced", async () => {
  const store = await setup();
  const fake = fakeTransport();
  try {
    await store.putNotionConnection({ ...connection(), dataSources: { tasks: {
      databaseId: "tasks-db", dataSourceId: "tasks-source-1", propertyIds: {}, schemaFingerprint: "test",
    } } });
    const sourceEpoch = (await store.getPlanningVersion()).datasetEpoch;
    await store.markNotionOutboxSending("operation-1", at);
    await store.pauseNotionForRestore();
    await store.replaceAllData({ tasks: [task()] });
    const sync = new NotionSyncService(store, new NotionOutboxDispatcher(store, fake.transport, () => at));

    assert.equal((await sync.reconcileRestore("workspace-1", sourceEpoch, "operation-1"))
      .restoreQuarantine[0]?.latestReview?.outcome, "not_observed");
    fake.setSearchComplete(false);
    assert.equal((await sync.reconcileRestore("workspace-1", sourceEpoch, "operation-1"))
      .restoreQuarantine[0]?.latestReview?.outcome, "incomplete");
    fake.setSearchComplete(true);
    fake.pages.set("remote-1", { workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
      remotePageId: "remote-1", clientKey: notionClientKey("install-1", "task-1"),
      fields: { ...fields, title: "Notion 较新标题" }, inTrash: false });
    assert.equal((await sync.reconcileRestore("workspace-1", sourceEpoch, "operation-1"))
      .restoreQuarantine[0]?.latestReview?.outcome, "different");
    assert.deepEqual(fake.calls, { create: 0, update: 0 });
    assert.equal((await store.getNotionConnection("workspace-1"))?.status, "paused_after_restore");
  } finally { store.close(); }
});

test("restore audit treats duplicate pages and a changed data source as unresolved identity", async () => {
  const store = await setup();
  const fake = fakeTransport();
  try {
    await store.putNotionConnection({ ...connection(), dataSources: { tasks: {
      databaseId: "tasks-db", dataSourceId: "tasks-source-1", propertyIds: {}, schemaFingerprint: "test",
    } } });
    const sourceEpoch = (await store.getPlanningVersion()).datasetEpoch;
    await store.markNotionOutboxSending("operation-1", at);
    await store.pauseNotionForRestore();
    await store.replaceAllData({ tasks: [task()] });
    const page: NotionTaskPage = { workspaceId: "workspace-1", dataSourceId: "tasks-source-1",
      remotePageId: "remote-1", clientKey: notionClientKey("install-1", "task-1"),
      fields, inTrash: false };
    let searches = 0;
    fake.transport.findByClientKey = async () => {
      searches += 1;
      return { complete: true, pages: [page, { ...page, remotePageId: "remote-2" }] };
    };
    const sync = new NotionSyncService(store, new NotionOutboxDispatcher(store, fake.transport, () => at));
    assert.equal((await sync.reconcileRestore("workspace-1", sourceEpoch, "operation-1"))
      .restoreQuarantine[0]?.latestReview?.outcome, "ambiguous");
    const old = (await store.getNotionConnection("workspace-1"))!;
    await store.putNotionConnection({ ...old, dataSources: { tasks: {
      ...old.dataSources.tasks!, dataSourceId: "different-source",
    } } });
    assert.equal((await sync.reconcileRestore("workspace-1", sourceEpoch, "operation-1"))
      .restoreQuarantine[0]?.latestReview?.outcome, "identity_mismatch");
    assert.equal(searches, 1, "identity mismatch must not start a remote read");
    assert.deepEqual(fake.calls, { create: 0, update: 0 });
  } finally { store.close(); }
});

test("restore audit rejects a dataset replaced during its remote read", async () => {
  const store = await setup();
  const fake = fakeTransport();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  try {
    await store.putNotionConnection({ ...connection(), dataSources: { tasks: {
      databaseId: "tasks-db", dataSourceId: "tasks-source-1", propertyIds: {}, schemaFingerprint: "test",
    } } });
    const sourceEpoch = (await store.getPlanningVersion()).datasetEpoch;
    await store.markNotionOutboxSending("operation-1", at);
    await store.pauseNotionForRestore();
    await store.replaceAllData({ tasks: [task()] });
    fake.transport.findByClientKey = async () => { entered(); await released; return { complete: true, pages: [] }; };
    const sync = new NotionSyncService(store, new NotionOutboxDispatcher(store, fake.transport, () => at));
    const audit = sync.reconcileRestore("workspace-1", sourceEpoch, "operation-1");
    await started;
    await store.replaceAllData({ tasks: [task("replacement")] });
    release();
    await assert.rejects(audit, /核对期间数据集或连接已变化/);
    assert.equal((await store.listNotionRestoreQuarantine())[0]?.latestReview, undefined);
    assert.deepEqual(fake.calls, { create: 0, update: 0 });
  } finally { store.close(); }
});

test("a slower restore read cannot overwrite a later observation from another dispatcher", async () => {
  const store = await setup();
  const first = fakeTransport();
  const second = fakeTransport();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  try {
    await store.putNotionConnection({ ...connection(), dataSources: { tasks: {
      databaseId: "tasks-db", dataSourceId: "tasks-source-1", propertyIds: {}, schemaFingerprint: "test",
    } } });
    const sourceEpoch = (await store.getPlanningVersion()).datasetEpoch;
    await store.markNotionOutboxSending("operation-1", at);
    await store.pauseNotionForRestore();
    await store.replaceAllData({ tasks: [task()] });
    first.transport.findByClientKey = async () => { entered(); await released; return { complete: true, pages: [] }; };
    const old = new NotionSyncService(store, new NotionOutboxDispatcher(store, first.transport, () => at));
    const freshAt = "2026-09-21T00:00:01.000Z";
    const newer = new NotionSyncService(store, new NotionOutboxDispatcher(store, second.transport, () => freshAt));
    const slow = old.reconcileRestore("workspace-1", sourceEpoch, "operation-1");
    await started;
    const fresh = await newer.reconcileRestore("workspace-1", sourceEpoch, "operation-1");
    assert.equal(fresh.restoreQuarantine[0]?.latestReview?.checkedAt, freshAt);
    release();
    await assert.rejects(slow, /核对期间数据集或连接已变化/);
    assert.equal((await store.listNotionRestoreQuarantine())[0]?.latestReview?.checkedAt, freshAt);
  } finally { release(); store.close(); }
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
