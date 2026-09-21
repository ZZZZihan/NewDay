import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Client, PageObjectResponse } from "@notionhq/client";

import { AGENT_NAMESPACES } from "@newday/core/contracts/agent-planning";
import { createPlannerBackup, parsePlannerBackup } from "@newday/core/application/planner-backup";
import { notionLogicalSeriesId, type NotionConnection } from "@newday/core/contracts/notion-sync";

import { NotionOutboxDispatcher, type NotionTaskPage, type NotionTaskTransport } from "../src/services/notion-outbox-dispatcher.js";
import { NotionReadService } from "../src/services/notion-read-service.js";
import { ensureLocalRecurrenceOccurrences } from "../src/services/local-recurrence-service.js";
import { applyNotionRules, enqueueNotionRuleInstances } from "../src/services/notion-rule-service.js";
import { NotionReadFailure, parseRow, type NotionReadGateway, type ReadRow, type ReadTable,
  type RuleRow, type TaskRow } from "../src/services/notion-read-gateway.js";
import { NotionCredentialVault } from "../src/storage/notion-credential-vault.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";

const at = "2026-02-01T00:00:00.000Z";
const workspaceId = "rules-workspace";
const ruleId = "monthly-rule";
const logicalSeriesId = notionLogicalSeriesId(workspaceId, ruleId);
const occurrenceKey = `${logicalSeriesId}:2026-02-28`;

function connection(): NotionConnection {
  const ref = (name: string) => ({ databaseId: `${name}-database`, dataSourceId: `${name}-source`,
    propertyIds: { Name: `${name}-name` }, schemaFingerprint: `${name}-fingerprint` });
  return { workspaceId, installationId: "rules-installation", rootPageId: "rules-root",
    status: "active", updatedAt: at, dataSources: {
      areas: ref("areas"), projects: ref("projects"), rules: ref("rules"), tasks: ref("tasks"),
    } };
}

function rule(dayOfMonth = 31): RuleRow {
  return { id: ruleId, url: `https://www.notion.so/${ruleId}`, createdAt: at, editedAt: at,
    inTrash: false, kind: "rule", source: { title: "月底回顾", startDate: "2026-02-01",
      endDate: null, pattern: { kind: "monthly", dayOfMonth }, excludedDates: [] } };
}

function instance(date = "2026-02-28", completed = false, title = "月底回顾", clientKey: string | null = null): TaskRow {
  return { id: "remote-month-end", url: "https://www.notion.so/remote-month-end",
    createdAt: at, editedAt: at, inTrash: false, kind: "task", title,
    date: [date, date], completed, projectIds: [], directAreaIds: [],
    ruleIds: [ruleId], occurrenceKey, clientKey };
}

class Gateway implements NotionReadGateway {
  rows: Record<ReadTable, ReadRow[]> = { areas: [], projects: [], rules: [rule()], tasks: [] };
  trash = new Map<string, boolean>();
  async scan(_token: string, _connection: NotionConnection, table: ReadTable): Promise<ReadRow[]> {
    return structuredClone(this.rows[table]);
  }
  async readKnownPage(_token: string, pageId: string) {
    return this.trash.has(pageId) ? { id: pageId, inTrash: this.trash.get(pageId)! } : null;
  }
}

function vault() {
  const credentials = new NotionCredentialVault(":memory:", Buffer.alloc(32, 41));
  const state = "s".repeat(43);
  credentials.putPending(state, "rules-verifier", Date.parse(at) + 60_000, Date.parse(at));
  credentials.storeClaimed(state, { access_token: "rules-access", refresh_token: "rules-refresh",
    bot_id: "rules-bot", workspace_id: workspaceId, workspace_name: "隔离规则测试" }, at);
  return credentials;
}

async function seed(store: SQLitePlannerStore) {
  await store.putNotionConnection(connection());
  await store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", { timeZone: "Asia/Shanghai" });
}

