import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import type { PlannerCommand } from "@newday/core/application/planner-command";
import type { Task } from "@newday/core/domain/planner-model";
import { createApp } from "../src/app.js";
import { backup, createTask, now, task, today } from "./fixtures.js";

const client = "client-one";
const headers = { "x-newday-client": client };
const dayUrl = `/api/planner/day?selectedDate=${today}&asOfDate=${today}`;

function commands(app: FastifyInstance, values: PlannerCommand[], clientId = client, expectedTask?: Task) {
  return app.inject({ method: "POST", url: "/api/planner/commands", headers: { "x-newday-client": clientId }, payload: {
    commands: values, ...(expectedTask ? { expectedTask } : {}),
  } });
}

test("API commands, day view, focus, completion and undo preserve planner semantics", async (context) => {
  const app = createApp({ databasePath: ":memory:" });
  context.after(() => app.close());
  assert.deepEqual((await app.inject("/api/health")).json(), { status: "ok" });
  assert.equal((await commands(app, [createTask()])).statusCode, 200);
  assert.equal((await commands(app, [{ type: "setTodayFocus", input: { taskId: "task-1", date: today, now } }])).statusCode, 200);
  const before = (await app.inject(dayUrl)).json();
  assert.equal(before.counts.focus, 1);
  assert.equal(before.focus[0].task.id, "task-1");
  const completed = await commands(app, [{ type: "completeTask", input: { taskId: "task-1", completedOn: today, now } }]);
  assert.equal(completed.statusCode, 200);
  const after = (await app.inject(dayUrl)).json();
  assert.equal(after.counts.completed, 1);
  assert.equal(after.counts.focus, 0);
  const undone = await app.inject({ method: "POST", url: "/api/planner/undo", headers, payload: { receipt: completed.json().receipt } });
  assert.equal(undone.statusCode, 200);
  assert.equal((await app.inject(dayUrl)).json().counts.focus, 1);
});

test("a failed command batch rolls back prior writes and the API remains usable", async (context) => {
  const app = createApp({ databasePath: ":memory:" });
  context.after(() => app.close());
  const response = await commands(app, [createTask(), { type: "completeTask", input: { taskId: "missing", now } }]);
  assert.equal(response.statusCode, 400);
  assert.match(response.json().message, /任务不存在/);
  assert.equal((await app.inject(dayUrl)).json().counts.open, 0);
  assert.equal((await commands(app, [createTask()])).statusCode, 200);
});

test("task edits reject an opening snapshot made stale by another writer", async (context) => {
  const app = createApp({ databasePath: ":memory:" });
  context.after(() => app.close());
  assert.equal((await commands(app, [createTask()])).statusCode, 200);
  const openingSnapshot = (await app.inject(dayUrl)).json().open[0].task as Task;

  assert.equal((await commands(app, [{ type: "updateTask", input: {
    taskId: openingSnapshot.id,
    title: "服务器新标题",
    notes: "服务器新备注",
    startDate: "2026-09-09",
    endDate: "2026-09-09",
    now: "2026-09-08T08:00:01.000Z",
  } }])).statusCode, 200);

  const stale = await commands(app, [{ type: "updateTaskDetails", input: {
    taskId: openingSnapshot.id,
    title: "旧编辑器草稿",
    now: "2026-09-08T08:00:02.000Z",
  } }], client, openingSnapshot);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().message, "任务已在其他页面或后台同步更新；请关闭编辑窗口后重新打开");

  const current = (await app.inject("/api/planner/backup")).json().tasks[0] as Task;
  assert.equal(current.title, "服务器新标题");
  assert.equal(current.notes, "服务器新备注");
  assert.equal(current.startDate, "2026-09-09");

  const fresh = await commands(app, [{ type: "updateTaskDetails", input: {
    taskId: current.id,
    title: "基于新快照保存",
    now: "2026-09-08T08:00:03.000Z",
  } }], client, current);
  assert.equal(fresh.statusCode, 200);
  assert.equal((await app.inject("/api/planner/backup")).json().tasks[0].title, "基于新快照保存");
});

