import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { iterateAllDataSourceRows, UnknownHTTPResponseError } from "@notionhq/client";
import { AGENT_NAMESPACES, type AgentPreferences, type DailyContext, type PlanningProposal,
  type PlanningSnapshot } from "@newday/core/contracts/agent-planning";
import { createPlannerBackup, parsePlannerBackup } from "@newday/core/application/planner-backup";
import { getDayPlan } from "@newday/core/application/day-plan";
import { executePlannerCommands, type PlannerCommand } from "@newday/core/application/planner-command";
import type { NotionConnection } from "@newday/core/contracts/notion-sync";

import { NotionReadFailure, NotionSdkReadGateway, type AreaRow, type NotionReadGateway, type ProjectRow,
  type ReadRow, type ReadTable, type TaskRow } from "../src/services/notion-read-gateway.js";
import { NotionReadService } from "../src/services/notion-read-service.js";
import { NotionOutboxDispatcher, type NotionTaskPage, type NotionTaskTransport } from "../src/services/notion-outbox-dispatcher.js";
import { AgentExecutionService } from "../src/services/agent-execution-service.js";
import { PlannerService } from "../src/services/planner-service.js";
import { recordedOutcome } from "../src/services/planner-history-service.js";
import { NotionCredentialVault } from "../src/storage/notion-credential-vault.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";

const workspaceId = "read-workspace";
const at = "2026-09-21T00:00:00.000Z";
const key = Buffer.alloc(32, 29);
const url = (id: string) => `https://www.notion.so/${id}`;
const base = (id: string) => ({ id, url: url(id), createdAt: at, editedAt: at, inTrash: false });
const area = (title = "生活"): AreaRow => ({ ...base("area-1"), kind: "area", title });
const project = (title = "周计划"): ProjectRow => ({ ...base("project-1"), kind: "project", title, areaIds: ["area-1"] });
const task = (date: [string, string] | null = ["2026-09-21", "2026-09-22"], title = "读书"): TaskRow => ({
  ...base("remote-task-1"), kind: "task", title, date, completed: false, projectIds: ["project-1"],
  directAreaIds: [], ruleIds: [], clientKey: null, occurrenceKey: null,
});

function connection(): NotionConnection {
  const ref = (name: string, propertyIds: Record<string, string>) => ({
    databaseId: `database-${name}`, dataSourceId: `source-${name}`,
    propertyIds, schemaFingerprint: `fingerprint-${name}`,
  });
  return { workspaceId, installationId: "install-read", rootPageId: "root-1", credentialRevision: 2,
    status: "active", updatedAt: at,
    dataSources: {
      areas: ref("areas", { Name: "area-title" }),
      projects: ref("projects", { Name: "project-title", Area: "project-area" }),
      tasks: ref("tasks", { Name: "task-title", "Plan Date": "task-date", Completed: "task-completed",
        Project: "task-project", "Direct Area": "task-area", Rule: "task-rule", "NewDay Key": "task-key" }),
      rules: ref("rules", { Name: "rule-title" }),
    } };
}

class FakeReadGateway implements NotionReadGateway {
  rows: Record<ReadTable, ReadRow[]> = { areas: [area()], projects: [project()], rules: [], tasks: [task()] };
  fail: ReadTable | null = null;
  knownPageTrash = new Map<string, boolean>();
  calls: ReadTable[] = [];
  async scan(token: string, _connection: NotionConnection, table: ReadTable): Promise<ReadRow[]> {
    assert.equal(token, "fake-read-access-token");
    this.calls.push(table);
    if (this.fail === table) throw new NotionReadFailure("incomplete", "fake query lost its final page");
    return structuredClone(this.rows[table]);
  }
  async readKnownPage(token: string, pageId: string): Promise<{ id: string; inTrash: boolean } | null> {
    assert.equal(token, "fake-read-access-token");
    return this.knownPageTrash.has(pageId) ? { id: pageId, inTrash: this.knownPageTrash.get(pageId)! } : null;
  }
}

function vault(): NotionCredentialVault {
  const result = new NotionCredentialVault(":memory:", key);
  const state = "s".repeat(43);
  result.putPending(state, "fake verifier", Date.parse(at) + 60_000, Date.parse(at));
  result.storeClaimed(state, { access_token: "fake-read-access-token", refresh_token: "fake-read-refresh-token",
    bot_id: "read-bot", workspace_id: workspaceId, workspace_name: "隔离测试" }, at);
  return result;
}

function linkedTransport(initial: NotionTaskPage) {
  let page = structuredClone(initial);
  const calls = { reads: 0, updates: 0, creates: 0 };
  const transport: NotionTaskTransport = {
    async findByClientKey() { return { complete: true, pages: [] }; },
    async readPage() { calls.reads += 1; return structuredClone(page); },
    async createPage() { calls.creates += 1; throw new Error("existing linked task must not be created"); },
    async updatePage(_connection, _mapping, patch) {
      calls.updates += 1;
      page = { ...page, fields: { ...page.fields, ...patch } };
    },
  };
  return { transport, calls, page: () => structuredClone(page) };
}