test("Rules page parsing accepts a monthly clamp source and rejects a timed active date", async () => {
  const propertyIds = { Name: "name", "Active Dates": "dates", Pattern: "pattern",
    Weekdays: "weekdays", "Month Day": "month-day", "Excluded Dates": "excluded" };
  const page = { id: ruleId, url: `https://www.notion.so/${ruleId}`,
    created_time: at, last_edited_time: at, in_trash: false,
    properties: {
      Name: { id: "name", type: "title", title: [{ plain_text: "月底回顾" }] },
      "Active Dates": { id: "dates", type: "date", date: { start: "2026-02-01", end: null } },
      Pattern: { id: "pattern", type: "select", select: { name: "monthly" } },
      Weekdays: { id: "weekdays", type: "multi_select", multi_select: [] },
      "Month Day": { id: "month-day", type: "number", number: 31 },
      "Excluded Dates": { id: "excluded", type: "rich_text", rich_text: [{ plain_text: "[]" }] },
    },
  } as unknown as PageObjectResponse;
  const parsed = await parseRow({} as Client, page, "rules", propertyIds);
  assert.equal(parsed.kind, "rule");
  if (parsed.kind === "rule") assert.deepEqual(parsed.source.pattern, { kind: "monthly", dayOfMonth: 31 });
  const timed = structuredClone(page) as unknown as { properties: Record<string, { date?: { start: string } }> };
  timed.properties["Active Dates"].date!.start = "2026-02-01T09:00:00+08:00";
  await assert.rejects(parseRow({} as Client, timed as unknown as PageObjectResponse, "rules", propertyIds),
    (error: unknown) => error instanceof NotionReadFailure && error.category === "schema");
});

test("a remote monthly occurrence keeps its nominal key through rescheduling, completion, rule edit and stop", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const credentials = vault();
  const gateway = new Gateway();
  gateway.rows.tasks = [instance()];
  try {
    await seed(store);
    const read = new NotionReadService(store, credentials, gateway, () => Date.parse(at));
    await read.scan(workspaceId);
    const [mapping] = await store.listNotionTaskMappings();
    assert.equal(mapping.rulePageId, ruleId);
    assert.equal(mapping.occurrenceKey, occurrenceKey);
    assert.equal(mapping.remotePageId, "remote-month-end");
    assert.equal((await store.listAllTasks()).length, 1, "February 31 clamps to February 28 once");
    assert.deepEqual(await store.listNotionOutboxOperations(), []);

    gateway.rows.tasks = [instance("2026-03-01", true, "单独改过的回顾")];
    await read.scan(workspaceId);
    const moved = (await store.getTask(mapping.localTaskId))!;
    assert.equal(moved.occurrenceDate, "2026-02-28");
    assert.equal(moved.occurrenceKey, occurrenceKey);
    assert.equal(moved.startDate, "2026-03-01");
    assert.equal(moved.status, "completed");
    assert.equal(moved.completedAt, null);
    assert.equal(moved.isSeriesException, true);

    gateway.rows.rules = [rule(30)];
    await read.scan(workspaceId);
    assert.deepEqual(await store.getTask(mapping.localTaskId), moved,
      "a rule edit must not rewrite a completed exception");
    gateway.rows.rules = [];
    gateway.trash.set(ruleId, true);
    gateway.rows.tasks = [{ ...instance("2026-03-01", true, "单独改过的回顾"), ruleIds: [] }];
    await read.scan(workspaceId);
    assert.equal((await store.listNotionRuleMappings(workspaceId))[0]?.status, "archived");
    assert.equal((await store.getRecurrenceSeries(logicalSeriesId))?.disabled, true);
    assert.equal((await store.listAllTasks()).length, 1);
    const stoppedMapping = await store.getNotionTaskMapping(mapping.localTaskId);
    assert.equal(stoppedMapping?.remotePageId, "remote-month-end");
    assert.equal(stoppedMapping?.rulePageId, ruleId,
      "Notion hides the relation to a trashed rule, but the verified instance identity must remain stable");
    assert.equal(stoppedMapping?.occurrenceKey, occurrenceKey);
    const backup = await createPlannerBackup(store, at);
    assert.equal(backup.version, 6);
    if (backup.version !== 6) throw new Error("Expected a v6 backup");
    assert.equal(backup.notionSync.ruleMappings?.length, 1);
    parsePlannerBackup(JSON.stringify(backup));
    const missingRule = structuredClone(backup);
    if (missingRule.version === 6) missingRule.notionSync.ruleMappings = [];
    assert.throws(() => parsePlannerBackup(JSON.stringify(missingRule)), /实例映射与规则/);
  } finally { store.close(); credentials.close(); }
});

