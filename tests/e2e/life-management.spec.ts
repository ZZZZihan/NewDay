import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures";

async function plannerCommands(request: APIRequestContext, commands: unknown[], client: string) {
  const response = await request.post("/api/planner/commands", {
    headers: { "x-newday-client": client }, data: { commands },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

test("inbox task joins the same task collection as Today", async ({ page, request }) => {
  await page.goto("/");
  const today = await page.getByLabel("选择日期").inputValue();
  await page.getByRole("button", { name: "收集箱", exact: true }).click();
  await page.getByLabel("快速收集").fill("预约体检");
  await page.getByLabel("收集备注").fill("带上证件");
  await page.getByRole("button", { name: "收集", exact: true }).click();
  await expect(page.getByRole("button", { name: "整理为任务或资料" })).toBeVisible();
  await page.getByRole("button", { name: "整理为任务或资料" }).click();
  await expect(page.getByLabel("计划日期")).toHaveValue(today);
  await page.getByRole("button", { name: "确认整理" }).click();
  await expect(page.getByText("收集箱已清空")).toBeVisible();
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.getByRole("button", { name: "完成任务：预约体检" })).toBeVisible();

  await page.getByRole("button", { name: "任务总表", exact: true }).click();
  await page.getByLabel("搜索任务").fill("体检");
  await page.getByRole("button", { name: /预约体检/ }).click();
  await expect(page.getByText("带上证件")).toBeVisible();
  await page.getByRole("button", { name: "标为完成" }).click();
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.getByRole("button", { name: "恢复任务：预约体检" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "恢复任务：预约体检" })).toBeVisible();
  const backup = await request.get("/api/planner/backup");
  expect((await backup.json()).tasks).toEqual([expect.objectContaining({ title: "预约体检", status: "completed" })]);
});

test("two-level library supports resource search, task links and backup", async ({ page, request }) => {
  await page.goto("/");
  await page.getByTestId("quick-task-input").fill("每周运动");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "资料库", exact: true }).click();

  page.once("dialog", (dialog) => dialog.accept("健康"));
  await page.getByRole("button", { name: "新建一级文件夹" }).click();
  page.once("dialog", (dialog) => dialog.accept("运动"));
  await page.getByRole("button", { name: "新建健康的子文件夹" }).click();
  await page.getByRole("button", { name: "新建资料", exact: true }).click();
  const editor = page.getByRole("region", { name: "新建资料" });
  await editor.getByLabel("资料标题").fill("训练计划");
  await editor.getByLabel("资料内容").fill("周三跑步五公里");
  await editor.getByLabel("资料来源").fill("个人笔记");
  await editor.getByLabel("文件夹").selectOption({ label: "健康 / 运动" });
  await editor.getByRole("button", { name: "创建资料" }).click();
  await expect(page.getByRole("region", { name: "编辑资料：训练计划" })).toBeVisible();
  await page.getByLabel("选择关联任务").selectOption({ label: "每周运动" });
  await page.getByRole("button", { name: "关联", exact: true }).click();
  await page.getByRole("button", { name: "关闭" }).click();

  await page.getByLabel("搜索资料").fill("周三跑步");
  await expect(page.getByRole("button", { name: /训练计划/ })).toBeVisible();
  await page.getByLabel("资料排序").selectOption("title");
  const archive = (await (await request.get("/api/planner/backup")).json()) as {
    version: number; folders: Array<{ name: string }>; resources: Array<{ title: string }>; resourceTaskLinks: unknown[];
  };
  expect(archive.version).toBe(6);
  expect(archive.folders.map((folder) => folder.name).sort()).toEqual(["健康", "运动"]);
  expect(archive.resources[0]?.title).toBe("训练计划");
  expect(archive.resourceTaskLinks).toHaveLength(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "资料库", exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});