test("full read keeps a stable mapping, refreshes ownership, and clears a date without fabricating today", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-read-"));
  const databasePath = join(directory, "planner.sqlite");
  const credentials = vault();
  const gateway = new FakeReadGateway();
  let store: SQLitePlannerStore | undefined = new SQLitePlannerStore(databasePath);
  try {
    await store.putNotionConnection(connection());
    await store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", { timeZone: "Asia/Shanghai" });
    let service = new NotionReadService(store, credentials, gateway, () => Date.parse(at));
    await service.scan(workspaceId);
    const [mapping] = await store.listNotionTaskMappings();
    assert.equal(mapping.remotePageId, "remote-task-1");
    assert.equal((await store.getTask(mapping.localTaskId))?.startDate, "2026-09-21");
    assert.equal((await getDayPlan(store, { selectedDate: "2026-09-22", asOfDate: "2026-09-21" })).open.length, 1);
    const revision = (await store.getPlanningVersion()).plannerRevision;
    await service.scan(workspaceId);
    assert.equal((await store.getPlanningVersion()).plannerRevision, revision);
    assert.equal((await store.listNotionTaskMappings()).length, 1);
    await executePlannerCommands(store, [{ type: "setTodayFocus", input: {
      taskId: mapping.localTaskId, date: "2026-09-21", now: at,
    } }]);
    store.close();
    store = undefined;
    store = new SQLitePlannerStore(databasePath);
    service = new NotionReadService(store, credentials, gateway, () => Date.parse(at) + 1000);
    gateway.rows.projects = [project("新项目名")];
    gateway.rows.tasks = [task(null, "新任务名"), task(null, "新任务名")]; // overlapping windows may repeat a page
    await service.scan(workspaceId);
    assert.equal((await store.listNotionTaskMappings()).length, 1);
    assert.equal((await store.getTask(mapping.localTaskId))?.startDate, null);
    assert.equal((await store.getTask(mapping.localTaskId))?.endDate, null);
    assert.equal((await store.listFocusRecordsForTask(mapping.localTaskId)).length, 0);
    assert.equal((await getDayPlan(store, { selectedDate: "2026-09-21", asOfDate: "2026-09-21" })).open.length, 0);
    const backup = await createPlannerBackup(store, at);
    assert.equal(backup.version, 6);
    assert.equal(backup.notionSync?.readNodes?.find((node) => node.kind === "project")?.title, "新项目名");
    assert.equal(backup.notionSync?.readTaskContexts?.length, 1);
    assert.equal(JSON.stringify(backup).includes("fake-read-access-token"), false);
    parsePlannerBackup(JSON.stringify(backup));
  } finally { store?.close(); credentials.close(); await rm(directory, { recursive: true, force: true }); }
});

test("incomplete pages retain the old task and watermark; only explicit trash archives it", async () => {
  const credentials = vault();
  const store = new SQLitePlannerStore(":memory:");
  const gateway = new FakeReadGateway();
  try {
    await store.putNotionConnection(connection());
    const service = new NotionReadService(store, credentials, gateway, () => Date.parse(at));
    await service.scan(workspaceId);
    const [mapping] = await store.listNotionTaskMappings();
    const oldSuccess = (await service.status(workspaceId)).sources.find((source) => source.table === "tasks")?.watermark?.lastSuccessAt;
    gateway.rows.tasks = [task(["2026-09-23", "2026-09-23"], "改过的任务")];
    gateway.fail = "tasks";
    await assert.rejects(service.scan(workspaceId), /lost its final page/);
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "读书");
    let status = await service.status(workspaceId);
    assert.equal(status.sources.find((source) => source.table === "tasks")?.watermark?.lastSuccessAt, oldSuccess);
    assert.equal(status.sources.find((source) => source.table === "tasks")?.watermark?.lastError, "incomplete");
    gateway.fail = null;
    await service.scan(workspaceId);
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "改过的任务");
    gateway.rows.tasks = [];
    gateway.knownPageTrash.set("remote-task-1", false);
    await assert.rejects(service.scan(workspaceId), /not in trash/);
    assert.equal((await store.getTask(mapping.localTaskId))?.archived, undefined);
    gateway.knownPageTrash.set("remote-task-1", true);
    await service.scan(workspaceId);
    assert.equal((await store.getTask(mapping.localTaskId))?.archived, true);
    assert.equal((await store.getNotionTaskMapping(mapping.localTaskId))?.status, "archived");
    assert.equal((await getDayPlan(store, { selectedDate: "2026-09-23", asOfDate: "2026-09-23" })).open.length, 0);
    status = await service.status(workspaceId);
    assert.equal(status.sources.find((source) => source.table === "tasks")?.watermark?.lastError, null);
  } finally { store.close(); credentials.close(); }
});

test("a linked page with a changed NewDay Key cannot overwrite its local task", async () => {
  const credentials = vault();
  const store = new SQLitePlannerStore(":memory:");
  const gateway = new FakeReadGateway();
  try {
    await store.putNotionConnection(connection());
    const service = new NotionReadService(store, credentials, gateway, () => Date.parse(at));
    await service.scan(workspaceId);
    const [mapping] = await store.listNotionTaskMappings();
    const success = (await service.status(workspaceId)).sources.find((source) => source.table === "tasks")?.watermark?.lastSuccessAt;
    gateway.rows.tasks = [{ ...task(["2026-09-23", "2026-09-23"], "错误归属"), clientKey: "another-installation" }];
    await assert.rejects(service.scan(workspaceId), /different NewDay Key/);
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "读书");
    assert.equal((await service.status(workspaceId)).sources.find((source) => source.table === "tasks")?.watermark?.lastSuccessAt, success);
  } finally { store.close(); credentials.close(); }
});

