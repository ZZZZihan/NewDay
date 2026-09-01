import { expect, type Locator, type Page, test } from "@playwright/test";

async function dragToTime(page: Page, source: Locator, time: string) {
  const slot = page.locator(`.fc-timegrid-slot[data-time="${time}:00"]`).first();
  const dayColumn = page.locator(".fc-timegrid-col.fc-day");
  await expect(slot).toBeVisible();

  const sourceBox = await source.boundingBox();
  const slotBox = await slot.boundingBox();
  const dayColumnBox = await dayColumn.boundingBox();

  if (!sourceBox || !slotBox || !dayColumnBox) {
    throw new Error("Could not measure drag source or calendar target");
  }

  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    dayColumnBox.x + dayColumnBox.width / 2,
    slotBox.y + slotBox.height / 2,
    { steps: 16 },
  );
  await page.waitForTimeout(250);
  await page.mouse.up();
}

async function eventStartTime(event: Locator) {
  return event.locator(".event-content__topline").innerText();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/spike");
  await expect(
    page.getByRole("heading", { name: "时间轴交互探针" }),
  ).toBeVisible();
});

test("an external task can be scheduled on the day timeline", async ({ page }) => {
  await expect(page.getByTestId("scheduled-count")).toHaveText("0 / 3");

  const task = page.getByTestId("task-write-report");
  await dragToTime(page, task, "09:00");

  await expect(task).toBeHidden();
  await expect(page.getByTestId("scheduled-count")).toHaveText("1 / 3");
  await expect(page.locator(".fc-event", { hasText: "写周报" })).toBeVisible();
  await expect(page.getByTestId("mutation-status")).toContainText("09:00");
});

test("a scheduled block can move and snap to a 15 minute slot", async ({
  page,
}) => {
  await dragToTime(page, page.getByTestId("task-write-report"), "09:00");

  const event = page.locator(".fc-event", { hasText: "写周报" });
  await expect(event.locator(".fc-event-resizer-end")).toBeVisible();

  const targetSlot = page
    .locator('.fc-timegrid-slot[data-time="10:15:00"]')
    .first();
  const targetColumn = page.locator(".fc-timegrid-col.fc-day");
  const slotBox = await targetSlot.boundingBox();
  const columnBox = await targetColumn.boundingBox();

  if (!slotBox || !columnBox) {
    throw new Error("Could not measure the 10:15 target");
  }

  const eventBox = await event.boundingBox();
  if (!eventBox) {
    throw new Error("Could not measure the scheduled block");
  }

  await page.mouse.move(
    eventBox.x + eventBox.width / 2,
    eventBox.y + Math.min(16, eventBox.height / 2),
  );
  await page.mouse.down();
  await page.mouse.move(
    columnBox.x + columnBox.width / 2,
    slotBox.y + slotBox.height / 2,
    { steps: 16 },
  );
  await page.waitForTimeout(250);
  await page.mouse.up();

  await expect(page.getByTestId("mutation-status")).toContainText("10:15");
  await expect.poll(() => eventStartTime(event)).toContain("10:15");
});

test("overlapping blocks remain allowed and both show warnings", async ({
  page,
}) => {
  await dragToTime(page, page.getByTestId("task-write-report"), "09:00");
  await dragToTime(page, page.getByTestId("task-reply-email"), "09:30");

  const report = page.locator(".fc-event", { hasText: "写周报" });
  const email = page.locator(".fc-event", { hasText: "回复邮件" });

  await expect(report).toHaveClass(/planner-event--conflict/);
  await expect(email).toHaveClass(/planner-event--conflict/);
  await expect(page.getByLabel("时间冲突")).toHaveCount(2);
});

test("a block can be resized in 15 minute increments", async ({ page }) => {
  await dragToTime(page, page.getByTestId("task-write-report"), "09:00");

  const event = page.locator(".fc-event", { hasText: "写周报" });
  const beforeBox = await event.boundingBox();
  await event.hover();
  const resizer = event.locator(".fc-event-resizer-end");
  await expect(resizer).toBeVisible();

  const resizerBox = await resizer.boundingBox();
  const slot = page.locator('.fc-timegrid-slot[data-time="10:15:00"]').first();
  const slotBox = await slot.boundingBox();

  if (!resizerBox || !slotBox) {
    throw new Error("Could not measure resize handle or target slot");
  }

  await page.mouse.move(
    resizerBox.x + resizerBox.width / 2,
    resizerBox.y + resizerBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, slotBox.y, {
    steps: 12,
  });
  await page.waitForTimeout(250);
  await page.mouse.up();

  await expect(page.getByTestId("mutation-status")).toContainText("已调整");
  const afterBox = await event.boundingBox();
  expect(beforeBox).not.toBeNull();
  expect(afterBox).not.toBeNull();
  expect(afterBox!.height).toBeGreaterThan(beforeBox!.height);
});
