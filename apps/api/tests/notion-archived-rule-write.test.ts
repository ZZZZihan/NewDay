import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Client, UpdatePageParameters } from "@notionhq/client";

import { AGENT_NAMESPACES } from "@newday/core/contracts/agent-planning";
import { notionLogicalSeriesId, type NotionConnection } from "@newday/core/contracts/notion-sync";

import { NotionOutboxDispatcher } from "../src/services/notion-outbox-dispatcher.js";
import { type NotionReadGateway, type ReadRow, type ReadTable, type TaskRow } from "../src/services/notion-read-gateway.js";
import { NotionReadService } from "../src/services/notion-read-service.js";
import { NotionSyncService } from "../src/services/notion-sync-service.js";
import { NotionSdkTaskTransport } from "../src/services/notion-task-transport.js";
import { PlannerService } from "../src/services/planner-service.js";
import { NotionCredentialVault } from "../src/storage/notion-credential-vault.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";

const at = "2026-02-01T00:00:00.000Z";
const workspaceId = "archived-rule-workspace";
const ruleId = "monthly-rule";
const occurrenceKey = `${notionLogicalSeriesId(workspaceId, ruleId)}:2026-02-28`;
const taskPropertyNames = ["Name", "Plan Date", "Completed", "NewDay Key", "Occurrence Key", "Project", "Direct Area", "Rule"];

function connection(): NotionConnection {
  const ref = (name: string) => ({ databaseId: `${name}-database`, dataSourceId: `${name}-source`,
    propertyIds: name === "tasks" ? Object.fromEntries(taskPropertyNames.map((name) => [name, name]))
      : { Name: `${name}-name` }, schemaFingerprint: `${name}-fingerprint` });
  return { workspaceId, installationId: "rules-installation", rootPageId: "rules-root",
    credentialRevision: 2, status: "active", updatedAt: at, dataSources: {
      areas: ref("areas"), projects: ref("projects"), rules: ref("rules"), tasks: ref("tasks"),
    } };
}

function task(id = "remote-month-end"): TaskRow {
  const isInstance = id === "remote-month-end";
  return { id, url: `https://www.notion.so/${id}`, createdAt: at, editedAt: at,
    inTrash: false, kind: "task", title: isInstance ? "月底回顾" : "后续普通任务",
    date: ["2026-02-28", "2026-02-28"], completed: false, projectIds: [], directAreaIds: [],
    ruleIds: isInstance ? [ruleId] : [], occurrenceKey: isInstance ? occurrenceKey : null, clientKey: null };
}

class Gateway implements NotionReadGateway {
  rows: Record<ReadTable, ReadRow[]> = { areas: [], projects: [], tasks: [task(), task("remote-next-task")],
    rules: [{ id: ruleId, url: `https://www.notion.so/${ruleId}`, createdAt: at, editedAt: at,
      inTrash: false, kind: "rule", source: { title: "月底回顾", startDate: "2026-02-01", endDate: null,
        pattern: { kind: "monthly", dayOfMonth: 31 }, excludedDates: [] } }] };
  async scan(_token: string, _connection: NotionConnection, table: ReadTable) {
    return structuredClone(this.rows[table]);
  }
  async readKnownPage(_token: string, pageId: string) {
    return pageId === ruleId && this.rows.rules.length === 0 ? { id: ruleId, inTrash: true } : null;
  }
}

function rawPage(row: TaskRow) {
  return { object: "page", id: row.id, url: row.url, created_time: at, last_edited_time: at,
    in_trash: false, parent: { type: "data_source_id", data_source_id: "tasks-source" }, properties: {
      Name: { id: "Name", type: "title", title: [{ plain_text: row.title }] },
      "Plan Date": { id: "Plan Date", type: "date", date: { start: row.date![0], end: row.date![1] } },
      Completed: { id: "Completed", type: "checkbox", checkbox: row.completed },
      "NewDay Key": { id: "NewDay Key", type: "rich_text", rich_text: row.clientKey ? [{ plain_text: row.clientKey }] : [] },
      "Occurrence Key": { id: "Occurrence Key", type: "rich_text", rich_text: row.occurrenceKey ? [{ plain_text: row.occurrenceKey }] : [] },
      Project: { id: "Project", type: "relation", relation: [] },
      "Direct Area": { id: "Direct Area", type: "relation", relation: [] },
      Rule: { id: "Rule", type: "relation", relation: row.ruleIds.map((id) => ({ id })) },
    } };
}

