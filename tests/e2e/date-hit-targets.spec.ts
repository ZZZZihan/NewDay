import { writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./fixtures";

const monday = "2026-09-21";
const weekDates = Array.from({ length: 7 }, (_, index) => `2026-09-${21 + index}`);

async function openWeek(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天的任务" })).toBeVisible();
  const today = await page.getByLabel("选择日期").inputValue();
  await page.getByLabel("选择日期").fill(monday);
  await expect(page.getByLabel("本周日期").getByRole("button")).toHaveCount(7);
  return today;
}

async function checkDateTargets(page: Page, testInfo: TestInfo, label: string) {
  const strip = page.getByLabel("本周日期");
  await strip.scrollIntoViewIfNeeded();
  const measurements = await strip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      strip: { left: bounds.left, right: bounds.right },
      buttons: [...element.querySelectorAll("button")].map((button) => {
        const { x, y, right, width, height } = button.getBoundingClientRect();
        const centerX = x + width / 2;
        const centerY = y + height / 2;
        const hit = document.elementFromPoint(centerX, centerY)?.closest("button");
        return {
          name: button.getAttribute("aria-label"),
          x, y, right, width, height, centerX, centerY,
          centerHit: hit === button,
          hitName: hit?.getAttribute("aria-label") ?? null,
        };
      }),
    };
  });
  const geometryPath = testInfo.outputPath(`${label}-geometry.json`);
  const screenshotPath = testInfo.outputPath(`${label}-screenshot.png`);
  await writeFile(geometryPath, JSON.stringify(measurements, null, 2));
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach(`${label}-geometry`, {
    path: geometryPath,
    contentType: "application/json",
  });
  await testInfo.attach(`${label}-screenshot`, {
    path: screenshotPath,
    contentType: "image/png",
  });
  const { buttons } = measurements;
  expect(buttons).toHaveLength(7);
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons[index];
    expect(button.width, `${button.name} must have a visible hit target`).toBeGreaterThan(0);
    expect(button.x, `${button.name} must remain inside the week strip`)
      .toBeGreaterThanOrEqual(measurements.strip.left);
    expect(button.right, `${button.name} must remain inside the week strip`)
      .toBeLessThanOrEqual(measurements.strip.right + 0.1);
    if (index > 0) {
      expect(buttons[index - 1].right, `${buttons[index - 1].name} overlaps ${button.name}`)
        .toBeLessThanOrEqual(button.x);
    }
    expect(button.centerHit, `${button.name} center hits ${button.hitName}`).toBe(true);
  }

  for (const [index, date] of weekDates.entries()) {
    // A coordinate click cannot bypass an overlapping neighbour, unlike a
    // forced locator click or a synthetic dispatchEvent.
    const button = buttons[index];
    await page.mouse.click(button.centerX, button.centerY);
    await expect(page.getByLabel("选择日期")).toHaveValue(date);
    await expect(strip.getByRole("button").nth(index)).toHaveAttribute("aria-pressed", "true");
    await expect(strip.getByRole("button", { pressed: true })).toHaveCount(1);
  }
}

for (const viewport of [
  { width: 320, height: 800 },
  { width: 820, height: 1000 },
  { width: 1440, height: 1000 },
]) {
  test(`${viewport.width}px date hit targets do not overlap and select each day`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openWeek(page);
    await checkDateTargets(page, testInfo, `${viewport.width}px-light`);
    await page.getByRole("button", { name: "切换到深色模式" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await checkDateTargets(page, testInfo, `${viewport.width}px-dark`);
  });

  test(`${viewport.width}px date navigation supports Tab, Enter, and Space`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const today = await openWeek(page);
    const picker = page.getByLabel("选择日期");
    const previous = page.getByRole("button", { name: "前一天" });
    const next = page.getByRole("button", { name: "后一天" });
    await previous.focus();
    await page.keyboard.press("Enter");
    await expect(picker).toHaveValue("2026-09-20");
    await page.keyboard.press("Tab");
    await expect(picker).toBeFocused();
    // Native date inputs may have several keyboard-editable segments. Tab
    // through them without assuming Chromium and WebKit share their layout.
    for (let index = 0; index < 5 && !(await next.evaluate((element) => element === document.activeElement)); index += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(next).toBeFocused();
    await page.keyboard.press("Space");
    await expect(picker).toHaveValue(monday);

    const buttons = page.getByLabel("本周日期").getByRole("button");
    for (const [index, date] of weekDates.entries()) {
      await page.keyboard.press("Tab");
      await expect(buttons.nth(index)).toBeFocused();
      await page.keyboard.press(index % 2 === 0 ? "Enter" : "Space");
      await expect(picker).toHaveValue(date);
      await expect(buttons.nth(index)).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByLabel("本周日期").getByRole("button", { pressed: true })).toHaveCount(1);
    }
    if (today === weekDates[6]) await previous.click();
    await page.getByRole("button", { name: "回到今天" }).click();
    await expect(picker).toHaveValue(today);
  });
}

test("fullscreen preserves date hit targets and exits with the selected date", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openWeek(page);
  await page.getByRole("button", { name: "进入全屏" }).click();
  await expect(page.getByRole("button", { name: "退出全屏" })).toHaveAttribute("aria-pressed", "true");
  await checkDateTargets(page, testInfo, "1920px-fullscreen");
  await page.getByRole("button", { name: "退出全屏" }).click();
  await expect(page.getByRole("button", { name: "进入全屏" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByLabel("选择日期")).toHaveValue(weekDates[6]);
});
