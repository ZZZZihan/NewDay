import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { iterateAllDataSourceRows, UnknownHTTPResponseError } from "@notionhq/client";
import { AGENT_NAMESPACES } from "@newday/core/contracts/agent-planning";
import { createPlannerBackup, parsePlannerBackup } from "@newday/core/application/planner-backup";
import { getDayPlan } from "@newday/core/application/day-plan";
import { executePlannerCommands } from "@newday/core/application/planner-command";
import type { NotionConnection } from "@newday/core/contracts/notion-sync";

import { NotionReadFailure, NotionSdkReadGateway, type AreaRow, type NotionReadGateway, type ProjectRow,
  type ReadRow, type ReadTable, type TaskRow } from "../src/services/notion-read-gateway.js";
import { NotionReadService } from "../src/services/notion-read-service.js";
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
  return { workspaceId, installationId: "install-read", rootPageId: "root-1", status: "active", updatedAt: at,
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
    const oldSuccess = (await service.status(workspaceId)).sources[2].watermark?.lastSuccessAt;
    gateway.rows.tasks = [task(["2026-09-23", "2026-09-23"], "改过的任务")];
    gateway.fail = "tasks";
    await assert.rejects(service.scan(workspaceId), /lost its final page/);
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "读书");
    let status = await service.status(workspaceId);
    assert.equal(status.sources[2].watermark?.lastSuccessAt, oldSuccess);
    assert.equal(status.sources[2].watermark?.lastError, "incomplete");
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
    assert.equal(status.sources[2].watermark?.lastError, null);
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
    const success = (await service.status(workspaceId)).sources[2].watermark?.lastSuccessAt;
    gateway.rows.tasks = [{ ...task(["2026-09-23", "2026-09-23"], "错误归属"), clientKey: "another-installation" }];
    await assert.rejects(service.scan(workspaceId), /different NewDay Key/);
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "读书");
    assert.equal((await service.status(workspaceId)).sources[2].watermark?.lastSuccessAt, success);
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
    const previousSuccess = (await read.status(workspaceId)).sources[2].watermark?.lastSuccessAt;
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
    } }], "test-client");
    release();
    await assert.rejects(inFlight, /新的待发送操作/);
    assert.equal((await store.getTask(mapping.localTaskId))?.title, "本机最新标题");
    assert.equal((await store.listNotionOutboxOperations())[0]?.status, "pending");
    assert.equal((await read.status(workspaceId)).sources[2].watermark?.lastSuccessAt, previousSuccess);
  } finally { store.close(); credentials.close(); }
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
      const watermark = (await service.status(workspaceId)).sources[2].watermark;
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