test("a scan begun before a local linked edit cannot overwrite that pending write", async () => {
  const credentials = vault();
  const store = new SQLitePlannerStore(":memory:");
  const gateway = new FakeReadGateway();
  try {
    await store.putNotionConnection(connection());
    const read = new NotionReadService(store, credentials, gateway, () => Date.parse(at));
    await read.scan(workspaceId);
    const [mapping] = await store.listNotionTaskMappings();
    const previousSuccess = (await read.status(workspaceId)).sources.find((source) => source.table === "tasks")?.watermark?.lastSuccessAt;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const scan = gateway.scan.bind(gateway);
    gateway.scan = async (token, connection, table) => {
      if (table === "tasks") { enter(); await held; }
      return scan(token, connection, table);
    };
    const inFlight = read.scan(workspaceId);
    await entered;
    const planner = new PlannerService(store, () => Date.parse(at));
    await planner.commands([{ type: "updateTaskDetails", input: {
      taskId: mapping.localTaskId, title: "本机最新标题", now: at,
    } }], "test-client", { expectedTask: (await store.getTask(mapping.localTaskId))! });
    release();
    await assert.rejects(inFlight, /新的待发送操作/);
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "本机最新标题");
    assert.equal((await store.listNotionOutboxOperations())[0]?.status, "pending");
    assert.equal((await read.status(workspaceId)).sources.find((source) => source.table === "tasks")?.watermark?.lastSuccessAt, previousSuccess);
  } finally { store.close(); credentials.close(); }
});