async function fixture(databasePath = ":memory:", archive = true) {
  const store = new SQLitePlannerStore(databasePath);
  const credentials = new NotionCredentialVault(":memory:", Buffer.alloc(32, 41));
  const state = "s".repeat(43);
  credentials.putPending(state, "rules-verifier", Date.parse(at) + 60_000, Date.parse(at));
  credentials.storeClaimed(state, { access_token: "synthetic-rules-access", refresh_token: "synthetic-rules-refresh",
    bot_id: "rules-bot", workspace_id: workspaceId, workspace_name: "隔离规则测试" }, at);
  await store.putNotionConnection(connection());
  await store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", { timeZone: "Asia/Shanghai" });
  const gateway = new Gateway();
  const reader = new NotionReadService(store, credentials, gateway, () => Date.parse(at));
  await reader.scan(workspaceId);
  if (archive) {
    gateway.rows.rules = [];
    gateway.rows.tasks = gateway.rows.tasks.map((row) => ({ ...row, ruleIds: [] }));
    await reader.scan(workspaceId);
  }
  const mapping = (await store.listNotionTaskMappings()).find((item) => item.remotePageId === "remote-month-end")!;
  assert.equal(mapping.status, "active");
  assert.equal(mapping.occurrenceKey, occurrenceKey);
  assert.equal((await store.listNotionRuleMappings(workspaceId))[0]?.status, archive ? "archived" : "active");
  const pages = new Map((gateway.rows.tasks as TaskRow[]).map((row) => [row.id, rawPage(row)]));
  const remote = { pages, writes: [] as UpdatePageParameters[], failRead: false };
  const client = { dataSources: {
    async retrieve() { return { properties: { Name: { id: "rules-name", type: "title" } } }; },
    async query({ data_source_id }: { data_source_id: string }) {
      return { results: data_source_id === "tasks-source" ? [pages.get(mapping.remotePageId!)] : [], has_more: false };
    },
  }, pages: {
    async retrieve({ page_id }: { page_id: string }) {
      if (remote.failRead) throw new Error("synthetic preflight read unavailable");
      return structuredClone(pages.get(page_id));
    },
    async update(params: UpdatePageParameters) {
      remote.writes.push(structuredClone(params));
      const raw = pages.get(params.page_id)!;
      const properties = params.properties!;
      if (properties.Completed && "checkbox" in properties.Completed) raw.properties.Completed.checkbox = properties.Completed.checkbox!;
      if (properties["Plan Date"] && "date" in properties["Plan Date"] && properties["Plan Date"].date) {
        const date = properties["Plan Date"].date;
        raw.properties["Plan Date"].date = { start: date.start!, end: date.end ?? date.start! };
      }
      return structuredClone(raw);
    },
  } } as unknown as Client;
  const sdk = new NotionSdkTaskTransport(credentials, () => client, store);
  return { store, credentials, mapping, remote, client, sdk };
}

async function complete(store: SQLitePlannerStore, taskId: string) {
  await new PlannerService(store, () => Date.parse(at)).commands([{ type: "completeTask",
    input: { taskId, now: at, asOfDate: "2026-02-01" } }], "archived-rule-test");
  return (await store.listNotionOutboxOperations()).find((item) => item.localTaskId === taskId && item.status === "pending")!;
}

test("an archived rule with a hidden relation permits confirmed completion, reopen, reschedule and the next task", async () => {
  const { store, credentials, mapping, remote, sdk } = await fixture();
  try {
    const dispatcher = new NotionOutboxDispatcher(store, sdk, () => at);
    const completed = await complete(store, mapping.localTaskId);
    assert.equal(await dispatcher.dispatch(completed.operationId), "confirmed");
    assert.equal(remote.pages.get(mapping.remotePageId!)!.properties.Completed.checkbox, true);
    const planner = new PlannerService(store, () => Date.parse(at));
    await planner.commands([{ type: "reopenTask", input: { taskId: mapping.localTaskId, now: at } }], "archived-rule-test");
    const reopened = (await store.listNotionOutboxOperations()).find((item) => item.status === "pending")!;
    assert.equal(await dispatcher.dispatch(reopened.operationId), "confirmed");
    assert.equal(remote.pages.get(mapping.remotePageId!)!.properties.Completed.checkbox, false);
    await planner.commands([{ type: "rescheduleTask", input: { taskId: mapping.localTaskId,
      startDate: "2026-03-02", endDate: "2026-03-02", now: at } }], "archived-rule-test",
    { expectedTask: (await store.getTask(mapping.localTaskId))! });
    const moved = (await store.listNotionOutboxOperations()).find((item) => item.status === "pending")!;
    assert.equal(await dispatcher.dispatch(moved.operationId), "confirmed");
    assert.deepEqual(remote.pages.get(mapping.remotePageId!)!.properties["Plan Date"].date,
      { start: "2026-03-02", end: "2026-03-02" });
    const next = (await store.listNotionTaskMappings()).find((item) => item.remotePageId === "remote-next-task")!;
    const nextOperation = await complete(store, next.localTaskId);
    assert.equal(await dispatcher.dispatch(nextOperation.operationId), "confirmed");
    assert.equal(remote.pages.get(next.remotePageId!)!.properties.Completed.checkbox, true);
    assert.equal(remote.writes.length, 4);
    assert.ok(remote.writes.every((write) => Object.keys(write.properties!).every((name) => ["Completed", "Plan Date"].includes(name))),
      "writes do not reconstruct or overwrite hidden identity properties");
    const confirmed = (await store.getNotionTaskMapping(mapping.localTaskId))!;
    assert.equal(confirmed.rulePageId, ruleId);
    assert.equal(confirmed.occurrenceKey, occurrenceKey);
    assert.deepEqual(confirmed.baseline, { title: "月底回顾", date: ["2026-03-02", "2026-03-02"], completed: false });
    assert.equal((await store.getTask(mapping.localTaskId))?.occurrenceDate, "2026-02-28");
    assert.equal((await store.getNotionConnection(workspaceId))?.status, "active");
    assert.ok((await store.listNotionOutboxOperations()).every((item) => item.status === "confirmed"));
  } finally { store.close(); credentials.close(); }
});