test("API-backed tasks persist when the independent backend restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-api-"));
  const databasePath = join(directory, "planner.sqlite");
  try {
    const first = createApp({ databasePath });
    assert.equal((await commands(first, [createTask()])).statusCode, 200);
    await first.close();
    const second = createApp({ databasePath });
    assert.equal((await second.inject(dayUrl)).json().open[0].task.id, "task-1");
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recurrence materializes the lookahead and requested future date once", async (context) => {
  const app = createApp({ databasePath: ":memory:", clock: () => Date.parse(now) });
  context.after(() => app.close());
  const created = await commands(app, [{ type: "createRecurrenceSeries", input: {
    id: "daily", title: "每天整理", startDate: today, pattern: { kind: "daily" }, end: { kind: "never" }, now,
  } }]);
  assert.equal(created.statusCode, 200);
  const futureUrl = `/api/planner/day?selectedDate=2026-12-01&asOfDate=${today}`;
  assert.equal((await app.inject(futureUrl)).json().open[0].task.id, "daily:2026-12-01");
  await Promise.all([app.inject(futureUrl), app.inject(futureUrl)]);
  const exported = (await app.inject("/api/planner/backup")).json();
  assert.equal(exported.tasks.length, 33);
  assert.equal(new Set(exported.tasks.map((value: { occurrenceKey: string }) => value.occurrenceKey)).size, 33);
  assert.equal((await app.inject("/api/planner/series/daily")).json().id, "daily");
  const missing = await app.inject("/api/planner/series/missing");
  assert.equal(missing.statusCode, 200);
  assert.equal(missing.json(), null);
});

test("recurrence stop preview guards stale impact and valid stop can be undone", async (context) => {
  const app = createApp({ databasePath: ":memory:", clock: () => Date.parse(now) });
  context.after(() => app.close());
  await commands(app, [{ type: "createRecurrenceSeries", input: {
    id: "daily", title: "每天整理", startDate: today, pattern: { kind: "daily" }, end: { kind: "never" }, now,
  } }]);
  await app.inject(dayUrl);
  const previewInput = { seriesId: "daily", endDate: "2026-09-09" };
  const preview = (await app.inject({ method: "POST", url: "/api/planner/stop-preview", payload: previewInput })).json();
  assert.equal(preview.openOrdinaryTaskCount, 30);
  const stale = await commands(app, [{ type: "stopRecurrenceSeries", input: { ...previewInput, expectedImpact: { ...preview, revision: "stale" }, now } }]);
  assert.equal(stale.statusCode, 409);
  const stopped = await commands(app, [{ type: "stopRecurrenceSeries", input: { ...previewInput, expectedImpact: preview, now } }]);
  assert.equal(stopped.statusCode, 200);
  assert.equal((await app.inject("/api/planner/backup")).json().tasks.length, 2);
  assert.equal((await app.inject({ method: "POST", url: "/api/planner/undo", headers, payload: { receipt: stopped.json().receipt } })).statusCode, 200);
  assert.equal((await app.inject("/api/planner/backup")).json().tasks.length, 32);
});

test("undo rejects wrong owners, reused tokens, expired tokens and superseded receipts", async (context) => {
  let time = Date.parse(now);
  const app = createApp({ databasePath: ":memory:", clock: () => time });
  context.after(() => app.close());
  await commands(app, [createTask()]);
  const complete = { type: "completeTask", input: { taskId: "task-1", now } } satisfies PlannerCommand;
  const first = (await commands(app, [complete])).json().receipt;
  const undo = (receipt: { token: string }, owner = client) => app.inject({ method: "POST", url: "/api/planner/undo", headers: { "x-newday-client": owner }, payload: { receipt } });
  assert.equal((await undo(first, "other-tab")).statusCode, 409);
  assert.equal((await undo(first)).statusCode, 200);
  assert.equal((await undo(first)).statusCode, 409);
  const expired = (await commands(app, [complete])).json().receipt;
  time += 10_001;
  assert.equal((await undo(expired)).statusCode, 409);
  const previous = (await commands(app, [{ type: "reopenTask", input: { taskId: "task-1", now } }])).json().receipt;
  const newest = (await commands(app, [complete], "other-tab")).json().receipt;
  assert.equal((await undo(previous)).statusCode, 409);
  assert.equal((await undo(newest, "other-tab")).statusCode, 200);
});