test("a cloned stale task scan cannot overwrite a local edit after the real dispatcher confirms it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-confirmed-read-race-"));
  const databasePath = join(directory, "planner.sqlite");
  const credentials = vault();
  const store = new SQLitePlannerStore(databasePath);
  const gateway = new FakeReadGateway();
  let releaseOldScan: (() => void) | undefined;
  let inFlight: Promise<unknown> | undefined;
  let now = Date.parse(at);
  try {
    await store.putNotionConnection(connection());
    const read = new NotionReadService(store, credentials, gateway, () => now);
    await read.scan(workspaceId);
    const [mapping] = await store.listNotionTaskMappings();
    assert.ok(mapping);
    const previousSuccess = (await read.status(workspaceId)).sources
      .find((source) => source.table === "tasks")?.watermark?.lastSuccessAt;

    let markOldScanCaptured!: () => void;
    const oldScanCaptured = new Promise<void>((resolve) => { markOldScanCaptured = resolve; });
    const oldScanReleased = new Promise<void>((resolve) => { releaseOldScan = resolve; });
    const scan = gateway.scan.bind(gateway);
    let holdNextTaskScan = true;
    gateway.scan = async (token, currentConnection, table) => {
      if (table !== "tasks" || !holdNextTaskScan) return scan(token, currentConnection, table);
      holdNextTaskScan = false;
      const clonedOldRows = structuredClone(gateway.rows.tasks);
      markOldScanCaptured();
      await oldScanReleased;
      return clonedOldRows;
    };

    now += 1_000;
    inFlight = read.scan(workspaceId);
    await oldScanCaptured;

    const planner = new PlannerService(store, () => now);
    await planner.commands([{ type: "updateTaskDetails", input: {
      taskId: mapping.localTaskId, title: "本机已确认标题", now: new Date(now).toISOString(),
    } }], "confirmed-race-client", { expectedTask: (await store.getTask(mapping.localTaskId))! });
    const [operation] = await store.listNotionOutboxOperations();
    assert.equal(operation?.status, "pending");

    let remotePage: NotionTaskPage = {
      workspaceId, dataSourceId: connection().dataSources.tasks!.dataSourceId,
      remotePageId: mapping.remotePageId!, clientKey: null, fields: mapping.baseline!, inTrash: false,
    };
    const transport: NotionTaskTransport = {
      async findByClientKey() { return { complete: true, pages: [] }; },
      async readPage() { return structuredClone(remotePage); },
      async createPage() { throw new Error("existing linked task must not be created"); },
      async updatePage(_connection, _mapping, patch) {
        remotePage = { ...remotePage, fields: { ...remotePage.fields, ...patch } };
      },
    };
    assert.equal(await new NotionOutboxDispatcher(store, transport, () => new Date(now).toISOString())
      .dispatch(operation!.operationId), "confirmed");
    assert.equal((await store.getNotionOutboxOperation(operation!.operationId))?.status, "confirmed");
    assert.equal((await store.getNotionTaskMapping(mapping.localTaskId))?.baseline?.title, "本机已确认标题");

    assert.ok(releaseOldScan);
    releaseOldScan();
    releaseOldScan = undefined;
    await assert.rejects(inFlight, /扫描期间改变|扫描结果已过期/);
    inFlight = undefined;
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "本机已确认标题");
    assert.equal((await store.getNotionTaskMapping(mapping.localTaskId))?.baseline?.title, "本机已确认标题");
    assert.equal((await store.getNotionOutboxOperation(operation!.operationId))?.status, "confirmed");
    assert.equal((await read.status(workspaceId)).sources
      .find((source) => source.table === "tasks")?.watermark?.lastSuccessAt, previousSuccess);

    gateway.rows.tasks = [{ ...task(), title: "本机已确认标题" }];
    now += 1_000;
    await read.scan(workspaceId);
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "本机已确认标题");
    assert.notEqual((await read.status(workspaceId)).sources
      .find((source) => source.table === "tasks")?.watermark?.lastSuccessAt, previousSuccess);
  } finally {
    releaseOldScan?.();
    await inFlight?.catch(() => undefined);
    store.close();
    credentials.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenario of ["complete", "reopen", "reschedule"] as const) {
  test(`a stale task scan cannot roll back a confirmed ${scenario} or its focus and event effects`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `newday-notion-confirmed-${scenario}-race-`));
    const credentials = vault();
    const store = new SQLitePlannerStore(join(directory, "planner.sqlite"));
    const gateway = new FakeReadGateway();
    let releaseOldScan: (() => void) | undefined;
    let inFlight: Promise<unknown> | undefined;
    let now = Date.parse(at);
    try {
      await store.putNotionConnection(connection());
      const read = new NotionReadService(store, credentials, gateway, () => now);
      await read.scan(workspaceId);
      const [mapping] = await store.listNotionTaskMappings();
      assert.ok(mapping?.remotePageId && mapping.baseline);
      const planner = new PlannerService(store, () => now);
      const remote = linkedTransport({ workspaceId, dataSourceId: mapping.dataSourceId,
        remotePageId: mapping.remotePageId, clientKey: null, fields: mapping.baseline, inTrash: false });
      const dispatcher = new NotionOutboxDispatcher(store, remote.transport, () => new Date(now).toISOString());

      if (scenario === "reopen") {
        now += 1_000;
        await planner.commands([{ type: "completeTask", input: { taskId: mapping.localTaskId,
          now: new Date(now).toISOString(), completedOn: "2026-09-21" } }], "confirmed-reopen-setup");
        const setupOperation = (await store.listNotionOutboxOperations()).find((item) => item.status === "pending");
        assert.ok(setupOperation);
        assert.equal(await dispatcher.dispatch(setupOperation.operationId), "confirmed");
        gateway.rows.tasks = [{ ...task(), completed: true }];
      } else {
        now += 1_000;
        await planner.commands([{ type: "setTodayFocus", input: { taskId: mapping.localTaskId,
          date: "2026-09-21", now: new Date(now).toISOString() } }], `confirmed-${scenario}-focus`);
      }

      let markOldScanCaptured!: () => void;
      const oldScanCaptured = new Promise<void>((resolve) => { markOldScanCaptured = resolve; });
      const oldScanReleased = new Promise<void>((resolve) => { releaseOldScan = resolve; });
      const originalScan = gateway.scan.bind(gateway);
      let holdNextTaskScan = true;
      gateway.scan = async (token, currentConnection, table) => {
        if (table !== "tasks" || !holdNextTaskScan) return originalScan(token, currentConnection, table);
        holdNextTaskScan = false;
        const oldRows = structuredClone(gateway.rows.tasks);
        markOldScanCaptured();
        await oldScanReleased;
        return oldRows;
      };
      const previousSuccess = (await read.status(workspaceId)).sources
        .find((source) => source.table === "tasks")?.watermark?.lastSuccessAt;
      now += 1_000;
      inFlight = read.scan(workspaceId);
      await oldScanCaptured;

      let command: PlannerCommand;
      if (scenario === "complete") command = { type: "completeTask", input: { taskId: mapping.localTaskId,
        now: new Date(now).toISOString(), completedOn: "2026-09-21" } };
      else if (scenario === "reopen") command = { type: "reopenTask", input: { taskId: mapping.localTaskId,
        now: new Date(now).toISOString() } };
      else command = { type: "rescheduleTask", input: { taskId: mapping.localTaskId,
        startDate: "2026-09-24", endDate: "2026-09-25", now: new Date(now).toISOString() } };
      await planner.commands([command], `confirmed-${scenario}-client`, {
        expectedTask: (await store.getTask(mapping.localTaskId))!,
      });
      const operation = (await store.listNotionOutboxOperations()).filter((item) => item.status === "pending").at(-1);
      assert.ok(operation);
      assert.equal(await dispatcher.dispatch(operation.operationId), "confirmed");

      const expectedTask = await store.getTask(mapping.localTaskId);
      const expectedFocus = await store.listFocusRecordsForTask(mapping.localTaskId);
      const expectedEvents = await store.listPlannerEvents();
      const expectedMapping = await store.getNotionTaskMapping(mapping.localTaskId);
      assert.ok(expectedTask && expectedMapping);
      if (scenario === "complete") {
        assert.equal(expectedTask.completedAt, new Date(now).toISOString());
        assert.equal(expectedTask.completedOn, "2026-09-21");
      }
      assert.equal(expectedFocus.length, 0);

      assert.ok(releaseOldScan);
      releaseOldScan();
      releaseOldScan = undefined;
      await assert.rejects(inFlight, /扫描期间改变|扫描结果已过期/);
      inFlight = undefined;
      assert.deepEqual(await store.getTask(mapping.localTaskId), expectedTask);
      assert.deepEqual(await store.listFocusRecordsForTask(mapping.localTaskId), expectedFocus);
      assert.deepEqual(await store.listPlannerEvents(), expectedEvents);
      assert.deepEqual(await store.getNotionTaskMapping(mapping.localTaskId), expectedMapping);
      assert.equal((await store.getNotionOutboxOperation(operation.operationId))?.status, "confirmed");
      assert.equal((await read.status(workspaceId)).sources
        .find((source) => source.table === "tasks")?.watermark?.lastSuccessAt, previousSuccess);
      assert.equal(remote.calls.creates, 0);
    } finally {
      releaseOldScan?.();
      await inFlight?.catch(() => undefined);
      store.close();
      credentials.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("separate SQLite readers persistently reject an older task response that finishes last", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-two-readers-"));
  const databasePath = join(directory, "planner.sqlite");
  const credentials = vault();
  const firstStore = new SQLitePlannerStore(databasePath);
  let secondStore: SQLitePlannerStore | undefined;
  const oldGateway = new FakeReadGateway();
  let releaseOldScan: (() => void) | undefined;
  let oldInFlight: Promise<unknown> | undefined;
  try {
    await firstStore.putNotionConnection(connection());
    await new NotionReadService(firstStore, credentials, oldGateway, () => Date.parse(at)).scan(workspaceId);
    const [mapping] = await firstStore.listNotionTaskMappings();
    assert.ok(mapping);

    let markOldScanCaptured!: () => void;
    const oldScanCaptured = new Promise<void>((resolve) => { markOldScanCaptured = resolve; });
    const oldScanReleased = new Promise<void>((resolve) => { releaseOldScan = resolve; });
    const originalScan = oldGateway.scan.bind(oldGateway);
    oldGateway.scan = async (token, currentConnection, table) => {
      if (table !== "tasks") return originalScan(token, currentConnection, table);
      const oldRows = structuredClone(oldGateway.rows.tasks);
      markOldScanCaptured();
      await oldScanReleased;
      return oldRows;
    };

    const sameClock = () => Date.parse(at) + 1_000;
    const oldRead = new NotionReadService(firstStore, credentials, oldGateway, sameClock);
    oldInFlight = oldRead.scan(workspaceId);
    await oldScanCaptured;

    secondStore = new SQLitePlannerStore(databasePath);
    const newerGateway = new FakeReadGateway();
    newerGateway.rows.tasks = [task(["2026-09-24", "2026-09-25"], "较新的远端状态")];
    const newerRead = new NotionReadService(secondStore, credentials, newerGateway, sameClock);
    await newerRead.scan(workspaceId);
    const newerTask = await secondStore.getTask(mapping.localTaskId);
    const newerWatermark = (await newerRead.status(workspaceId)).sources
      .find((source) => source.table === "tasks")?.watermark;
    assert.equal(newerTask?.title, "较新的远端状态");
    assert.equal(newerTask?.startDate, "2026-09-24");
    assert.ok(newerWatermark?.lastSuccessAt);
    assert.equal(newerWatermark.completedThrough, newerWatermark.lastAttemptAt);

    assert.ok(releaseOldScan);
    releaseOldScan();
    releaseOldScan = undefined;
    await assert.rejects(oldInFlight, /扫描结果已过期/);
    oldInFlight = undefined;
    assert.deepEqual(await firstStore.getTask(mapping.localTaskId), newerTask);
    const finalWatermark = (await oldRead.status(workspaceId)).sources
      .find((source) => source.table === "tasks")?.watermark;
    assert.deepEqual(finalWatermark, newerWatermark, "the stale failure must not overwrite the newer success watermark");
  } finally {
    releaseOldScan?.();
    await oldInFlight?.catch(() => undefined);
    secondStore?.close();
    firstStore.close();
    credentials.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a confirmed A-to-B-to-A edit still invalidates a value-identical stale task response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-aba-race-"));
  const credentials = vault();
  const store = new SQLitePlannerStore(join(directory, "planner.sqlite"));
  const gateway = new FakeReadGateway();
  let releaseOldScan: (() => void) | undefined;
  let inFlight: Promise<unknown> | undefined;
  let now = Date.parse(at);
  try {
    await store.putNotionConnection(connection());
    const read = new NotionReadService(store, credentials, gateway, () => now);
    await read.scan(workspaceId);
    const [mapping] = await store.listNotionTaskMappings();
    assert.ok(mapping?.remotePageId && mapping.baseline);
    const planner = new PlannerService(store, () => now);
    const remote = linkedTransport({ workspaceId, dataSourceId: mapping.dataSourceId,
      remotePageId: mapping.remotePageId, clientKey: null, fields: mapping.baseline, inTrash: false });
    const dispatcher = new NotionOutboxDispatcher(store, remote.transport, () => new Date(now).toISOString());
    const previousSuccess = (await read.status(workspaceId)).sources
      .find((source) => source.table === "tasks")?.watermark?.lastSuccessAt;

    let markOldScanCaptured!: () => void;
    const oldScanCaptured = new Promise<void>((resolve) => { markOldScanCaptured = resolve; });
    const oldScanReleased = new Promise<void>((resolve) => { releaseOldScan = resolve; });
    const originalScan = gateway.scan.bind(gateway);
    gateway.scan = async (token, currentConnection, table) => {
      if (table !== "tasks") return originalScan(token, currentConnection, table);
      const oldRows = structuredClone(gateway.rows.tasks);
      markOldScanCaptured();
      await oldScanReleased;
      return oldRows;
    };
    now += 1_000;
    inFlight = read.scan(workspaceId);
    await oldScanCaptured;

    for (const title of ["临时标题 B", "读书"]) {
      now += 1_000;
      await planner.commands([{ type: "updateTaskDetails", input: { taskId: mapping.localTaskId,
        title, now: new Date(now).toISOString() } }], `aba-${title}`, {
        expectedTask: (await store.getTask(mapping.localTaskId))!,
      });
      const pending = (await store.listNotionOutboxOperations()).find((item) => item.status === "pending");
      assert.ok(pending);
      assert.equal(await dispatcher.dispatch(pending.operationId), "confirmed");
    }
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "读书");
    assert.equal((await store.getNotionTaskMapping(mapping.localTaskId))?.baseline?.title, "读书");
    assert.equal((await store.listNotionOutboxOperations())
      .filter((item) => ["pending", "sending", "unknown", "quarantined"].includes(item.status)).length, 0);
    assert.equal(remote.page().fields.title, "读书");

    assert.ok(releaseOldScan);
    releaseOldScan();
    releaseOldScan = undefined;
    await assert.rejects(inFlight, /扫描期间改变/);
    inFlight = undefined;
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "读书");
    assert.equal((await read.status(workspaceId)).sources
      .find((source) => source.table === "tasks")?.watermark?.lastSuccessAt, previousSuccess);
  } finally {
    releaseOldScan?.();
    await inFlight?.catch(() => undefined);
    store.close();
    credentials.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dataset epoch rotation rejects an in-flight task response without publishing old success", async () => {
  const credentials = vault();
  const store = new SQLitePlannerStore(":memory:");
  const gateway = new FakeReadGateway();
  let releaseOldScan: (() => void) | undefined;
  let inFlight: Promise<unknown> | undefined;
  let now = Date.parse(at);
  try {
    await store.putNotionConnection(connection());
    const read = new NotionReadService(store, credentials, gateway, () => now);
    await read.scan(workspaceId);
    const [mapping] = await store.listNotionTaskMappings();
    const oldVersion = await store.getPlanningVersion();
    const previousSuccess = (await read.status(workspaceId)).sources
      .find((source) => source.table === "tasks")?.watermark?.lastSuccessAt;

    let markOldScanCaptured!: () => void;
    const oldScanCaptured = new Promise<void>((resolve) => { markOldScanCaptured = resolve; });
    const oldScanReleased = new Promise<void>((resolve) => { releaseOldScan = resolve; });
    const originalScan = gateway.scan.bind(gateway);
    gateway.scan = async (token, currentConnection, table) => {
      if (table !== "tasks") return originalScan(token, currentConnection, table);
      const oldRows = structuredClone(gateway.rows.tasks);
      markOldScanCaptured();
      await oldScanReleased;
      return oldRows;
    };
    now += 1_000;
    inFlight = read.scan(workspaceId);
    await oldScanCaptured;
    const newVersion = await store.rotateDatasetEpoch();
    assert.notEqual(newVersion.datasetEpoch, oldVersion.datasetEpoch);
    gateway.rows.tasks = [task(["2026-09-25", "2026-09-25"], "新数据集远端状态")];

    assert.ok(releaseOldScan);
    releaseOldScan();
    releaseOldScan = undefined;
    await assert.rejects(inFlight, /授权或本地数据在扫描期间改变/);
    inFlight = undefined;
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "读书");
    assert.equal((await read.status(workspaceId)).sources
      .find((source) => source.table === "tasks")?.watermark?.lastSuccessAt, previousSuccess);

    now += 1_000;
    await read.scan(workspaceId);
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "新数据集远端状态");
    assert.notEqual((await read.status(workspaceId)).sources
      .find((source) => source.table === "tasks")?.watermark?.lastSuccessAt, previousSuccess);
  } finally {
    releaseOldScan?.();
    await inFlight?.catch(() => undefined);
    store.close();
    credentials.close();
  }
});

