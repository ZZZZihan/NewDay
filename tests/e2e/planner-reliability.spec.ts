import { expect, test } from "@playwright/test";

import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("把事情放进时间里")).toBeVisible();
});

test("unfinished tasks can be carried to tomorrow without their time blocks", async ({
  page,
}) => {
  await page.getByTestId("quick-task-input").fill("尚未安排");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByTestId("quick-task-input").fill("已经安排");
  await page.getByRole("button", { name: "添加任务" }).click();

  await page.getByRole("button", { name: "编辑任务：已经安排" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("开始时间（可选）").fill("09:30");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".fc-event", { hasText: "已经安排" })).toBeVisible();

  await page.getByRole("button", { name: "未完成移到明天" }).click();
  await expect(page.getByTestId("unscheduled-list")).not.toContainText("尚未安排");
  await expect(page.locator(".fc-event", { hasText: "已经安排" })).toBeHidden();

  await page.getByRole("button", { name: "后一天" }).click();
  await expect(page.getByTestId("unscheduled-list")).toContainText("尚未安排");
  await expect(page.getByTestId("unscheduled-list")).toContainText("已经安排");
  await expect(page.locator(".fc-event")).toHaveCount(0);
});

test("JSON export and replacement import preserve the backed-up plan", async ({
  page,
}, testInfo) => {
  await page.getByTestId("quick-task-input").fill("备份里的任务");
  await page.getByRole("button", { name: "添加任务" }).click();

  const exportDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出数据" }).click();
  const exportDownload = await exportDownloadPromise;
  const exportedPath = testInfo.outputPath("newday-backup.json");
  await exportDownload.saveAs(exportedPath);

  const archive = JSON.parse(await readFile(exportedPath, "utf8"));
  expect(archive).toEqual(
    expect.objectContaining({
      format: "newday-backup",
      version: 1,
      tasks: [expect.objectContaining({ title: "备份里的任务" })],
      timeBlocks: [],
      preferences: expect.objectContaining({ slotMinutes: 15 }),
    }),
  );

  await page.getByTestId("quick-task-input").fill("导出之后添加");
  await page.getByRole("button", { name: "添加任务" }).click();
  await expect(page.getByTestId("unscheduled-list")).toContainText("导出之后添加");

  page.once("dialog", (dialog) => dialog.accept());
  const safetyDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("import-input").setInputFiles(exportedPath);
  const safetyDownload = await safetyDownloadPromise;
  expect(safetyDownload.suggestedFilename()).toContain("newday-before-import");

  await expect(page.getByTestId("app-notice")).toContainText("导入完成：1 项任务");
  await expect(page.getByTestId("unscheduled-list")).toContainText("备份里的任务");
  await expect(page.getByTestId("unscheduled-list")).not.toContainText(
    "导出之后添加",
  );
});

test.describe("mobile basics", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the plan remains usable without page-level horizontal overflow", async ({
    page,
  }) => {
    await page.getByTestId("quick-task-input").fill("手机上创建任务");
    await page.getByRole("button", { name: "添加任务" }).click();
    await page.getByRole("button", { name: "编辑任务：手机上创建任务" }).click();

    const dialog = page.getByRole("dialog", { name: "编辑任务" });
    await dialog.getByLabel("开始时间（可选）").fill("15:00");
    await dialog.getByLabel("时间块时长").selectOption("60");
    await dialog.getByRole("button", { name: "保存" }).click();

    await expect(page.locator(".fc-event", { hasText: "手机上创建任务" })).toContainText(
      "15:00 – 16:00",
    );

    const viewport = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      document: document.documentElement.scrollWidth,
      width: document.documentElement.clientWidth,
    }));
    expect(viewport.body).toBeLessThanOrEqual(viewport.width);
    expect(viewport.document).toBeLessThanOrEqual(viewport.width);
  });
});