test("a resource can seed an inbox task and keeps the task association", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  await page.getByRole("button", { name: "新建资料", exact: true }).click();
  const editor = page.getByRole("region", { name: "新建资料" });
  await editor.getByLabel("资料标题").fill("体检指南");
  await editor.getByLabel("资料内容").fill("先预约医院");
  await editor.getByRole("button", { name: "创建资料" }).click();
  await page.getByRole("button", { name: "从这份资料创建任务 → 收集箱" }).click();
  await expect(page.getByRole("heading", { name: "收集箱" })).toBeVisible();
  await page.getByRole("button", { name: "整理为任务或资料" }).click();
  await page.getByRole("button", { name: "确认整理" }).click();
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  await expect(page.getByRole("region", { name: "编辑资料：体检指南" })
    .getByRole("button", { name: "体检指南", exact: true })).toBeVisible();
  const workspace = (await (await request.get("/api/life/workspace")).json()) as { resourceTaskLinks: unknown[] };
  expect(workspace.resourceTaskLinks).toHaveLength(1);
});

test("restoring a backup refreshes the active library view", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  await expect(page.getByText("这里还没有资料")).toBeVisible();
  const emptyBackup = await (await request.get("/api/planner/backup")).json();

  await page.getByRole("button", { name: "新建资料", exact: true }).click();
  const editor = page.getByRole("region", { name: "新建资料" });
  await editor.getByLabel("资料标题").fill("恢复前资料");
  await editor.getByRole("button", { name: "创建资料" }).click();
  await expect(page.getByRole("button", { name: /恢复前资料/ })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("import-input").setInputFiles({
    name: "empty-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(emptyBackup)),
  });
  await expect(page.getByText("导入完成：0 项任务、0 份资料")).toBeVisible();
  expect((await (await request.get("/api/life/workspace")).json()).resources).toHaveLength(0);
  await expect(page.getByText("这里还没有资料")).toBeVisible();
});

test("undo refreshes the active task table", async ({ page, request }) => {
  await page.goto("/");
  await page.getByTestId("quick-task-input").fill("核对撤销状态");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "任务总表", exact: true }).click();
  await page.getByRole("button", { name: /核对撤销状态/ }).click();
  await page.getByRole("button", { name: "标为完成" }).click();
  await expect(page.getByRole("button", { name: "恢复任务", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByText("已撤销")).toBeVisible();
  expect((await (await request.get("/api/life/workspace")).json()).tasks[0].status).toBe("open");
  await expect(page.getByRole("button", { name: "标为完成" })).toBeVisible();
});

test("the open task table reflects backend changes on its bounded background poll", async ({ page, request }) => {
  await page.clock.install();
  await page.goto("/");
  const today = await page.getByLabel("选择日期").inputValue();
  const now = new Date().toISOString();
  await plannerCommands(request, [{ type: "createTask", input: { id: "background-poll-task",
    title: "后台轮询前任务", startDate: today, endDate: today, now } }], "life-poll-seed");
  await page.getByRole("button", { name: "任务总表", exact: true }).click();
  await expect(page.getByRole("button", { name: /后台轮询前任务/ })).toBeVisible();

  await plannerCommands(request, [
    { type: "updateTaskDetails", input: { taskId: "background-poll-task", title: "后台轮询后任务", now } },
    { type: "rescheduleTask", input: { taskId: "background-poll-task", startDate: today, endDate: today, now } },
    { type: "completeTask", input: { taskId: "background-poll-task", completedOn: today, now } },
  ], "life-poll-update");
  await page.clock.runFor(30_000);
  const updated = page.getByRole("button", { name: /后台轮询后任务/ });
  await expect(updated).toBeVisible();
  await expect(updated).toContainText("已完成");
  await expect(page.getByRole("button", { name: /后台轮询前任务/ })).toHaveCount(0);
});

