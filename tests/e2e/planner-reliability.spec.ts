import { expect, test } from "./fixtures";

import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("NewDay", { exact: true })).toBeVisible();
});

test("JSON export and replacement import preserve the simplified task data", async ({
  page,
}, testInfo) => {
  await page.getByTestId("quick-task-input").fill("备份里的任务");
  await page.getByRole("button", { name: "添加任务" }).click();

  const exportDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "导出数据" }).click();
  const exportDownload = await exportDownloadPromise;
  const exportedPath = testInfo.outputPath("newday-backup.json");
  await exportDownload.saveAs(exportedPath);

  const archive = JSON.parse(await readFile(exportedPath, "utf8"));
  expect(archive).toEqual({
    format: "newday-backup",
    version: 6,
    exportedAt: expect.any(String),
    tasks: [
      expect.objectContaining({
        title: "备份里的任务",
        startDate: expect.any(String),
        endDate: expect.any(String),
      }),
    ],
    recurrenceSeries: [],
    focusRecords: [],
    inboxItems: [],
    folders: [],
    resources: [],
    resourceTaskLinks: [],
    notionSync: {
      version: 1,
      connections: [], initializationSteps: [], taskMappings: [], outbox: [], conflicts: [], watermarks: [], restoreQuarantine: [],
      readNodes: [], readTaskContexts: [],
    },
  });

  await page.getByTestId("quick-task-input").fill("导出之后添加");
  await page.getByRole("button", { name: "添加任务" }).click();
  await expect(page.getByTestId("daily-task-list")).toContainText("导出之后添加");

  page.once("dialog", (dialog) => dialog.accept());
  const safetyDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("import-input").setInputFiles(exportedPath);
  const safetyDownload = await safetyDownloadPromise;
  expect(safetyDownload.suggestedFilename()).toContain("newday-before-import");

  await expect(page.getByTestId("app-notice")).toContainText("导入完成：1 项任务");
  await expect(page.getByTestId("daily-task-list")).toContainText("备份里的任务");
  await expect(page.getByTestId("daily-task-list")).not.toContainText(
    "导出之后添加",
  );
});

test("version 6 backup includes recurrence and today's focus", async ({
  page,
}, testInfo) => {
  await page.getByTestId("quick-task-input").fill("周期重点任务");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "设为今日重点：周期重点任务" }).click();
  await page.getByRole("button", { name: "编辑任务：周期重点任务" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("重复", { exact: true }).selectOption("daily");
  await dialog.getByRole("button", { name: "保存" }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "导出数据" }).click();
  const download = await downloadPromise;
  const exportedPath = testInfo.outputPath("newday-v6-planning-data.json");
  await download.saveAs(exportedPath);
  const archive = JSON.parse(await readFile(exportedPath, "utf8"));
  const focusedRecord = archive.focusRecords[0];
  const focusedTask = archive.tasks.find(
    (task: { id?: string }) => task.id === focusedRecord.taskId,
  );

  expect(archive.version).toBe(6);
  expect(focusedTask).toEqual(
    expect.objectContaining({
      seriesId: expect.any(String),
      logicalSeriesId: expect.any(String),
      occurrenceDate: expect.any(String),
      occurrenceKey: expect.any(String),
    }),
  );
  expect(archive.recurrenceSeries).toEqual([
    expect.objectContaining({
      title: "周期重点任务",
      logicalSeriesId: expect.any(String),
      effectiveEndDate: null,
      pattern: { kind: "daily" },
    }),
  ]);
  expect(archive.focusRecords).toEqual([
    expect.objectContaining({ taskId: focusedTask.id }),
  ]);
});

test("an imported overdue task is projected into today", async ({ page }) => {
  const today = await page.getByLabel("选择日期").inputValue();
  const yesterdayValue = new Date(`${today}T12:00:00`);
  yesterdayValue.setDate(yesterdayValue.getDate() - 1);
  const yesterday = [
    yesterdayValue.getFullYear(),
    String(yesterdayValue.getMonth() + 1).padStart(2, "0"),
    String(yesterdayValue.getDate()).padStart(2, "0"),
  ].join("-");
  const archive = {
    format: "newday-backup",
    version: 3,
    exportedAt: new Date().toISOString(),
    tasks: [
      {
        id: "overdue-task",
        title: "昨天截止的任务",
        notes: "",
        startDate: yesterday,
        endDate: yesterday,
        status: "open",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        completedOn: null,
      },
    ],
    recurrenceSeries: [],
    focusRecords: [],
  };

  page.once("dialog", (dialog) => dialog.accept());
  const safetyDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("import-input").setInputFiles({
    name: "overdue-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(archive)),
  });
  await safetyDownloadPromise;

  await expect(page.getByRole("heading", { name: "逾期 1" })).toBeVisible();
  await expect(page.getByTestId("daily-task-list")).toContainText(
    `逾期 · 截止 ${Number(yesterday.slice(5, 7))}月${Number(yesterday.slice(8, 10))}日`,
  );
});

test.describe("theme", () => {
  test.use({ colorScheme: "dark" });

  test("follows system changes until a manual choice is stored", async ({ page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.getByRole("button", { name: "切换到深色模式" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.emulateMedia({ colorScheme: "dark" });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("button", { name: "切换到浅色模式" })).toBeVisible();
  });
});

test.describe("light system theme", () => {
  test.use({ colorScheme: "light" });

  test("uses the light theme on a first visit", async ({ page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("button", { name: "切换到深色模式" })).toBeVisible();
  });
});

test.describe("mobile basics", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the daily list remains usable without horizontal overflow", async ({
    page,
  }) => {
    const readViewport = () =>
      page.evaluate(() => ({
        body: document.body.scrollWidth,
        document: document.documentElement.scrollWidth,
        width: document.documentElement.clientWidth,
      }));

    await expect(page.getByLabel("选择日期")).toHaveAttribute("type", "date");
    await expect(page.getByTestId("import-input")).toHaveAttribute("type", "file");

    await page.getByTestId("quick-task-input").fill("手机上创建任务");
    await page.getByRole("button", { name: "添加任务" }).click();
    await page.getByRole("button", { name: "编辑任务：手机上创建任务" }).click();

    const dialog = page.getByRole("dialog", { name: "编辑任务" });
    await expect(dialog.getByLabel("开始日期")).toHaveValue(/\d{4}-\d{2}-\d{2}/);
    await expect(dialog.getByLabel("截止日期")).toHaveValue(/\d{4}-\d{2}-\d{2}/);

    let viewport = await readViewport();
    expect(viewport.body).toBeLessThanOrEqual(viewport.width);
    expect(viewport.document).toBeLessThanOrEqual(viewport.width);

    await dialog.getByRole("button", { name: "保存" }).click();

    viewport = await readViewport();
    expect(viewport.body).toBeLessThanOrEqual(viewport.width);
    expect(viewport.document).toBeLessThanOrEqual(viewport.width);
  });
});