test("changing a monthly rule does not add a second occurrence inside its materialized horizon", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const credentials = vault();
  const gateway = new Gateway();
  gateway.rows.tasks = [instance(), { ...instance("2026-03-31"), id: "remote-march-end",
    url: "https://www.notion.so/remote-march-end", occurrenceKey: `${logicalSeriesId}:2026-03-31` }];
  let now = Date.parse("2026-02-28T04:00:00.000Z");
  try {
    await seed(store);
    const read = new NotionReadService(store, credentials, gateway, () => now);
    await read.scan(workspaceId);
    assert.equal((await store.listAllTasks()).length, 2);
    gateway.rows.rules = [rule(30)];
    await read.scan(workspaceId);
    assert.equal((await store.listNotionRuleMappings(workspaceId))[0]?.generationAfter, "2026-03-31");
    assert.equal(await store.getTaskByOccurrenceKey(`${logicalSeriesId}:2026-03-30`), undefined);
    assert.equal((await store.listAllTasks()).length, 2);
    assert.deepEqual(await store.listNotionOutboxOperations(), []);

    now = Date.parse("2026-04-01T04:00:00.000Z");
    await read.scan(workspaceId);
    assert.ok(await store.getTaskByOccurrenceKey(`${logicalSeriesId}:2026-04-30`));
    assert.equal((await store.listAllTasks()).length, 3);
  } finally { store.close(); credentials.close(); }
});

test("a rule edit waits for the Tasks scan to include a newly added old-pattern instance, even after interruption", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const credentials = vault();
  const gateway = new Gateway();
  const monthly = (dayOfMonth: number) => {
    const row = rule(dayOfMonth);
    return { ...row, source: { ...row.source, startDate: "2026-11-01" } };
  };
  const occurrence = (date: string, id: string): TaskRow => ({ ...instance(date), id,
    url: `https://www.notion.so/${id}`, occurrenceKey: `${logicalSeriesId}:${date}` });
  const november = occurrence("2026-11-30", "remote-november");
  const december = occurrence("2026-12-31", "remote-december");
  gateway.rows.rules = [monthly(31)];
  gateway.rows.tasks = [november];
  try {
    await seed(store);
    const read = new NotionReadService(store, credentials, gateway,
      () => Date.parse("2026-11-29T04:00:00.000Z"));
    await read.scan(workspaceId);
    assert.equal((await store.listAllTasks()).length, 1);

    gateway.rows.rules = [monthly(30)];
    gateway.rows.tasks = [{ id: "wrong-source", url: "", createdAt: at, editedAt: at,
      inTrash: false, kind: "area", title: "wrong" }];
    await assert.rejects(read.scan(workspaceId),
      (error: unknown) => error instanceof NotionReadFailure && error.category === "schema");
    assert.equal((await store.listNotionRuleMappings(workspaceId))[0]?.generationReconcilePending, true);

    gateway.rows.tasks = [november, december];
    await read.scan(workspaceId);
    const [mapping] = await store.listNotionRuleMappings(workspaceId);
    assert.equal(mapping.generationAfter, "2026-12-31");
    assert.equal(mapping.generationReconcilePending, false);
    assert.equal(await store.getTaskByOccurrenceKey(`${logicalSeriesId}:2026-12-30`), undefined);
    assert.equal((await store.listAllTasks()).length, 2);
    assert.deepEqual(await store.listNotionOutboxOperations(), []);
  } finally { store.close(); credentials.close(); }
});

test("a generated month-end instance and outbound key survive restart without duplicate creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-rules-"));
  const databasePath = join(directory, "planner.sqlite");
  const credentials = vault();
  const gateway = new Gateway();
  let store: SQLitePlannerStore | undefined = new SQLitePlannerStore(databasePath);
  try {
    await seed(store);
    await new NotionReadService(store, credentials, gateway, () => Date.parse(at)).scan(workspaceId);
    const [task] = await store.listAllTasks();
    const [mapping] = await store.listNotionTaskMappings();
    const [operation] = await store.listNotionOutboxOperations();
    assert.equal(task.occurrenceDate, "2026-02-28");
    assert.equal(task.occurrenceKey, occurrenceKey);
    assert.equal(mapping.localTaskId, task.id);
    assert.equal(mapping.rulePageId, ruleId);
    assert.equal(operation.status, "pending");
    await assert.rejects(new NotionReadService(store, credentials, gateway, () => Date.parse(at)).scan(workspaceId),
      /待发送或未知操作/);

    store.close();
    store = new SQLitePlannerStore(databasePath);
    let page: NotionTaskPage | null = null;
    let creations = 0;
    const transport: NotionTaskTransport = {
      async findByClientKey(_connection, candidate) {
        return { complete: true, pages: page?.clientKey === candidate.clientKey ? [page] : [] };
      },
      async readPage(_connection, candidate) {
        return page?.remotePageId === candidate.remotePageId ? page : null;
      },
      async createPage(_connection, candidate, fields) {
        creations += 1;
        page = { workspaceId, dataSourceId: candidate.dataSourceId, remotePageId: "remote-month-end",
          clientKey: candidate.clientKey, rulePageId: candidate.rulePageId,
          occurrenceKey: candidate.occurrenceKey, fields, inTrash: false };
      },
      async updatePage() { throw new Error("No update expected"); },
    };
    const dispatcher = new NotionOutboxDispatcher(store, transport, () => at);
    assert.equal(await dispatcher.dispatch(operation.operationId), "confirmed");
    assert.equal(creations, 1);
    gateway.rows.tasks = [instance("2026-02-28", false, "月底回顾", mapping.clientKey)];
    await new NotionReadService(store, credentials, gateway, () => Date.parse(at)).scan(workspaceId);
    assert.equal((await store.listAllTasks()).length, 1);
    assert.equal((await store.listNotionTaskMappings()).length, 1);
    assert.equal((await store.listNotionOutboxOperations()).length, 1);
    assert.equal(creations, 1);
  } finally { store?.close(); credentials.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a duplicate remote occurrence rolls back the whole Tasks scan and does not advance its watermark", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const credentials = vault();
  const gateway = new Gateway();
  gateway.rows.tasks = [instance(), { ...instance(), id: "duplicate-remote", url: "https://www.notion.so/duplicate-remote" }];
  try {
    await seed(store);
    await assert.rejects(new NotionReadService(store, credentials, gateway, () => Date.parse(at)).scan(workspaceId),
      (error: unknown) => error instanceof NotionReadFailure && error.category === "schema");
    assert.deepEqual(await store.listAllTasks(), []);
    assert.deepEqual(await store.listNotionTaskMappings(), []);
    assert.deepEqual(await store.listNotionOutboxOperations(), []);
    const watermark = (await store.listNotionScanWatermarks()).find((item) => item.dataSourceId === "tasks-source");
    assert.equal(watermark?.lastSuccessAt, null);
    assert.equal(watermark?.lastError, "schema");
  } finally { store.close(); credentials.close(); }
});

