import { expect, type Locator, type Page, test } from "@playwright/test";

async function dragTaskToTime(page: Page, task: Locator, time: string) {
  const slot = page.locator(`.fc-timegrid-slot[data-time="${time}:00"]`).first();
  const dayColumn = page.locator(".fc-timegrid-col.fc-day");
  const sourceBox = await task.boundingBox();
  const slotBox = await slot.boundingBox();
  const columnBox = await dayColumn.boundingBox();

  if (!sourceBox || !slotBox || !columnBox) {
    throw new Error("Could not measure task or timeline target");
  }

  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    columnBox.x + columnBox.width / 2,
    slotBox.y + slotBox.height / 2,
    { steps: 16 },
  );
  await page.waitForTimeout(250);
  await page.mouse.up();
  await expect(task).toBeHidden();
  await expect(page.locator(".fc-event-mirror")).toHaveCount(0);
}

async function moveEventToTime(page: Page, event: Locator, time: string) {
  const slot = page.locator(`.fc-timegrid-slot[data-time="${time}:00"]`).first();
  const dayColumn = page.locator(".fc-timegrid-col.fc-day");
  const eventBox = await event.boundingBox();
  const slotBox = await slot.boundingBox();
  const columnBox = await dayColumn.boundingBox();

  if (!eventBox || !slotBox || !columnBox) {
    throw new Error("Could not measure event or move target");
  }

  await page.mouse.move(
    eventBox.x + eventBox.width / 2,
    eventBox.y + Math.min(14, eventBox.height / 2),
  );
  await page.mouse.down();
  await page.mouse.move(
    columnBox.x + columnBox.width / 2,
    slotBox.y + slotBox.height / 2,
    { steps: 16 },
  );
  await page.waitForTimeout(250);
  await page.mouse.up();
  await expect(page.locator(".fc-event-dragging")).toHaveCount(0);
}

async function resizeEventToTime(page: Page, event: Locator, time: string) {
  const slot = page.locator(`.fc-timegrid-slot[data-time="${time}:00"]`).first();
  await slot.scrollIntoViewIfNeeded();
  await event.hover();
  const resizer = event.locator(".fc-event-resizer-end");
  const resizerBox = await resizer.boundingBox();
  const slotBox = await slot.boundingBox();

  if (!resizerBox || !slotBox) {
    throw new Error("Could not measure resize handle or target");
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
  await expect(page.locator(".fc-event-resizing")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("把事情放进时间里")).toBeVisible();
});

test("an unscheduled task can be dragged onto the real timeline", async ({
  page,
}) => {
  await page.getByTestId("quick-task-input").fill("深度工作");
  await page.getByRole("button", { name: "添加任务" }).click();

  const task = page.getByTestId("unscheduled-list").getByText("深度工作");
  await dragTaskToTime(page, task, "09:00");

  await expect(page.getByTestId("unscheduled-list")).not.toContainText("深度工作");
  const event = page.locator(".fc-event", { hasText: "深度工作" });
  await expect(event).toBeVisible();
  await expect(event).toContainText("09:00 – 09:30");

  await page.reload();
  await expect(page.locator(".fc-event", { hasText: "深度工作" })).toBeVisible();
});

test("overlapping real time blocks remain allowed and show warnings", async ({
  page,
}) => {
  await page.getByTestId("quick-task-input").fill("任务 A");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByTestId("quick-task-input").fill("任务 B");
  await page.getByRole("button", { name: "添加任务" }).click();
  await expect(page.getByTestId("unscheduled-list")).toContainText("任务 A");
  await expect(page.getByTestId("unscheduled-list")).toContainText("任务 B");

  await dragTaskToTime(
    page,
    page.getByTestId("unscheduled-list").getByText("任务 A"),
    "09:00",
  );
  await dragTaskToTime(
    page,
    page.getByTestId("unscheduled-list").getByText("任务 B"),
    "09:15",
  );

  await expect(page.locator(".day-event--conflict")).toHaveCount(2);
  await expect(page.getByText("冲突")).toHaveCount(2);
});

