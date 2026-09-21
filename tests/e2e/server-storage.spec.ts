import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

async function openPlanner(page: Page) {
  await page.goto("/");
  await expect(page.getByLabel("选择日期")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByTestId("quick-task-input")).toBeEnabled();
}

async function addTask(page: Page, title: string) {
  await page.getByTestId("quick-task-input").fill(title);
  await page.getByRole("button", { name: "添加任务" }).click();
  await expect(page.getByRole("button", { name: `编辑任务：${title}` })).toBeVisible();
}

test("independent browser contexts read and update the same server tasks", async ({
  page, browser, baseURL, request,
}) => {
  await openPlanner(page);
  await addTask(page, "服务端共享任务");

  const secondContext = await browser.newContext({ baseURL });
  try {
    const secondPage = await secondContext.newPage();
    await openPlanner(secondPage);
    await expect(secondPage.getByRole("button", { name: "编辑任务：服务端共享任务" })).toBeVisible();
    await secondPage.getByRole("button", { name: "完成任务：服务端共享任务" }).click();
    await expect(secondPage.getByRole("button", { name: "恢复任务：服务端共享任务" })).toBeVisible();
  } finally {
    await secondContext.close();
  }

  await page.reload();
  await expect(page.getByRole("button", { name: "恢复任务：服务端共享任务" })).toBeVisible();
  const response = await request.get("/api/planner/backup");
  await expect(response).toBeOK();
  expect((await response.json()).tasks).toEqual([
    expect.objectContaining({ title: "服务端共享任务", status: "completed" }),
  ]);
});

test("an unavailable API is visible and reconnect loads the persisted tasks", async ({ page }) => {
  await openPlanner(page);
  await addTask(page, "断线前已保存");

  await page.route("**/api/planner/day?*", (route) => route.abort("failed"));
  await page.reload();
  await expect(page.getByTestId("api-error")).toContainText("无法连接任务服务");
  await expect(page.getByRole("button", { name: "重新连接" })).toBeVisible();

  await page.unroute("**/api/planner/day?*");
  await page.getByRole("button", { name: "重新连接" }).click();
  await expect(page.getByTestId("api-error")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "编辑任务：断线前已保存" })).toBeVisible();
});

test("a rejected write preserves the input and cannot appear as a saved task", async ({ page, request }) => {
  await openPlanner(page);
  await page.route("**/api/planner/commands", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ message: "任务服务暂时不可用，请重试" }),
  }));
  await page.getByTestId("quick-task-input").fill("恢复连接后再保存");
  await page.getByRole("button", { name: "添加任务" }).click();

  await expect(page.getByTestId("app-notice")).toContainText("任务服务暂时不可用");
  await expect(page.getByTestId("quick-task-input")).toHaveValue("恢复连接后再保存");
  await expect(page.getByRole("button", { name: "编辑任务：恢复连接后再保存" })).toHaveCount(0);
  const response = await request.get("/api/planner/backup");
  await expect(response).toBeOK();
  expect((await response.json()).tasks).toEqual([]);

  await page.unroute("**/api/planner/commands");
  await page.getByRole("button", { name: "添加任务" }).click();
  await expect(page.getByRole("button", { name: "编辑任务：恢复连接后再保存" })).toBeVisible();
});

function legacyTask(date: string, title: string, version: 20 | 50) {
  const timestamp = new Date().toISOString();
  return {
    id: `legacy-${randomUUID()}`,
    title,
    notes: "保留原始备注",
    ...(version === 20
      ? { plannedDate: date, estimatedMinutes: 30 }
      : { startDate: date, endDate: date, completedOn: null }),
    status: "open",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

async function seedLegacyDatabase(page: Page, version: 20 | 50, task: ReturnType<typeof legacyTask>) {
  await page.evaluate(({ version, task }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("newday", version);
    request.onupgradeneeded = () => {
      for (const name of ["tasks", "recurrenceSeries", "focusRecords", "timeBlocks", "preferences"]) {
        request.result.createObjectStore(name, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["tasks", "preferences", "timeBlocks"], "readwrite");
      transaction.objectStore("tasks").put(task);
      transaction.objectStore("preferences").put({ id: "legacy-preference", value: "keep-original" });
      transaction.objectStore("timeBlocks").put({ id: "legacy-time-block", taskId: task.id });
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }), { version, task });
}

async function readLegacyDatabase(page: Page) {
  return page.evaluate(() => new Promise<{ version: number; tables: Record<string, unknown[]> }>((resolve, reject) => {
    const request = indexedDB.open("newday");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const version = database.version;
      const transaction = database.transaction(Array.from(database.objectStoreNames), "readonly");
      const tables: Record<string, unknown[]> = {};
      for (const name of Array.from(database.objectStoreNames)) {
        const records = transaction.objectStore(name).getAll();
        records.onsuccess = () => { tables[name] = records.result; };
      }
      transaction.oncomplete = () => { database.close(); resolve({ version, tables }); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }));
}

for (const version of [20, 50] as const) {
  test(`browser database version ${version} migrates once and retains its original schema and records`, async ({ page, request }) => {
    await openPlanner(page);
    const date = await page.getByLabel("选择日期").inputValue();
    const task = legacyTask(date, `旧浏览器任务 ${version}`, version);
    await seedLegacyDatabase(page, version, task);
    const original = await readLegacyDatabase(page);

    await page.reload();
    await expect(page.getByTestId("migration-status")).toContainText("旧浏览器任务已迁移到服务端");
    await expect(page.getByRole("button", { name: `编辑任务：${task.title}` })).toBeVisible();
    expect(await readLegacyDatabase(page)).toEqual(original);

    await page.reload();
    await expect(page.getByRole("button", { name: `编辑任务：${task.title}` })).toBeVisible();
    expect(await readLegacyDatabase(page)).toEqual(original);
    const response = await request.get("/api/planner/backup");
    await expect(response).toBeOK();
    expect((await response.json()).tasks).toEqual([
      expect.objectContaining({ id: task.id, title: task.title, notes: task.notes, startDate: date, endDate: date }),
    ]);
  });
}

test("legacy browser data never overwrites a nonempty server and remains downloadable", async ({ page, request }, testInfo) => {
  await openPlanner(page);
  await addTask(page, "已有服务端任务");
  const date = await page.getByLabel("选择日期").inputValue();
  const task = legacyTask(date, "另一份旧浏览器任务", 50);
  await seedLegacyDatabase(page, 50, task);
  const original = await readLegacyDatabase(page);

  await page.reload();
  await expect(page.getByTestId("migration-status")).toContainText("服务端已有数据");
  await expect(page.getByRole("button", { name: "编辑任务：已有服务端任务" })).toBeVisible();
  await expect(page.getByRole("button", { name: `编辑任务：${task.title}` })).toHaveCount(0);
  expect(await readLegacyDatabase(page)).toEqual(original);
  const response = await request.get("/api/planner/backup");
  await expect(response).toBeOK();
  expect((await response.json()).tasks).toEqual([
    expect.objectContaining({ title: "已有服务端任务" }),
  ]);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载旧浏览器备份" }).click();
  const download = await downloadPromise;
  const path = testInfo.outputPath("old-browser-backup.json");
  await download.saveAs(path);
  const backup = JSON.parse(await readFile(path, "utf8"));
  expect(backup.version).toBe(4);
  expect(backup.tasks).toEqual([task]);
});
