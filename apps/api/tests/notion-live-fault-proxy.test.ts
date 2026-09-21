import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NotionConnection } from "@newday/core/contracts/notion-sync";

import { NotionReadFailure, NotionSdkReadGateway } from "../src/services/notion-read-gateway.js";
import { NotionReadService } from "../src/services/notion-read-service.js";
import { NotionCredentialVault } from "../src/storage/notion-credential-vault.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";
import { createNotionFaultProxy, type NotionFaultRule } from "../../../tooling/notion-live-fault-proxy.mjs";

const at = "2026-09-21T00:00:00.000Z";

function connection(): NotionConnection {
  const ref = (name: string, propertyIds: Record<string, string>) => ({
    databaseId: `database-${name}`, dataSourceId: `source-${name}`,
    propertyIds, schemaFingerprint: `fingerprint-${name}`,
  });
  return { workspaceId: "proxy-workspace", installationId: "proxy-install", rootPageId: "proxy-root",
    credentialRevision: 2, status: "active", updatedAt: at, dataSources: {
      areas: ref("areas", { Name: "area-title" }),
      projects: ref("projects", { Name: "project-title", Area: "project-area" }),
      tasks: ref("tasks", { Name: "task-title", "Plan Date": "task-date", Completed: "task-completed",
        Project: "task-project", "Direct Area": "task-area", Rule: "task-rule", "NewDay Key": "task-key",
        "Occurrence Key": "task-occurrence" }),
      rules: ref("rules", { Name: "rule-title", "Active Dates": "rule-dates", Pattern: "rule-pattern",
        Weekdays: "rule-weekdays", "Month Day": "rule-month-day", "Excluded Dates": "rule-excluded" }),
    } };
}

function title(text: string) {
  return [{ type: "text", text: { content: text, link: null }, annotations: {
    bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default",
  }, plain_text: text, href: null }];
}

function responseJson(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json", "x-request-id": "test-request-id",
  } });
}

