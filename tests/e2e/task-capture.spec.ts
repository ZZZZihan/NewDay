import type { APIRequestContext, Page } from "@playwright/test";
import { agentPreferencesSchema } from "@newday/core/contracts/agent-planning";
import { expect, test } from "./fixtures";

type SavedTask = {
  id: string;
  title: string;
  notes: string;
  startDate: string;
  endDate: string;
};

async function savedTasks(request: APIRequestContext): Promise<SavedTask[]> {
  const response = await request.get("/api/planner/backup");
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json() as { tasks: SavedTask[] }).tasks;
}

async function submitCapture(page: Page, text: string, mode: "direct" | "transcript" = "direct") {
  const panel = page.getByTestId("task-capture");
  await panel.getByRole("button", { name: mode === "direct" ? "直接告诉我" : "粘贴已有对话", exact: true }).click();
  await panel.getByTestId("capture-input").fill(text);
  await panel.getByRole("button", { name: mode === "direct" ? "发送并加入待办" : "提取待办", exact: true }).click();
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    panel: document.querySelector('[data-testid="task-capture"]')!.getBoundingClientRect().toJSON() as { left: number; right: number },
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.panel.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.panel.right).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test.beforeEach(async ({ page, request }) => {
  const timeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const response = await request.get("/api/agent/preferences");
  expect(response.ok()).toBe(true);
  const preferences = agentPreferencesSchema.parse(await response.json());
  const saved = await request.put("/api/agent/preferences", {
    data: { expectedRevision: preferences.revision, timeZone, learningEnabled: false, explicitPreferences: [] },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const provider = await request.get("/api/agent/captures/status");
  expect(provider.ok()).toBe(true);
  expect(await provider.json()).toMatchObject({ configured: true, modelId: "scripted-e2e-capture-v1" });
  await page.goto("/");
  await expect(page.getByTestId("task-capture")).toBeVisible();
});

test("a direct message creates multiple tasks, persists after refresh, and works at 390px", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const today = await page.getByLabel("选择日期").inputValue();
  await expectNoHorizontalOverflow(page);
  await submitCapture(page, "今天整理汇报；今天核对数据");
  await expect(page.getByTestId("capture-receipt")).toContainText("已加入 2 条待办");
  const tasks = await savedTasks(request);
  expect(tasks).toHaveLength(2);
  expect(tasks).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: "整理汇报", startDate: today, endDate: today }),
    expect.objectContaining({ title: "核对数据", startDate: today, endDate: today }),
  ]));
  expect(new Set(tasks.map((task) => task.id)).size).toBe(2);
  await expect(page.getByTestId("daily-task-list")).toContainText("整理汇报");
  await expect(page.getByTestId("daily-task-list")).toContainText("核对数据");
  await expectNoHorizontalOverflow(page);

  await page.reload();
  await expect(page.getByTestId("daily-task-list")).toContainText("整理汇报");
  await expect(page.getByTestId("daily-task-list")).toContainText("核对数据");
  expect(await savedTasks(request)).toEqual(tasks);
});

test("pasted conversation stays a preview until an edited subset is confirmed", async ({ page, request }) => {
  const today = await page.getByLabel("选择日期").inputValue();
  await page.getByTestId("quick-task-input").fill("已有待办保持原样");
  await page.getByRole("button", { name: "添加任务", exact: true }).click();
  await expect(page.getByTestId("daily-task-list")).toContainText("已有待办保持原样");
  const before = await savedTasks(request);

  await submitCapture(page, "朋友：明天去跑步\n我：今天提交报告；今天给花浇水", "transcript");
  const drafts = page.getByTestId("capture-draft");
  await expect(drafts).toHaveCount(2);
  await expect(page.getByLabel("标题 1", { exact: true })).toHaveValue("提交报告");
  await expect(page.getByLabel("标题 2", { exact: true })).toHaveValue("给花浇水");
  expect(await savedTasks(request)).toEqual(before);

  await page.getByLabel("标题 1", { exact: true }).fill("提交最终报告");
  await page.getByRole("textbox", { name: "备注 1", exact: true }).fill("附上已核对的数据");
  await page.getByLabel("选择待办 2", { exact: true }).uncheck();
  expect(await savedTasks(request)).toEqual(before);
  await page.getByRole("button", { name: "加入 1 条待办", exact: true }).click();
  await expect(page.getByTestId("capture-receipt")).toContainText("已加入 1 条待办");
  const tasks = await savedTasks(request);
  expect(tasks).toHaveLength(2);
  expect(tasks.find((task) => task.id === before[0].id)).toEqual(before[0]);
  expect(tasks.find((task) => task.title === "提交最终报告")).toMatchObject({ notes: "附上已核对的数据", startDate: today, endDate: today });
  expect(tasks.some((task) => task.title === "给花浇水" || task.title === "去跑步")).toBe(false);
  await expect(page.getByTestId("daily-task-list")).toContainText("提交最终报告");
  await page.reload();
  await expect(page.getByTestId("daily-task-list")).toContainText("提交最终报告");
  expect(await savedTasks(request)).toEqual(tasks);
});