test("backup restore and first browser migration are atomic and never overwrite existing data", async (context) => {
  const app = createApp({ databasePath: ":memory:" });
  context.after(() => app.close());
  const migrate = (source: string) => app.inject({ method: "POST", url: "/api/planner/migrate", payload: { source } });
  const source = JSON.stringify(backup());
  const results = await Promise.all([migrate(source), migrate(source)]);
  assert.deepEqual(results.map((result) => result.json().status).sort(), ["already-imported", "imported"]);
  assert.equal((await app.inject("/api/planner/backup")).json().tasks.length, 1);
  const otherSource = JSON.stringify(backup([task("another-browser")]));
  assert.equal((await migrate(otherSource)).json().status, "server-not-empty");
  const invalid = await app.inject({ method: "POST", url: "/api/planner/backup", payload: { source: JSON.stringify(backup([task(), task()])) } });
  assert.equal(invalid.statusCode, 400);
  assert.equal((await app.inject("/api/planner/backup")).json().tasks.length, 1);
  assert.equal((await app.inject({ method: "POST", url: "/api/planner/backup", payload: { source: JSON.stringify(backup([])) } })).statusCode, 200);
  assert.equal((await migrate(source)).json().status, "already-imported");
  assert.equal((await migrate(otherSource)).json().status, "server-not-empty");
  assert.equal((await app.inject("/api/planner/backup")).json().tasks.length, 0);
});

test("a server with existing tasks declines migration without altering either archive", async (context) => {
  const app = createApp({ databasePath: ":memory:" });
  context.after(() => app.close());
  await commands(app, [createTask("server-task")]);
  const response = await app.inject({ method: "POST", url: "/api/planner/migrate", payload: { source: JSON.stringify(backup()) } });
  assert.equal(response.json().status, "server-not-empty");
  assert.deepEqual((await app.inject("/api/planner/backup")).json().tasks.map((value: { id: string }) => value.id), ["server-task"]);
});

test("API rejects invalid command variants, impossible dates and malformed inputs before mutations", async (context) => {
  const app = createApp({ databasePath: ":memory:" });
  context.after(() => app.close());
  const invalidBodies = [
    {}, { commands: [] }, { commands: [{ type: "unknown", input: {} }] },
    { commands: [{ type: "createTask", input: {} }] },
    { commands: [{ ...createTask(), input: { ...(createTask() as { input: object }).input, title: " " } }] },
    { commands: [{ type: "updateTaskDetails", input: { taskId: "task-1", now } }] },
    { commands: [{ type: "deleteTask", input: { taskId: 123 } }] },
    { commands: [{ type: "setTodayFocus", input: { taskId: "task-1", date: "2026-02-30", now } }] },
    { commands: [{ type: "createRecurrenceSeries", input: { id: "daily", title: "task", startDate: today, now, pattern: { kind: "weekly", weekdays: [3, 2] }, end: { kind: "never" } } }] },
  ];
  for (const payload of invalidBodies) {
    const response = await app.inject({ method: "POST", url: "/api/planner/commands", headers, payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal((await app.inject("/api/planner/day?selectedDate=2026-02-30&asOfDate=2026-09-08")).statusCode, 400);
  assert.equal((await app.inject("/api/planner/day")).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/planner/commands", payload: { commands: [createTask()] } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/planner/commands", headers: { ...headers, "content-type": "application/json" }, payload: "{bad" })).statusCode, 400);
  assert.equal((await app.inject("/api/planner/backup")).json().tasks.length, 0);
});

test("cross-origin writes, form submissions and oversized bodies are rejected", async (context) => {
  const app = createApp({ databasePath: ":memory:", bodyLimit: 1024 });
  context.after(() => app.close());
  const url = "/api/planner/commands";
  const payload = { commands: [createTask()] };
  assert.equal((await app.inject({ method: "POST", url, payload, headers: { ...headers, origin: "https://untrusted.example" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url, payload, headers: { ...headers, "sec-fetch-site": "cross-site" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: dayUrl, headers: { "sec-fetch-site": "cross-site" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url, payload: "commands=x", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" } })).statusCode, 415);
  assert.equal((await app.inject({ method: "POST", url, headers, payload: { ...payload, padding: "x".repeat(2_000) } })).statusCode, 413);
  const accepted = await app.inject({ method: "POST", url, payload, headers: { ...headers, origin: "http://localhost:3000" } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.headers["access-control-allow-origin"], undefined);
  assert.equal(accepted.headers["cache-control"], "no-store");
});

test("unexpected storage errors return a generic 500 without database details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-api-failure-"));
  const databasePath = join(directory, "planner.sqlite");
  const app = createApp({ databasePath });
  try {
    const otherConnection = new DatabaseSync(databasePath);
    otherConnection.exec("DROP TABLE tasks");
    otherConnection.close();
    const response = await app.inject(dayUrl);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { message: "服务器暂时无法完成请求" });
    assert.doesNotMatch(response.body, /sqlite|SELECT|tasks|stack/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
