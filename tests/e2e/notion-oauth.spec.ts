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
  await expect(page.getByText("已授权；任务同步尚未启用")).toBeVisible();
  expect(page.url()).not.toContain(ticket);
  expect(await page.locator("body").innerText()).not.toContain(ticket);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
