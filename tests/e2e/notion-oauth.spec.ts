import { expect, test } from "./fixtures";

const state = "s".repeat(43);
const ticket = "t".repeat(43);

test("OAuth return clears the one-time ticket before claiming and only shows a connection summary", async ({ page }) => {
  let claimed = false;
  await page.route("**/api/notion/status", async (route) => {
    await route.fulfill({ json: { configured: true, connections: claimed ? [{
      workspaceId: "workspace-test", workspaceName: "隔离测试空间", botId: "bot-test",
      status: "active", updatedAt: "2026-09-21T00:00:00.000Z",
    }] : [] } });
  });
  await page.route("**/api/notion/oauth/claim", async (route) => {
    expect(page.url()).not.toContain("notion-oauth=");
    expect(route.request().postDataJSON()).toEqual({ state, ticket });
    claimed = true;
    await route.fulfill({ json: { connection: {
      workspaceId: "workspace-test", workspaceName: "隔离测试空间", botId: "bot-test",
      status: "active", updatedAt: "2026-09-21T00:00:00.000Z",
    } } });
  });
  await page.goto(`/#notion-oauth=ready:${state}:${ticket}`);
  await expect(page.getByRole("heading", { name: "Notion 连接" })).toBeVisible();
  await expect(page.getByText("隔离测试空间")).toBeVisible();
  await expect(page.getByText("已授权；结构就绪后可同步一次性任务")).toBeVisible();
  expect(page.url()).not.toContain(ticket);
  expect(await page.locator("body").innerText()).not.toContain(ticket);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test("authorized workspace shows explicit structure creation and readback progress", async ({ page }) => {
  const connection = { workspaceId: "workspace-test", workspaceName: "隔离测试空间", botId: "bot-test",
    status: "active", updatedAt: "2026-09-21T00:00:00.000Z" };
  await page.route("**/api/notion/status", (route) => route.fulfill({ json: { configured: true, connections: [connection] } }));
  const progress = (completedSteps: string[], state: string, nextStep: string | null) => ({
    workspaceId: "workspace-test", state, nextStep, reviewReason: null, retryAfterAt: null,
    rootPageId: completedSteps.length ? "root-id" : null,
    dataSources: {}, completedSteps,
  });
  await page.route("**/api/notion/connections/workspace-test/structure", (route) =>
    route.fulfill({ json: progress([], "not_started", "root") }));
  let advances = 0;
  await page.route("**/api/notion/connections/workspace-test/structure/advance", (route) => {
    advances += 1;
    return route.fulfill({ json: advances === 1 ? progress(["root"], "in_progress", "areas")
      : progress(["root", "areas", "projects", "tasks", "rules", "projects_area", "tasks_project", "tasks_direct_area", "tasks_rule"], "ready", null) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Notion 连接" }).click();
  await expect(page.getByText("结构初始化：0/9 步已确认")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "建立或继续结构" }).click();
  await expect(page.getByText("私有根页面和四张关联表已确认")).toBeVisible();
  expect(advances).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test("structure review stops after one read-only advance before the next creation step", async ({ page }) => {
  const workspaceId = "workspace-review";
  await page.route("**/api/notion/status", (route) => route.fulfill({ json: { configured: true, connections: [{
    workspaceId, workspaceName: "结构复核空间", botId: "bot-test", status: "active",
    updatedAt: "2026-09-21T00:00:00.000Z",
  }] } }));
  const progress = (state: string, completedSteps: string[], nextStep: string, reviewReason: string | null) => ({
    workspaceId, state, nextStep, reviewReason, retryAfterAt: null, rootPageId: "root-id", dataSources: {}, completedSteps,
  });
  await page.route(`**/api/notion/connections/${workspaceId}/structure`, (route) =>
    route.fulfill({ json: progress("needs_review", ["root"], "areas", "request_unknown") }));
  let advances = 0;
  await page.route(`**/api/notion/connections/${workspaceId}/structure/advance`, (route) => {
    advances += 1;
    return route.fulfill({ json: progress("in_progress", ["root", "areas"], "projects", null) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Notion 连接" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "重新核对" }).click();
  await expect(page.getByText("本次只核对了已有结构尝试")).toBeVisible();
  expect(advances).toBe(1);
});

test("Notion panel exposes a manual pause and explicit resume", async ({ page }) => {
  const workspaceId = "workspace-pause";
  let connectionStatus: "active" | "paused" = "active";
  let pauseReason: "manual" | null = null;
  await page.route("**/api/notion/status", (route) => route.fulfill({ json: { configured: true, connections: [{
    workspaceId, workspaceName: "暂停测试空间", botId: "bot-test", status: "active",
    updatedAt: "2026-09-21T00:00:00.000Z",
  }] } }));
  await page.route(`**/api/notion/connections/${workspaceId}/structure`, (route) =>
    route.fulfill({ json: { workspaceId, state: "ready", nextStep: null, reviewReason: null,
      retryAfterAt: null, rootPageId: "root-id", dataSources: {}, completedSteps: [] } }));
  await page.route(`**/api/notion/connections/${workspaceId}/read`, (route) =>
    route.fulfill({ json: { workspaceId, connectionStatus, pauseReason, sources: [] } }));
  const syncStatus = () => ({ workspaceId, connectionStatus, pauseReason, operations: [], conflicts: [] });
  await page.route(`**/api/notion/connections/${workspaceId}/sync`, (route) => route.fulfill({ json: syncStatus() }));
  await page.route(`**/api/notion/connections/${workspaceId}/sync/pause`, (route) => {
    connectionStatus = "paused";
    pauseReason = "manual";
    return route.fulfill({ json: syncStatus() });
  });
  await page.route(`**/api/notion/connections/${workspaceId}/sync/resume`, (route) => {
    connectionStatus = "active";
    pauseReason = null;
    return route.fulfill({ json: syncStatus() });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Notion 连接" }).click();
  await page.getByRole("button", { name: "暂停同步" }).click();
  await expect(page.getByText("已手动暂停；不再启动新一轮读取或发送")).toBeVisible();
  await page.getByRole("button", { name: "恢复发送" }).click();
  await expect(page.getByText("写回：可发送")).toBeVisible();
});

test("preflight pause keeps local Notion save and resume controls available", async ({ page }) => {
  const workspaceId = "workspace-offline";
  const connection = { workspaceId, workspaceName: "离线测试空间", botId: "bot-test",
    status: "active", updatedAt: "2026-09-21T00:00:00.000Z" };
  await page.route("**/api/notion/status", (route) =>
    route.fulfill({ json: { configured: true, connections: [connection] } }));
  await page.route(`**/api/notion/connections/${workspaceId}/structure`, (route) =>
    route.fulfill({ json: { workspaceId, state: "ready", nextStep: null, reviewReason: null,
      retryAfterAt: null, rootPageId: "root-id", dataSources: {}, completedSteps: [] } }));
  await page.route(`**/api/notion/connections/${workspaceId}/read`, (route) =>
    route.fulfill({ json: { workspaceId, connectionStatus: "paused", pauseReason: "preflight_read",
      sources: [{ table: "tasks", dataSourceId: "tasks-source", watermark: {
        completedThrough: "2026-09-21T00:00:00.000Z", lastAttemptAt: "2026-09-21T00:00:00.000Z",
        lastSuccessAt: "2026-09-21T00:00:00.000Z", lastError: "local", lastErrorAt: "2026-09-21T00:00:00.000Z",
      } }] } }));
  await page.route(`**/api/notion/connections/${workspaceId}/sync`, (route) =>
    route.fulfill({ json: { workspaceId, connectionStatus: "paused", pauseReason: "preflight_read",
      operations: [{ operationId: "newer-intent", localTaskId: "local-task", status: "pending",
        attemptCount: 0, createdAt: "2026-09-21T00:00:00.000Z", lastAttemptAt: null }], conflicts: [] } }));
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "保存位置" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Notion：离线测试空间" })).toBeAttached();
  await page.getByRole("button", { name: "Notion 连接" }).click();
  await expect(page.getByRole("button", { name: "恢复发送" })).toBeVisible();
});

test("quick add falls back to local storage when the selected Notion workspace becomes unavailable", async ({ page }) => {
  const workspaceId = "workspace-test";
  const connection = { workspaceId, workspaceName: "隔离测试空间", botId: "bot-test",
    status: "active", updatedAt: "2026-09-21T00:00:00.000Z" };
  let connectionStatus: "active" | "paused_unknown" = "active";
  await page.route("**/api/notion/status", (route) =>
    route.fulfill({ json: { configured: true, connections: [connection] } }));
  await page.route(`**/api/notion/connections/${workspaceId}/structure`, (route) =>
    route.fulfill({ json: { workspaceId, state: "ready", nextStep: null, reviewReason: null,
      retryAfterAt: null, rootPageId: "root-id", dataSources: {}, completedSteps: [] } }));
  await page.route(`**/api/notion/connections/${workspaceId}/read`, (route) =>
    route.fulfill({ json: { workspaceId, connectionStatus: "active", pauseReason: null,
      sources: [{ table: "tasks", dataSourceId: "tasks-source", watermark: {
        completedThrough: "2026-09-21T00:00:00.000Z", lastAttemptAt: "2026-09-21T00:00:00.000Z",
        lastSuccessAt: "2026-09-21T00:00:00.000Z", lastError: null, lastErrorAt: null,
      } }] } }));
  await page.route(`**/api/notion/connections/${workspaceId}/sync`, (route) =>
    route.fulfill({ json: { workspaceId, connectionStatus, pauseReason: null,
      operations: [], conflicts: [] } }));
  await page.goto("/");
  const storage = page.getByRole("combobox", { name: "保存位置" });
  await expect(storage).toBeVisible();
  await storage.selectOption(workspaceId);
  connectionStatus = "paused_unknown";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(storage).toHaveCount(0);
  await page.getByRole("button", { name: "Notion 连接" }).click();
  await expect(page.getByText("写入结果待核对；已暂停发送")).toBeVisible();
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(storage).toHaveCount(0);
  await page.getByRole("textbox", { name: "添加一件要做的事" }).fill("本机新任务");
  const request = page.waitForRequest((candidate) => candidate.url().endsWith("/api/planner/commands") &&
    candidate.method() === "POST");
  await page.getByRole("button", { name: "添加任务" }).click();
  const commands = (await (await request).postDataJSON()).commands;
  expect(commands[0].input.notionWorkspaceId).toBeUndefined();
  await expect(page.getByText("本机新任务", { exact: true })).toBeVisible();
  connectionStatus = "active";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(storage).toBeVisible();
  await expect(storage).toHaveValue("");
});

test("an older status refresh cannot hide a successful manual scan", async ({ page }) => {
  const workspaceId = "workspace-scan";
  const connection = { workspaceId, workspaceName: "扫描测试空间", botId: "bot-test",
    status: "active", updatedAt: "2026-09-21T00:00:00.000Z" };
  let scanned = false;
  let holdSync = false;
  let releaseSync!: () => void;
  let syncHeld!: () => void;
  const held = new Promise<void>((resolve) => { syncHeld = resolve; });
  const released = new Promise<void>((resolve) => { releaseSync = resolve; });
  let oldRefreshReturned!: () => void;
  const oldRefresh = new Promise<void>((resolve) => { oldRefreshReturned = resolve; });
  const readStatus = (success: boolean) => ({ workspaceId, connectionStatus: "active", pauseReason: null,
    sources: [{ table: "tasks", dataSourceId: "tasks-source", watermark: {
      completedThrough: success ? "2026-09-21T00:00:00.000Z" : null,
      lastAttemptAt: "2026-09-21T00:00:00.000Z",
      lastSuccessAt: success ? "2026-09-21T00:00:00.000Z" : null,
      lastError: null, lastErrorAt: null,
    } }] });
  await page.route("**/api/notion/status", (route) =>
    route.fulfill({ json: { configured: true, connections: [connection] } }));
  await page.route(`**/api/notion/connections/${workspaceId}/structure`, (route) =>
    route.fulfill({ json: { workspaceId, state: "ready", nextStep: null, reviewReason: null,
      retryAfterAt: null, rootPageId: "root-id", dataSources: {}, completedSteps: [] } }));
  await page.route(`**/api/notion/connections/${workspaceId}/read`, (route) =>
    route.fulfill({ json: readStatus(scanned) }));
  await page.route(`**/api/notion/connections/${workspaceId}/sync`, async (route) => {
    if (holdSync) {
      holdSync = false;
      syncHeld();
      await released;
      await route.fulfill({ json: { workspaceId, connectionStatus: "active", pauseReason: null,
        operations: [], conflicts: [] } });
      oldRefreshReturned();
    } else await route.fulfill({ json: { workspaceId, connectionStatus: "active", pauseReason: null,
      operations: [], conflicts: [] } });
  });
  await page.route(`**/api/notion/connections/${workspaceId}/read/scan`, (route) => {
    scanned = true;
    return route.fulfill({ json: readStatus(true) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Notion 连接" }).click();
  await expect(page.getByText("任务：尚未成功同步")).toBeVisible();
  holdSync = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await held;
  await page.getByRole("button", { name: "立即读取 Notion" }).click();
  await expect(page.getByText(/任务：上次成功/)).toBeVisible();
  releaseSync();
  await oldRefresh;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText(/任务：上次成功/)).toBeVisible();
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "保存位置" })).toBeVisible();
});
