import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

test("life workspace sorts inbox into shared tasks and resources, preserves links in backup", async (context) => {
  const app = createApp({ databasePath: ":memory:", clock: () => Date.parse("2026-09-20T08:00:00.000Z") });
  context.after(() => app.close());
  const post = (path: string, payload: object = {}) => app.inject({ method: "POST", url: `/api/life${path}`, payload });

  const root = (await post("/folders", { parentId: null, name: "健康" })).json();
  assert.equal((await post("/folders", { parentId: null, name: "健康" })).statusCode, 409);
  const child = (await post("/folders", { parentId: root.id, name: "运动" })).json();
  assert.equal((await post("/folders", { parentId: child.id, name: "第三层" })).statusCode, 400);

  const inbox = (await post("/inbox", { title: "训练记录", notes: "跑步五公里" })).json();
  const resource = (await post(`/inbox/${inbox.id}/resource`, { folderId: child.id, kind: "note", source: "手写笔记" })).json();
  assert.equal(resource.folderId, child.id);
  const fromResource = (await post("/inbox", { title: "回顾训练记录", notes: "复盘", sourceResourceId: resource.id })).json();
  const task = (await post(`/inbox/${fromResource.id}/task`, { startDate: "2026-09-21", endDate: "2026-09-21" })).json();
  assert.equal(task.title, "回顾训练记录");

  const workspace = (await app.inject("/api/life/workspace")).json();
  assert.equal(workspace.inboxItems.length, 0);
  assert.equal(workspace.folders.length, 2);
  assert.equal(workspace.resources.length, 1);
  assert.deepEqual(workspace.resourceTaskLinks, [{ resourceId: resource.id, taskId: task.id }]);
  assert.equal(workspace.tasks.some((value: { id: string }) => value.id === task.id), true);

  const day = (await app.inject("/api/planner/day?selectedDate=2026-09-21&asOfDate=2026-09-20")).json();
  assert.equal(day.open.some((value: { task: { id: string } }) => value.task.id === task.id), true);
  const headers = { "x-newday-client": "life-test-client" };
  const deleted = await app.inject({ method: "POST", url: "/api/planner/commands", headers, payload: {
    commands: [{ type: "deleteTask", input: { taskId: task.id } }],
  } });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual((await app.inject("/api/life/workspace")).json().resourceTaskLinks, []);
  assert.equal((await app.inject({ method: "POST", url: "/api/planner/undo", headers,
    payload: { receipt: deleted.json().receipt } })).statusCode, 200);
  assert.deepEqual((await app.inject("/api/life/workspace")).json().resourceTaskLinks, workspace.resourceTaskLinks);

  const backup = (await app.inject("/api/planner/backup")).json();
  assert.equal(backup.version, 5);
  assert.deepEqual(backup.resources, [resource]);
  assert.deepEqual(backup.resourceTaskLinks, workspace.resourceTaskLinks);

  assert.equal((await app.inject({ method: "POST", url: "/api/planner/backup", payload: { source: JSON.stringify({
    ...backup, inboxItems: [], folders: [], resources: [], resourceTaskLinks: [], tasks: [],
  }) } })).statusCode, 200);
  assert.equal((await app.inject("/api/life/workspace")).json().resources.length, 0);
  assert.equal((await app.inject({ method: "POST", url: "/api/planner/backup", payload: { source: JSON.stringify(backup) } })).statusCode, 200);
  assert.deepEqual((await app.inject("/api/life/workspace")).json().resourceTaskLinks, workspace.resourceTaskLinks);
});

test("invalid life references reject before changing the workspace", async (context) => {
  const app = createApp({ databasePath: ":memory:" });
  context.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/life/resources", payload: {
    folderId: "missing", kind: "note", title: "资料", content: "内容", source: "",
  } });
  assert.equal(response.statusCode, 400);
  assert.equal((await app.inject("/api/life/workspace")).json().resources.length, 0);
  const invalid = await app.inject({ method: "POST", url: "/api/life/inbox", payload: { title: "  ", notes: "" } });
  assert.equal(invalid.statusCode, 400);
});
