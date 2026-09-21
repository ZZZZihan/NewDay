import type { APIRequestContext, Page } from "@playwright/test";
import { agentPreferencesSchema } from "@newday/core/contracts/agent-planning";
import { expect, test } from "./fixtures";

async function backup(request: APIRequestContext) {
  const response = await request.get("/api/planner/backup");
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ tasks: unknown[]; focusRecords: { taskId: string; date: string }[] }>;
}
async function seed(page: Page, request: APIRequestContext) {
  await page.goto("/");
  await expect(page.getByLabel("选择日期")).toBeVisible();
  const date = await page.getByLabel("选择日期").inputValue();
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const preferenceResponse = await request.get("/api/agent/preferences");
  expect(preferenceResponse.ok()).toBe(true);
  const preferences = agentPreferencesSchema.parse(await preferenceResponse.json());
  const saved = await request.put("/api/agent/preferences", { data: { expectedRevision: preferences.revision, timeZone: zone, learningEnabled: true, explicitPreferences: [] } });
  expect(saved.ok()).toBe(true);
  const now = new Date().toISOString();
  const tasks = [
    { id: "e2e-a", title: "A 整理汇报" },
    { id: "e2e-b", title: "B 核对数据" },
    { id: "e2e-c", title: "C 整理桌面" },
  ];
  const response = await request.post("/api/planner/commands", {
    headers: { "x-newday-client": "agent-e2e-seed" },
    data: { commands: [
      ...tasks.map((task) => ({ type: "createTask", input: { ...task, startDate: date, endDate: date, now } })),
      ...["e2e-b", "e2e-c"].map((taskId) => ({ type: "setTodayFocus", input: { taskId, date, now } })),
    ] },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("agent-planner")).toBeVisible();
  return { date, tasks };
}
async function generate(page: Page, goal = "今天推进汇报") {
  await page.getByRole("button", { name: "帮我定今日重点", exact: true }).click();
  await page.getByLabel("当天目标", { exact: false }).fill(goal);
  await page.getByLabel("今天最多承担几项").selectOption("2");
  await page.getByRole("button", { name: "帮我定今日重点", exact: true }).click();
}

test("real scripted planning previews the complete focus replacement and persists only after apply", async ({ page, request }) => {
  await seed(page, request);
  const before = await backup(request);
  await generate(page);
  const proposal = page.getByTestId("agent-proposal");
  await expect(proposal.getByRole("heading", { name: "建议的今日重点" })).toBeVisible();
  const preview = page.getByTestId("agent-focus-preview");
  await expect(preview.locator("dl > div").filter({ hasText: "新增" })).toContainText("A 整理汇报");
  await expect(preview.locator("dl > div").filter({ hasText: "保留" })).toContainText("B 核对数据");
  await expect(preview.locator("dl > div").filter({ hasText: "移除" })).toContainText("C 整理桌面");
  expect((await backup(request)).focusRecords).toEqual(before.focusRecords);
  await page.getByRole("button", { name: "采纳今日重点", exact: true }).click();
  await expect.poll(async () => (await backup(request)).focusRecords.map((record) => record.taskId).sort()).toEqual(["e2e-a", "e2e-b"]);
  expect((await backup(request)).tasks).toEqual(before.tasks);
  await page.reload();
  await expect(page.getByTestId("agent-planner")).toBeVisible();
  expect((await backup(request)).focusRecords.map((record) => record.taskId).sort()).toEqual(["e2e-a", "e2e-b"]);
  await page.getByTestId("agent-history").locator("summary").click();
  await expect(page.getByTestId("agent-history")).toContainText("已采纳");
  await expect(page.getByTestId("agent-history")).toContainText("最终重点：A 整理汇报、B 核对数据");
});

test("rejecting a proposal and choosing a rest day both leave the existing focus set intact", async ({ page, request }) => {
  await seed(page, request);
  const before = await backup(request);
  await generate(page);
  await expect(page.getByRole("button", { name: "拒绝建议", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "拒绝建议", exact: true }).click();
  await expect(page.getByTestId("agent-proposal")).toContainText("你已拒绝这份建议");
  expect((await backup(request)).focusRecords).toEqual(before.focusRecords);
  await page.getByLabel("今天休息，不安排新重点").check();
  await page.getByRole("button", { name: "帮我定今日重点", exact: true }).click();
  await expect(page.getByTestId("agent-proposal")).toContainText("未更改已有今日重点");
  await expect(page.getByRole("button", { name: "采纳今日重点", exact: true })).toHaveCount(0);
  expect((await backup(request)).focusRecords).toEqual(before.focusRecords);
});

test("one clarification round completes and a later manual edit in another tab produces a conflict", async ({ page, context, request }) => {
  await seed(page, request);
  await generate(page, "[e2e:clarify]\n今天推进汇报");
  await expect(page.getByLabel("今天更希望先推进哪一项")).toBeVisible();
  await page.getByLabel("今天更希望先推进哪一项").fill("先整理汇报");
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect(page.getByRole("button", { name: "采纳今日重点", exact: true })).toBeVisible();
  const otherTab = await context.newPage();
  await otherTab.goto("/");
  await otherTab.getByTestId("quick-task-input").fill("另一标签页人工新增");
  await otherTab.getByRole("button", { name: "添加任务", exact: true }).click();
  await expect(otherTab.getByTestId("daily-task-list")).toContainText("另一标签页人工新增");
  const beforeApply = await backup(request);
  await page.getByRole("button", { name: "采纳今日重点", exact: true }).click();
  await expect(page.getByTestId("agent-planner").getByRole("alert")).toContainText("重新生成");
  expect((await backup(request)).focusRecords).toEqual(beforeApply.focusRecords);
  expect((await backup(request)).tasks).toEqual(beforeApply.tasks);
});