for (const writeState of ["sending", "unknown"] as const) {
  test(`${writeState === "unknown" ? "an" : "a"} ${writeState} write fences a stale task scan without advancing its success watermark`, async () => {
    const credentials = vault();
    const store = new SQLitePlannerStore(":memory:");
    const gateway = new FakeReadGateway();
    let releaseOldScan: (() => void) | undefined;
    let releasePreflight: (() => void) | undefined;
    let inFlight: Promise<unknown> | undefined;
    let dispatching: Promise<unknown> | undefined;
    let now = Date.parse(at);
    try {
      await store.putNotionConnection(connection());
      const read = new NotionReadService(store, credentials, gateway, () => now);
      await read.scan(workspaceId);
      const [mapping] = await store.listNotionTaskMappings();
      assert.ok(mapping?.remotePageId && mapping.baseline);
      const previousSuccess = (await read.status(workspaceId)).sources
        .find((source) => source.table === "tasks")?.watermark?.lastSuccessAt;

      let markOldScanCaptured!: () => void;
      const oldScanCaptured = new Promise<void>((resolve) => { markOldScanCaptured = resolve; });
      const oldScanReleased = new Promise<void>((resolve) => { releaseOldScan = resolve; });
      const originalScan = gateway.scan.bind(gateway);
      gateway.scan = async (token, currentConnection, table) => {
        if (table !== "tasks") return originalScan(token, currentConnection, table);
        const oldRows = structuredClone(gateway.rows.tasks);
        markOldScanCaptured();
        await oldScanReleased;
        return oldRows;
      };
      now += 1_000;
      inFlight = read.scan(workspaceId);
      await oldScanCaptured;

      const planner = new PlannerService(store, () => now);
      await planner.commands([{ type: "updateTaskDetails", input: { taskId: mapping.localTaskId,
        title: `${writeState} 本机标题`, now: new Date(now).toISOString() } }], `${writeState}-read-fence`, {
        expectedTask: (await store.getTask(mapping.localTaskId))!,
      });
      const operation = (await store.listNotionOutboxOperations()).find((item) => item.status === "pending");
      assert.ok(operation);
      let remotePage: NotionTaskPage = { workspaceId, dataSourceId: mapping.dataSourceId,
        remotePageId: mapping.remotePageId, clientKey: null, fields: mapping.baseline, inTrash: false };
      let readCalls = 0;
      let updateCalls = 0;
      let markPreflightStarted!: () => void;
      const preflightStarted = new Promise<void>((resolve) => { markPreflightStarted = resolve; });
      const preflightReleased = new Promise<void>((resolve) => { releasePreflight = resolve; });
      const transport: NotionTaskTransport = {
        async findByClientKey() { return { complete: true, pages: [] }; },
        async readPage() {
          readCalls += 1;
          if (writeState === "sending" && readCalls === 1) {
            markPreflightStarted();
            await preflightReleased;
          }
          if (writeState === "unknown" && readCalls === 2) throw new Error("readback unavailable");
          return structuredClone(remotePage);
        },
        async createPage() { throw new Error("existing linked task must not be created"); },
        async updatePage(_connection, _mapping, patch) {
          updateCalls += 1;
          if (writeState === "unknown") throw new Error("write result is ambiguous");
          remotePage = { ...remotePage, fields: { ...remotePage.fields, ...patch } };
        },
      };
      const dispatcher = new NotionOutboxDispatcher(store, transport, () => new Date(now).toISOString());
      dispatching = dispatcher.dispatch(operation.operationId);
      if (writeState === "sending") {
        await preflightStarted;
        assert.equal((await store.getNotionOutboxOperation(operation.operationId))?.status, "sending");
      } else {
        assert.equal(await dispatching, "unknown");
        dispatching = undefined;
        assert.equal((await store.getNotionOutboxOperation(operation.operationId))?.status, "unknown");
      }

      assert.ok(releaseOldScan);
      releaseOldScan();
      releaseOldScan = undefined;
      await assert.rejects(inFlight, /新的待发送操作|连接已变化|授权或本地数据在扫描期间改变/);
      inFlight = undefined;
      assert.equal((await read.status(workspaceId)).sources
        .find((source) => source.table === "tasks")?.watermark?.lastSuccessAt, previousSuccess);

      if (writeState === "sending") {
        assert.ok(releasePreflight);
        releasePreflight();
        releasePreflight = undefined;
        assert.equal(await dispatching, "confirmed");
        dispatching = undefined;
      } else {
        const writesBeforeReconcile = updateCalls;
        assert.equal(await dispatcher.reconcileUnknown(operation.operationId), "unknown");
        assert.equal(updateCalls, writesBeforeReconcile, "read-only reconciliation must not replay the unknown write");
      }
    } finally {
      releaseOldScan?.();
      releasePreflight?.();
      await inFlight?.catch(() => undefined);
      await dispatching?.catch(() => undefined);
      store.close();
      credentials.close();
    }
  });
}

