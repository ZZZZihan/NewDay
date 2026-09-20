import { expect, test } from "./fixtures";

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
  expect(archive.version).toBe(5);
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
