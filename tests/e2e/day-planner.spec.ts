import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("把事情放进时间里")).toBeVisible();
});

test("a task can be added quickly and survives a reload", async ({ page }) => {
  const input = page.getByTestId("quick-task-input");
  await input.fill("准备项目周会");
  await page.getByRole("button", { name: "添加任务" }).click();

  await expect(page.getByTestId("unscheduled-list")).toContainText("准备项目周会");
  await expect(page.getByText("1 项任务")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("unscheduled-list")).toContainText("准备项目周会");
});

test("a task can be edited and given an estimate", async ({ page }) => {
  await page.getByTestId("quick-task-input").fill("写提纲");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "编辑任务：写提纲" }).click();

  const dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("标题").fill("写文章提纲");
  await dialog.getByLabel("预计时长").selectOption("60");
  await dialog.getByRole("button", { name: "保存" }).click();

  await expect(page.getByTestId("unscheduled-list")).toContainText("写文章提纲");
  await expect(page.getByTestId("unscheduled-list")).toContainText("预计 1 小时");
});

test("a task can be completed and restored", async ({ page }) => {
  await page.getByTestId("quick-task-input").fill("回复邮件");
  await page.getByRole("button", { name: "添加任务" }).click();

  await page.getByRole("button", { name: "完成任务：回复邮件" }).click();
  await expect(page.getByText("已完成 · 1")).toBeVisible();
  await page.getByText("已完成 · 1").click();
  await expect(page.getByRole("button", { name: "恢复任务：回复邮件" })).toBeVisible();

  await page.getByRole("button", { name: "恢复任务：回复邮件" }).click();
  await expect(page.getByTestId("unscheduled-list")).toContainText("回复邮件");
});

test("clearing the native date input keeps the current day selected", async ({
  page,
}) => {
  const heading = page.locator(".day-heading h1");
  const originalHeading = await heading.textContent();

  await page.getByLabel("选择日期").fill("");

  await expect(heading).toHaveText(originalHeading ?? "");
  await expect(page.getByText("把事情放进时间里")).toBeVisible();
});

test("date navigation keeps each day plan separate", async ({ page }) => {
  await page.getByTestId("quick-task-input").fill("今天的任务");
  await page.getByRole("button", { name: "添加任务" }).click();

  await page.getByRole("button", { name: "后一天" }).click();
  await expect(page.getByTestId("unscheduled-list")).not.toContainText("今天的任务");

  await page.getByTestId("quick-task-input").fill("明天的任务");
  await page.getByRole("button", { name: "添加任务" }).click();
  await expect(page.getByTestId("unscheduled-list")).toContainText("明天的任务");

  await page.getByRole("button", { name: "前一天" }).click();
  await expect(page.getByTestId("unscheduled-list")).toContainText("今天的任务");
  await expect(page.getByTestId("unscheduled-list")).not.toContainText("明天的任务");
});