test("a valid task sync invalidates an older Agent proposal before it can be applied", async () => {
  const credentials = vault();
  const store = new SQLitePlannerStore(":memory:");
  const gateway = new FakeReadGateway();
  try {
    await store.putNotionConnection(connection());
    const read = new NotionReadService(store, credentials, gateway, () => Date.parse(at));
    await read.scan(workspaceId);
    const [mapping] = await store.listNotionTaskMappings();
    assert.ok(mapping);
    const preferences: AgentPreferences = { revision: 1, timeZone: "Asia/Shanghai", learningEnabled: true,
      explicitPreferences: [], updatedAt: at };
    await store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", preferences);
    const version = await store.getPlanningVersion();
    const context: DailyContext = { id: `context:${version.datasetEpoch}:2026-09-21`, revision: 0,
      date: "2026-09-21", timeZone: "Asia/Shanghai", goals: [], energy: null, capacity: null,
      constraints: [], source: "user", updatedAt: at };
    const localTask = await store.getTask(mapping.localTaskId);
    assert.ok(localTask);
    const snapshot: PlanningSnapshot = { id: "notion-sync-snapshot", version, date: "2026-09-21",
      timeZone: "Asia/Shanghai", sampledAt: at, context, preferences,
      candidates: [{ task: localTask, executable: true, blocked: false, factRefs: [`task:${localTask.id}`] }],
      currentFocusTaskIds: [], facts: [{ id: `task:${localTask.id}`, source: "task",
        text: "同步任务可执行", taskId: localTask.id }], recentOutcomes: [],
      scope: { description: "同步任务", totalEligibleTasks: 1, includedTasks: 1, complete: true } };
    const proposal: PlanningProposal = { proposalId: "notion-sync-proposal", runId: "notion-sync-run",
      snapshotId: snapshot.id, createdAt: at, lifecycle: "ready",
      output: { kind: "ready", selections: [{ taskId: localTask.id, reason: "推进同步任务",
        factRefs: [`task:${localTask.id}`] }], assumptions: [] } };
    await store.putAgentRecord(AGENT_NAMESPACES.context, context.id, context);
    await store.putAgentRecord(AGENT_NAMESPACES.snapshot, snapshot.id, snapshot);
    await store.putAgentRecord(AGENT_NAMESPACES.proposal, proposal.proposalId, proposal);

    gateway.rows.tasks = [task(["2026-09-21", "2026-09-22"], "同步后的新标题")];
    await read.scan(workspaceId);
    assert.notDeepEqual(await store.getPlanningVersion(), version);
    await assert.rejects(new AgentExecutionService(store, () => Date.parse(at)).apply({
      proposalId: proposal.proposalId, operationId: "notion-sync-operation", expectedVersion: version,
      taskIds: [localTask.id],
    }), (error: unknown) => error instanceof Error && "code" in error && error.code === "VERSION_CONFLICT");
    assert.equal((await store.listExecutionReceipts()).length, 0);
    assert.deepEqual(await store.listFocusRecordsForDate("2026-09-21"), []);
  } finally {
    store.close();
    credentials.close();
  }
});