test("an unverified missing rule leaves its mapping and completed instance intact", async () => {
  const store = new SQLitePlannerStore(":memory:");
  const credentials = vault();
  const gateway = new Gateway();
  gateway.rows.tasks = [instance("2026-02-28", true)];
  try {
    await seed(store);
    const read = new NotionReadService(store, credentials, gateway, () => Date.parse(at));
    await read.scan(workspaceId);
    const before = await store.listAllTasks();
    gateway.rows.rules = [];
    await assert.rejects(read.scan(workspaceId),
      (error: unknown) => error instanceof NotionReadFailure && error.category === "incomplete");
    assert.deepEqual(await store.listAllTasks(), before);
    assert.equal((await store.listNotionRuleMappings(workspaceId))[0]?.status, "active");
    assert.equal((await store.getRecurrenceSeries(logicalSeriesId))?.disabled, false);
  } finally { store.close(); credentials.close(); }
});

test("ordinary day generation materializes local rules but leaves Notion rules to the scan transaction", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await seed(store);
    await store.putRecurrenceSeries({ id: "local-series", logicalSeriesId: "local-series",
      title: "本地每日", notes: "", startDate: "2026-02-01", effectiveEndDate: null,
      pattern: { kind: "daily" }, end: { kind: "never" }, excludedDates: [], createdAt: at, updatedAt: at });
    await applyNotionRules(store, connection(), [rule()], [], at);
    await ensureLocalRecurrenceOccurrences(store, { asOfDate: "2026-02-28",
      throughDate: "2026-02-28", now: at });
    assert.deepEqual((await store.listAllTasks()).map((task) => task.logicalSeriesId), ["local-series"]);
    assert.deepEqual(await store.listNotionOutboxOperations(), []);
  } finally { store.close(); }
});

test("the inclusive 32-day window advances once across midnight and does not invent missed downtime history", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await seed(store);
    const daily = rule();
    daily.source = { ...daily.source, startDate: "2026-02-28", pattern: { kind: "daily" } };
    await applyNotionRules(store, connection(), [daily], [], at);
    const generate = (today: string) => store.transaction(() =>
      enqueueNotionRuleInstances(store, connection(), today, at));
    assert.equal(await generate("2026-02-28"), 32);
    assert.equal(await generate("2026-03-01"), 1);
    assert.equal((await store.listAllTasks()).length, 33);
    assert.equal(await generate("2026-04-10"), 32);
    assert.equal((await store.listAllTasks()).length, 65);
    assert.equal(await store.getTaskByOccurrenceKey(`${logicalSeriesId}:2026-04-09`), undefined);
    assert.ok(await store.getTaskByOccurrenceKey(`${logicalSeriesId}:2026-04-10`));
    assert.equal((await store.listNotionOutboxOperations()).length, 65);
  } finally { store.close(); }
});