test("refresh recovers an accepted direct message whose response was lost without creating duplicates", async ({ page, request }) => {
  let createRequests = 0;
  await page.route("**/api/agent/captures", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    createRequests += 1;
    // The real API accepts the request; only the response back to this tab is lost.
    const accepted = await route.fetch();
    expect(accepted.status()).toBe(202);
    await route.abort("failed");
  });
  await submitCapture(page, "今天准备会议；今天整理附件");
  await expect(page.getByRole("button", { name: "确认提交结果", exact: true })).toBeVisible();
  await expect.poll(async () => (await savedTasks(request)).length).toBe(2);
  const committed = await savedTasks(request);

  await page.reload();
  await expect(page.getByTestId("capture-receipt")).toContainText("已加入 2 条待办");
  await expect(page.getByTestId("daily-task-list")).toContainText("准备会议");
  await expect(page.getByTestId("daily-task-list")).toContainText("整理附件");
  expect(await savedTasks(request)).toEqual(committed);
  expect(createRequests).toBe(1);
  await expect(page.getByRole("button", { name: "确认提交结果", exact: true })).toHaveCount(0);
});

test("refresh recovers a committed transcript selection after the apply response is lost", async ({ page, request }) => {
  await submitCapture(page, "我：今天整理书架；今天归还图书", "transcript");
  await expect(page.getByTestId("capture-draft")).toHaveCount(2);
  await page.getByLabel("选择待办 2", { exact: true }).uncheck();
  await page.getByLabel("标题 1", { exact: true }).fill("整理客厅书架");
  let applyRequests = 0;
  await page.route("**/api/agent/captures/*/apply", async (route) => {
    applyRequests += 1;
    // Commit against the isolated SQLite database, then simulate transport loss.
    const applied = await route.fetch();
    expect(applied.ok(), await applied.text()).toBe(true);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "加入 1 条待办", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认提交结果", exact: true })).toBeVisible();
  const committed = await savedTasks(request);
  expect(committed).toEqual([expect.objectContaining({ title: "整理客厅书架" })]);

  await page.reload();
  await expect(page.getByTestId("capture-receipt")).toContainText("已加入 1 条待办");
  await expect(page.getByTestId("daily-task-list")).toContainText("整理客厅书架");
  expect(await savedTasks(request)).toEqual(committed);
  expect(applyRequests).toBe(1);
  await expect(page.getByRole("button", { name: "确认提交结果", exact: true })).toHaveCount(0);
});

test("a direct request with an unknown date remains a draft until dates are filled", async ({ page, request }) => {
  const today = await page.getByLabel("选择日期").inputValue();
  await submitCapture(page, "整理书桌");
  await expect(page.getByTestId("capture-draft")).toHaveCount(1);
  await expect(page.getByLabel("开始日期 1", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("结束日期 1", { exact: true })).toHaveValue("");
  const confirm = page.getByRole("button", { name: "加入 1 条待办", exact: true });
  await expect(confirm).toBeDisabled();
  expect(await savedTasks(request)).toEqual([]);
  await page.getByLabel("开始日期 1", { exact: true }).fill(today);
  await expect(confirm).toBeDisabled();
  await page.getByLabel("结束日期 1", { exact: true }).fill(today);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId("capture-receipt")).toContainText("已加入 1 条待办");
  expect(await savedTasks(request)).toEqual([expect.objectContaining({ title: "整理书桌", startDate: today, endDate: today })]);
});

test("an explicit no-action message produces no drafts and leaves existing tasks intact", async ({ page, request }) => {
  await page.getByTestId("quick-task-input").fill("保留原来的待办");
  await page.getByRole("button", { name: "添加任务", exact: true }).click();
  await expect(page.getByTestId("daily-task-list")).toContainText("保留原来的待办");
  const before = await savedTasks(request);
  await submitCapture(page, "今天不需要安排任何任务");
  await expect(page.getByTestId("capture-empty")).toContainText("没有提取到可加入的待办");
  await expect(page.getByTestId("capture-draft")).toHaveCount(0);
  await expect(page.getByTestId("capture-receipt")).toHaveCount(0);
  expect(await savedTasks(request)).toEqual(before);
});