test("half-present rule identity fails the task scan without advancing its watermark", async () => {
  for (const malformed of [
    { ruleIds: ["rule-1"], occurrenceKey: null },
    { ruleIds: [], occurrenceKey: "orphan-key" },
  ]) {
    const credentials = vault();
    const store = new SQLitePlannerStore(":memory:");
    const gateway = new FakeReadGateway();
    try {
      await store.putNotionConnection(connection());
      gateway.rows.tasks = [{ ...task(), ...malformed }];
      const service = new NotionReadService(store, credentials, gateway, () => Date.parse(at));
      await assert.rejects(service.scan(workspaceId), (error: unknown) =>
        error instanceof NotionReadFailure && error.category === "schema");
      assert.equal((await store.listNotionTaskMappings()).length, 0);
      const watermark = (await service.status(workspaceId)).sources.find((source) => source.table === "tasks")?.watermark;
      assert.equal(watermark?.lastSuccessAt, null);
      assert.equal(watermark?.lastError, "schema");
    } finally { store.close(); credentials.close(); }
  }
});

test("installed SDK partitions incomplete queries and fails closed when a timestamp cannot advance", async () => {
  const rows = (ids: string[], createdAt: string) => ids.map((id) => ({
    object: "page" as const, id, url: url(id), created_time: createdAt,
  }));
  const calls: unknown[] = [];
  const client = { dataSources: { query: async (args: unknown) => {
    calls.push(args);
    if (calls.length === 1) return { results: rows(["a", "b"], at), request_status: { type: "incomplete" },
      next_cursor: null, has_more: false };
    return { results: [...rows(["b"], at), ...rows(["c"], "2026-09-21T00:00:01.000Z")],
      request_status: { type: "complete" }, next_cursor: null, has_more: false };
  } } } as unknown as Parameters<typeof iterateAllDataSourceRows>[0];
  const ids: string[] = [];
  for await (const row of iterateAllDataSourceRows(client, { data_source_id: "source-tasks" })) ids.push(row.id);
  assert.deepEqual(ids, ["a", "b", "c"]);
  assert.equal((calls[1] as { filter: { created_time: { on_or_after: string } } }).filter.created_time.on_or_after, at);

  const stuck = { dataSources: { query: async () => ({ results: rows(["a"], at),
    request_status: { type: "incomplete" }, next_cursor: null, has_more: false }) } } as unknown as Parameters<typeof iterateAllDataSourceRows>[0];
  await assert.rejects(async () => {
    for await (const row of iterateAllDataSourceRows(stuck, { data_source_id: "source-tasks" })) assert.ok(row.id);
  }, /cannot make progress/);
});