async function listen(server: ReturnType<typeof createNotionFaultProxy>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createNotionFaultProxy>) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function evidence(path: string) {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("partial pagination fault fails the real SDK gateway after one genuine page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-proxy-page-"));
  const evidencePath = join(directory, "evidence.jsonl");
  let queryUpstreamCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/data_sources/source-areas") {
      return responseJson({ object: "data_source", id: "source-areas", properties: {
        Name: { id: "area-title", name: "Name", type: "title", title: {} },
      } });
    }
    assert.equal(url.pathname, "/v1/data_sources/source-areas/query");
    queryUpstreamCalls += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.page_size, 1);
    return responseJson({ object: "list", type: "page_or_database", page_or_database: {},
      results: [{ object: "page", id: "remote-area-one", created_time: at, last_edited_time: at,
        created_by: { object: "user", id: "user-one" }, last_edited_by: { object: "user", id: "user-one" },
        cover: null, icon: null, parent: { type: "data_source_id", data_source_id: "source-areas",
          database_id: "database-areas" }, archived: false, in_trash: false,
        properties: { Name: { id: "area-title", type: "title", title: title("生活") } },
        url: "https://www.notion.so/remote-area-one", public_url: null }],
      next_cursor: "real-followup-cursor", has_more: true, request_status: { type: "complete" } });
  };
  const rules: NotionFaultRule[] = [{ id: "partial_page", method: "POST",
    pattern: /^\/v1\/data_sources\/source-areas\/query$/, action: "partial_pagination_after_upstream",
    times: 1, after: 0 }];
  const server = createNotionFaultProxy({ rules, evidencePath, fetcher });
  const credentials = new NotionCredentialVault(":memory:", Buffer.alloc(32, 19));
  const store = new SQLitePlannerStore(":memory:");
  try {
    const baseUrl = await listen(server);
    const gateway = new NotionSdkReadGateway(async () => undefined, { baseUrl });
    const state = "p".repeat(43);
    credentials.putPending(state, "proxy-verifier", Date.parse(at) + 60_000, Date.parse(at));
    credentials.storeClaimed(state, { access_token: "private-test-token", refresh_token: "private-refresh-token",
      bot_id: "proxy-bot", workspace_id: "proxy-workspace", workspace_name: "隔离验收" }, at);
    await store.putNotionConnection(connection());
    await store.putNotionScanWatermark({ workspaceId: "proxy-workspace", dataSourceId: "source-areas",
      completedThrough: at, lastAttemptAt: at, lastSuccessAt: at, lastError: null, lastErrorAt: null });
    const service = new NotionReadService(store, credentials, gateway, () => Date.parse("2026-09-21T01:00:00.000Z"));
    await assert.rejects(service.scan("proxy-workspace"), (error: unknown) =>
      error instanceof NotionReadFailure && error.category === "network");
    assert.equal(queryUpstreamCalls, 1);
    const watermark = (await store.listNotionScanWatermarks()).find((item) => item.dataSourceId === "source-areas");
    assert.equal(watermark?.lastSuccessAt, at);
    assert.equal(watermark?.completedThrough, at);
    assert.equal(watermark?.lastError, "network");
    const records = await evidence(evidencePath);
    assert.equal(records.length, 3); // schema pass-through, first page, blocked follow-up
    assert.deepEqual(records.slice(1).map((record) => ({
      upstreamReached: record.upstreamReached,
      upstreamSucceeded: record.upstreamSucceeded,
      downstream: record.downstream,
      faultSatisfied: record.faultSatisfied,
    })), [
      { upstreamReached: true, upstreamSucceeded: true, downstream: "partial_page_forwarded", faultSatisfied: true },
      { upstreamReached: false, upstreamSucceeded: null, downstream: "pagination_followup_dropped", faultSatisfied: true },
    ]);
    assert.equal((await readFile(evidencePath, "utf8")).includes("private-test-token"), false);
  } finally {
    store.close();
    credentials.close();
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("write response loss only drops a successful upstream response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-proxy-write-"));
  const evidencePath = join(directory, "evidence.jsonl");
  let upstreamCalls = 0;
  const fetcher: typeof fetch = async () => {
    upstreamCalls += 1;
    return upstreamCalls === 1
      ? responseJson({ object: "error", status: 401, code: "unauthorized", message: "rejected" }, 401)
      : responseJson({ object: "page", id: "created-page" }, 200);
  };
  const rules: NotionFaultRule[] = [{ id: "write_loss", method: "POST", pattern: /^\/v1\/pages$/,
    action: "drop_after_upstream", times: 2, after: 0 }];
  const server = createNotionFaultProxy({ rules, evidencePath, fetcher });
  try {
    const baseUrl = await listen(server);
    const rejected = await fetch(`${baseUrl}/v1/pages`, { method: "POST", body: "{}",
      headers: { authorization: "Bearer private-test-token", "content-type": "application/json" } });
    assert.equal(rejected.status, 401);
    await assert.rejects(fetch(`${baseUrl}/v1/pages`, { method: "POST", body: "{}",
      headers: { authorization: "Bearer private-test-token", "content-type": "application/json" } }));
    const records = await evidence(evidencePath);
    assert.deepEqual(records.map((record) => ({ upstreamStatus: record.upstreamStatus,
      upstreamSucceeded: record.upstreamSucceeded, downstream: record.downstream,
      faultSatisfied: record.faultSatisfied })), [
      { upstreamStatus: 401, upstreamSucceeded: false, downstream: "forwarded_fault_precondition_failed",
        faultSatisfied: false },
      { upstreamStatus: 200, upstreamSucceeded: true, downstream: "connection_dropped", faultSatisfied: true },
    ]);
    assert.equal((await readFile(evidencePath, "utf8")).includes("private-test-token"), false);
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