test("background refresh preserves task filters and an unsaved editor draft", async ({ page, request }) => {
  await page.clock.install();
  await page.goto("/");
  const today = await page.getByLabel("选择日期").inputValue();
  const now = new Date().toISOString();
  await plannerCommands(request, [{ type: "createTask", input: { id: "background-draft-task",
    title: "后台草稿任务", notes: "原备注", startDate: today, endDate: today, now } }], "life-draft-seed");
  await page.getByRole("button", { name: "任务总表", exact: true }).click();
  await page.getByLabel("搜索任务").fill("后台");
  await page.getByLabel("任务状态").selectOption("open");
  await page.getByRole("button", { name: /后台草稿任务/ }).click();
  await page.getByRole("button", { name: "编辑任务", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("标题").fill("尚未保存的本地草稿");

  await plannerCommands(request, [{ type: "updateTaskDetails", input: { taskId: "background-draft-task",
    title: "后台服务端新标题", notes: "服务端新备注", now } }], "life-draft-update");
  await page.clock.runFor(30_000);
  await expect(page.getByLabel("搜索任务")).toHaveValue("后台");
  await expect(page.getByLabel("任务状态")).toHaveValue("open");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("标题")).toHaveValue("尚未保存的本地草稿");
});

test("an older workspace read cannot hide a newly saved resource", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  await expect(page.getByText("这里还没有资料")).toBeVisible();
  await page.getByRole("button", { name: "今天", exact: true }).click();

  let releaseOldRead!: () => void;
  const oldReadReleased = new Promise<void>((resolve) => { releaseOldRead = resolve; });
  let markOldReadCaptured!: () => void;
  const oldReadCaptured = new Promise<void>((resolve) => { markOldReadCaptured = resolve; });
  let markOldReadSettled!: () => void;
  const oldReadSettled = new Promise<void>((resolve) => { markOldReadSettled = resolve; });
  let holdNextRead = true;
  await page.route("**/api/life/workspace", async (route) => {
    if (!holdNextRead) return route.continue();
    holdNextRead = false;
    const oldWorkspace = await request.get("/api/life/workspace");
    expect(oldWorkspace.ok()).toBe(true);
    const oldBody = await oldWorkspace.text();
    markOldReadCaptured();
    await oldReadReleased;
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body: oldBody });
    } catch {
      // A newer refresh normally aborts this request before the captured body
      // can arrive. The generation guard also covers transports that ignore it.
    } finally {
      markOldReadSettled();
    }
  });

  await page.getByRole("button", { name: "资料库", exact: true }).click();
  await oldReadCaptured;
  await page.getByRole("button", { name: "新建资料", exact: true }).click();
  const editor = page.getByRole("region", { name: "新建资料" });
  await editor.getByLabel("资料标题").fill("竞态保存资料");
  await editor.getByRole("button", { name: "创建资料" }).click();
  await expect(page.getByRole("button", { name: /竞态保存资料/ })).toBeVisible();

  releaseOldRead();
  await oldReadSettled;
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole("button", { name: /竞态保存资料/ })).toBeVisible();
});

test("replacement import reveals resources when the selected folder no longer exists", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept("旧文件夹"));
  await page.getByRole("button", { name: "新建一级文件夹" }).click();
  const oldFolder = page.getByRole("navigation", { name: "资料文件夹" }).getByRole("button", { name: /^旧文件夹/ });
  await oldFolder.click();
  await expect(oldFolder).toHaveClass(/selected/);

  const backup = await (await request.get("/api/planner/backup")).json();
  const now = new Date().toISOString();
  const replacement = {
    ...backup,
    exportedAt: now,
    folders: [{ id: "replacement-folder", parentId: null, name: "新文件夹", createdAt: now, updatedAt: now }],
    resources: [{ id: "replacement-resource", folderId: "replacement-folder", kind: "note", title: "恢复后的资料", content: "新内容", source: "", createdAt: now, updatedAt: now }],
  };
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("import-input").setInputFiles({
    name: "replacement-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(replacement)),
  });

  await expect(page.getByText("导入完成：0 项任务、1 份资料")).toBeVisible();
  await expect(page.getByRole("button", { name: /恢复后的资料/ })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "资料文件夹" }).getByRole("button", { name: /^全部资料/ })).toHaveClass(/selected/);
  await expect(oldFolder).toHaveCount(0);
});