test("archived rule identity survives restart and permits a pending operation after preflight pause and resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-archived-rule-write-"));
  const databasePath = join(directory, "planner.sqlite");
  const seeded = await fixture(databasePath);
  let store = seeded.store;
  try {
    const operation = await complete(store, seeded.mapping.localTaskId);
    store.close();
    store = new SQLitePlannerStore(databasePath);
    const sdk = new NotionSdkTaskTransport(seeded.credentials, () => seeded.client, store);
    let dispatcher = new NotionOutboxDispatcher(store, sdk, () => at);
    seeded.remote.failRead = true;
    assert.equal(await dispatcher.dispatch(operation.operationId), "paused");
    assert.equal((await store.getNotionConnection(workspaceId))?.pauseReason, "preflight_read");
    assert.equal(seeded.remote.writes.length, 0);
    store.close();
    store = new SQLitePlannerStore(databasePath);
    dispatcher = new NotionOutboxDispatcher(store,
      new NotionSdkTaskTransport(seeded.credentials, () => seeded.client, store), () => at);
    seeded.remote.failRead = false;
    await new NotionSyncService(store, dispatcher).resume(workspaceId);
    assert.equal(await dispatcher.dispatch(operation.operationId), "confirmed");
    assert.equal(seeded.remote.writes.length, 1);
    assert.equal((await store.getNotionConnection(workspaceId))?.status, "active");
    assert.equal((await store.getNotionOutboxOperation(operation.operationId))?.status, "confirmed");
    assert.equal(seeded.remote.pages.get(seeded.mapping.remotePageId!)!.properties.Completed.checkbox, true);
  } finally { store.close(); seeded.credentials.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const scenario of ["active rule", "unknown rule", "wrong rule", "multiple rules", "wrong occurrence", "missing occurrence", "wrong page", "wrong client key"] as const) {
  test(`a hidden relation exception still rejects ${scenario} without writing`, async () => {
    const { store, credentials, mapping, remote, client } = await fixture(":memory:", scenario !== "active rule");
    try {
      const raw = remote.pages.get(mapping.remotePageId!)!;
      raw.properties.Rule.relation = [];
      if (scenario === "wrong rule") raw.properties.Rule.relation = [{ id: "other-rule" }];
      if (scenario === "multiple rules") raw.properties.Rule.relation = [{ id: ruleId }, { id: "other-rule" }];
      if (scenario === "wrong occurrence") raw.properties["Occurrence Key"].rich_text = [{ plain_text: `${occurrenceKey}-other` }];
      if (scenario === "missing occurrence") raw.properties["Occurrence Key"].rich_text = [];
      if (scenario === "wrong page") raw.id = "different-page";
      if (scenario === "wrong client key") raw.properties["NewDay Key"].rich_text = [{ plain_text: "different-client-key" }];
      const ruleStore = scenario === "unknown rule" ? { async listNotionRuleMappings() { return []; } } : store;
      const sdk = new NotionSdkTaskTransport(credentials, () => client, ruleStore);
      const operation = await complete(store, mapping.localTaskId);
      const result = await new NotionOutboxDispatcher(store, sdk, () => at).dispatch(operation.operationId);
      assert.ok(result === "paused" || result === "unknown", result);
      assert.equal(remote.writes.length, 0);
      assert.notEqual((await store.getNotionOutboxOperation(operation.operationId))?.status, "confirmed");
      assert.equal(remote.pages.get(mapping.remotePageId!)!.properties.Completed.checkbox, false);
    } finally { store.close(); credentials.close(); }
  });
}

test("key search cannot infer a previously unverified instance from a hidden archived rule relation", async () => {
  const { store, credentials, mapping, remote, sdk } = await fixture();
  try {
    remote.pages.get(mapping.remotePageId!)!.properties["NewDay Key"].rich_text = [{ plain_text: mapping.clientKey }];
    await assert.rejects(sdk.findByClientKey(connection(), { ...mapping,
      remotePageId: null, baseline: null, status: "pending_create" }), /rule identity/);
    assert.equal(remote.writes.length, 0);
  } finally { store.close(); credentials.close(); }
});