test("a remote completion with no timestamp never becomes a completion on scan day", async () => {
  const credentials = vault();
  const store = new SQLitePlannerStore(":memory:");
  const gateway = new FakeReadGateway();
  try {
    await store.putNotionConnection(connection());
    await store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", { timeZone: "Asia/Shanghai" });
    gateway.rows.tasks = [{ ...task(["2026-09-19", "2026-09-19"]), completed: true }];
    const service = new NotionReadService(store, credentials, gateway, () => Date.parse(at));
    await service.scan(workspaceId);
    const [mapping] = await store.listNotionTaskMappings();
    const imported = await store.getTask(mapping.localTaskId);
    assert.equal(imported?.status, "completed");
    assert.equal(imported.completedAt, null);
    assert.equal(imported.completedOn, null);
    assert.equal((await getDayPlan(store, { selectedDate: "2026-09-21", asOfDate: "2026-09-21" })).completed.length, 0);
    gateway.rows.tasks = [{ ...task(["2026-09-19", "2026-09-19"]), completed: false }];
    await service.scan(workspaceId);
    gateway.rows.tasks = [{ ...task(["2026-09-19", "2026-09-19"]), completed: true }];
    await service.scan(workspaceId);
    const observations = (await store.listPlannerEvents()).filter((event) => event.taskId === mapping.localTaskId);
    assert.ok(observations.some((event) => event.kind === "notion_observed"));
    assert.ok(observations.every((event) => recordedOutcome(event) === undefined));
  } finally { store.close(); credentials.close(); }
});

test("SDK refuses to classify tasks when the Rules source cannot be read", async () => {
  const gateway = new NotionSdkReadGateway();
  let queries = 0;
  Object.assign(gateway, { client: () => ({ dataSources: {
    retrieve: async () => { throw new UnknownHTTPResponseError({ status: 403,
      message: "forbidden", headers: new Headers(), rawBodyText: "" }); },
    query: async () => { queries += 1; return { results: [], has_more: false, next_cursor: null }; },
  } }) });
  await assert.rejects(gateway.scan("fake-token", connection(), "tasks"), (error: unknown) =>
    error instanceof NotionReadFailure && error.category === "permission");
  assert.equal(queries, 0);
});

test("SDK retry waits for full Retry-After and backs off when it is missing", async () => {
  for (const header of ["120", null]) {
    const waits: number[] = [];
    const gateway = new NotionSdkReadGateway(async (milliseconds) => { waits.push(milliseconds); });
    let requests = 0;
    Object.assign(gateway, { client: () => ({ pages: { retrieve: async () => {
      requests += 1;
      if (requests === 1) throw new UnknownHTTPResponseError({ status: 429,
        message: "rate limited", headers: new Headers(header === null ? {} : { "retry-after": header }), rawBodyText: "" });
      return { id: "known-page", in_trash: false };
    } } }) });
    assert.deepEqual(await gateway.readKnownPage("fake-token", "known-page"), { id: "known-page", inTrash: false });
    assert.equal(requests, 2);
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= (header ? 120_000 : 1000));
  }
});