test("a real time block can be moved, resized, and persisted", async ({ page }) => {
  await page.getByTestId("quick-task-input").fill("可调整任务");
  await page.getByRole("button", { name: "添加任务" }).click();
  await dragTaskToTime(
    page,
    page.getByTestId("unscheduled-list").getByText("可调整任务"),
    "09:00",
  );

  const event = page.locator(".fc-event:not(.fc-event-mirror)", {
    hasText: "可调整任务",
  });
  await moveEventToTime(page, event, "10:15");
  await expect(event).toContainText("10:15 – 10:45");

  await resizeEventToTime(page, event, "11:15");
  await expect(event).toContainText("10:15 – 11:15");

  await page.reload();
  await expect(page.locator(".fc-event", { hasText: "可调整任务" })).toContainText(
    "10:15 – 11:15",
  );
});

test("the latest scheduling action can be undone", async ({ page }) => {
  await page.getByTestId("quick-task-input").fill("可撤销任务");
  await page.getByRole("button", { name: "添加任务" }).click();
  await dragTaskToTime(
    page,
    page.getByTestId("unscheduled-list").getByText("可撤销任务"),
    "09:00",
  );

  await expect(page.locator(".fc-event", { hasText: "可撤销任务" })).toBeVisible();
  await page
    .getByTestId("app-notice")
    .getByRole("button", { name: "撤销", exact: true })
    .click();

  await expect(page.locator(".fc-event", { hasText: "可撤销任务" })).toBeHidden();
  await expect(page.getByTestId("unscheduled-list")).toContainText("可撤销任务");
});

test("a task can be scheduled without drag and drop", async ({ page }) => {
  await page.getByTestId("quick-task-input").fill("手动安排");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "编辑任务：手动安排" }).click();

  const dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("开始时间（可选）").fill("14:15");
  await dialog.getByLabel("时间块时长").selectOption("45");
  await dialog.getByRole("button", { name: "保存" }).click();

  const event = page.locator(".fc-event", { hasText: "手动安排" });
  await expect(event).toContainText("14:15 – 15:00");
  await expect(page.getByTestId("unscheduled-list")).not.toContainText("手动安排");
});

test("manual scheduling stays inside the visible day window", async ({ page }) => {
  await page.getByTestId("quick-task-input").fill("太早的任务");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "编辑任务：太早的任务" }).click();

  const dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("开始时间（可选）").fill("06:45");
  await dialog.getByRole("button", { name: "保存" }).click();

  await expect(dialog.getByRole("alert")).toContainText("07:00–23:00");
  await expect(page.locator(".fc-event", { hasText: "太早的任务" })).toHaveCount(0);
  await expect(page.getByTestId("unscheduled-list")).toContainText("太早的任务");
});

test("a scheduled task can be completed and its details can still be edited", async ({
  page,
}) => {
  await page.getByTestId("quick-task-input").fill("发布版本");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "编辑任务：发布版本" }).click();

  let dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("开始时间（可选）").fill("10:00");
  await dialog.getByRole("button", { name: "保存" }).click();

  const event = page.locator(".fc-event", { hasText: "发布版本" });
  await event.click();
  dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByRole("button", { name: "标记完成" }).click();
  await expect(event).toHaveClass(/day-event--completed/);

  await event.click();
  dialog = page.getByRole("dialog", { name: "编辑任务" });
  await expect(dialog.getByLabel("开始时间（可选）")).toBeDisabled();
  await dialog.getByLabel("标题").fill("发布版本并复盘");
  await dialog.getByRole("button", { name: "保存" }).click();

  await expect(
    page.locator(".fc-event", { hasText: "发布版本并复盘" }),
  ).toBeVisible();
});

test("a time block can be unscheduled from its editor", async ({ page }) => {
  await page.getByTestId("quick-task-input").fill("整理笔记");
  await page.getByRole("button", { name: "添加任务" }).click();
  await dragTaskToTime(
    page,
    page.getByTestId("unscheduled-list").getByText("整理笔记"),
    "10:00",
  );

  await page.locator(".fc-event", { hasText: "整理笔记" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByRole("button", { name: "移回待安排" }).click();

  await expect(page.locator(".fc-event", { hasText: "整理笔记" })).toBeHidden();
  await expect(page.getByTestId("unscheduled-list")).toContainText("整理笔记");
});
