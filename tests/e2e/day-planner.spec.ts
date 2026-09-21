import { expect, test } from "./fixtures";

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("个人工作台")).toBeVisible();
});

test("the home view has a large minute clock and no timeline", async ({ page }) => {
  const clock = page.getByTestId("current-clock");
  await expect(clock).not.toHaveText("--:--");
  await expect(clock).toHaveText(/^\d{2}:\d{2}$/);
  await expect(page.getByLabel("时间与日期")).toBeVisible();
  await expect(page.getByLabel("每日任务表")).toBeVisible();
  await expect(page.getByText("当天时间轴")).toHaveCount(0);
  await expect(page.getByText("预计时长")).toHaveCount(0);
});

test("fullscreen gives the clock a wide desktop column", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole("button", { name: "进入全屏" }).click();
  await expect(page.getByRole("button", { name: "退出全屏" })).toHaveAttribute("aria-pressed", "true");

  const layout = await page.evaluate(() => {
    const frame = document.querySelector(".planner-frame");
    const time = document.querySelector(".time-panel");
    const clock = document.querySelector(".hero-clock");
    if (!frame || !time || !clock) throw new Error("Fullscreen layout is incomplete");
    return {
      frameWidth: frame.getBoundingClientRect().width,
      timeWidth: time.getBoundingClientRect().width,
      clockSize: Number.parseFloat(getComputedStyle(clock).fontSize),
    };
  });
  expect(layout.frameWidth).toBeGreaterThan(1800);
  expect(layout.timeWidth / layout.frameWidth).toBeGreaterThan(0.38);
  expect(layout.timeWidth / layout.frameWidth).toBeLessThan(0.42);
  expect(layout.clockSize).toBeGreaterThan(220);

  await page.getByRole("button", { name: "退出全屏" }).click();
  await expect(page.getByRole("button", { name: "进入全屏" })).toHaveAttribute("aria-pressed", "false");
});

test("low-frequency backup actions stay inside the more menu", async ({ page }) => {
  const menu = page.getByRole("menu", { name: "更多操作菜单" });
  await expect(menu).toBeHidden();

  await page.getByRole("button", { name: "更多操作" }).click();
  await expect(menu).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "导出数据" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "导入数据" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("a task defaults to the selected day and survives a reload", async ({ page }) => {
  const selectedDate = await page.getByLabel("选择日期").inputValue();
  await page.getByTestId("quick-task-input").fill("准备项目周会");
  await page.getByRole("button", { name: "添加任务" }).click();

  await expect(page.getByTestId("daily-task-list")).toContainText("准备项目周会");
  await expect(
    page.getByLabel("任务统计").locator(":scope > div").first().getByText("1", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "编辑任务：准备项目周会" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑任务" });
  await expect(dialog.getByLabel("开始日期")).toHaveValue(selectedDate);
  await expect(dialog.getByLabel("截止日期")).toHaveValue(selectedDate);
  await dialog.getByRole("button", { name: "取消" }).click();

  await page.reload();
  await expect(page.getByTestId("daily-task-list")).toContainText("准备项目周会");
});

test("a task appears on every day in its inclusive date range", async ({ page }) => {
  const selectedDate = await page.getByLabel("选择日期").inputValue();
  const tomorrow = shiftDate(selectedDate, 1);

  await page.getByTestId("quick-task-input").fill("跨两天完成");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "编辑任务：跨两天完成" }).click();

  const dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("截止日期").fill(tomorrow);
  await dialog.getByRole("button", { name: "保存" }).click();

  await expect(page.getByTestId("daily-task-list")).toContainText("跨两天完成");
  await page.getByRole("button", { name: "后一天" }).click();
  await expect(page.getByLabel("选择日期")).toHaveValue(tomorrow);
  await expect(page.getByTestId("daily-task-list")).toContainText("跨两天完成");

  await page.getByRole("button", { name: "后一天" }).click();
  await expect(page.getByTestId("daily-task-list")).not.toContainText("跨两天完成");
});

test("a task can be edited, completed, and restored", async ({ page }) => {
  await page.getByTestId("quick-task-input").fill("回复邮件");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "编辑任务：回复邮件" }).click();

  let dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("标题").fill("回复重要邮件");
  await dialog.getByLabel("备注").fill("先确认附件");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("daily-task-list")).toContainText("回复重要邮件");

  await page.getByRole("button", { name: "完成任务：回复重要邮件" }).click();
  await expect(page.getByText("已完成 · 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "恢复任务：回复重要邮件" })).toBeVisible();

  await page.getByRole("button", { name: "编辑任务：回复重要邮件" }).click();
  dialog = page.getByRole("dialog", { name: "编辑任务" });
  await expect(dialog.getByLabel("备注")).toHaveValue("先确认附件");
  await dialog.getByRole("button", { name: "恢复任务" }).click();
  await expect(page.getByTestId("daily-task-list")).toContainText("回复重要邮件");
});

test("a daily recurrence creates an independent task tomorrow", async ({ page }) => {
  await page.getByTestId("quick-task-input").fill("每日复盘");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "编辑任务：每日复盘" }).click();

  const dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("重复", { exact: true }).selectOption("daily");
  await dialog.getByRole("button", { name: "保存" }).click();

  await expect(page.getByTestId("daily-task-list")).toContainText("重复");
  await page.getByRole("button", { name: "后一天" }).click();
  await expect(page.getByTestId("daily-task-list")).toContainText("每日复盘");

  await page.getByRole("button", { name: "完成任务：每日复盘" }).click();
  await expect(page.getByText("已完成 · 1")).toBeVisible();
  await page.getByRole("button", { name: "前一天" }).click();
  await expect(page.getByRole("button", { name: "完成任务：每日复盘" })).toBeVisible();
});

test("a future broader recurrence rule respects its cutover and can be undone", async ({
  page,
}) => {
  const selectedDate = await page.getByLabel("选择日期").inputValue();
  const preCutover = shiftDate(selectedDate, 1);
  const cutover = shiftDate(selectedDate, 7);
  const afterCutover = shiftDate(cutover, 1);
  const title = "每周检查任务";
  await page.getByTestId("quick-task-input").fill(title);
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: `编辑任务：${title}` }).click();

  let dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("重复", { exact: true }).selectOption("weekly");
  await dialog.getByRole("button", { name: "保存" }).click();

  await page.getByLabel("选择日期").fill(cutover);
  await expect(
    page.getByRole("button", { name: `编辑任务：${title}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: `编辑任务：${title}` }).click();
  dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("编辑范围").selectOption("series");
  await dialog.getByLabel("重复", { exact: true }).selectOption("daily");
  await dialog.getByRole("button", { name: "保存" }).click();

  const notice = page.getByTestId("app-notice");
  await expect(notice).toContainText("后续重复已更新");
  await page.getByLabel("选择日期").fill(preCutover);
  await expect(
    page.getByRole("button", { name: `编辑任务：${title}` }),
  ).toHaveCount(0);
  await page.getByLabel("选择日期").fill(afterCutover);
  await expect(
    page.getByRole("button", { name: `编辑任务：${title}` }),
  ).toBeVisible();

  await notice.getByRole("button", { name: "撤销" }).click();
  await expect(notice).toContainText("已撤销");
  await expect(
    page.getByRole("button", { name: `编辑任务：${title}` }),
  ).toHaveCount(0);
  await page.getByLabel("选择日期").fill(cutover);
  await expect(
    page.getByRole("button", { name: `编辑任务：${title}` }),
  ).toBeVisible();
});

test("stopping recurrence previews impact, supports cancel, and can be undone", async ({
  page,
}) => {
  const selectedDate = await page.getByLabel("选择日期").inputValue();
  const tomorrow = shiftDate(selectedDate, 1);
  const title = "两天重复任务";
  await page.getByTestId("quick-task-input").fill(title);
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: `编辑任务：${title}` }).click();

  let dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("重复", { exact: true }).selectOption("daily");
  await dialog.getByLabel("重复结束").selectOption("onDate");
  await dialog.getByLabel("重复截止日期").fill(tomorrow);
  await dialog.getByRole("button", { name: "保存" }).click();

  await page.getByRole("button", { name: "后一天" }).click();
  await expect(page.getByLabel("选择日期")).toHaveValue(tomorrow);
  await expect(
    page.getByRole("button", { name: `编辑任务：${title}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "前一天" }).click();
  await page.getByRole("button", { name: `编辑任务：${title}` }).click();
  dialog = page.getByRole("dialog", { name: "编辑任务" });

  const expectedMessage = `将停止 ${selectedDate} 之后的重复，并移除 1 个已生成且尚未完成的普通实例。你可以在提示消失前撤销。继续吗？`;
  let confirmationPromise = page.waitForEvent("dialog");
  let stopClick = dialog
    .getByRole("button", { name: "停止后续重复" })
    .click();
  let confirmation = await confirmationPromise;
  expect(confirmation.message()).toBe(expectedMessage);
  await confirmation.dismiss();
  await stopClick;
  await expect(dialog).toBeVisible();

  confirmationPromise = page.waitForEvent("dialog");
  stopClick = dialog.getByRole("button", { name: "停止后续重复" }).click();
  confirmation = await confirmationPromise;
  expect(confirmation.message()).toBe(expectedMessage);
  await confirmation.accept();
  await stopClick;
  await expect(dialog).toHaveCount(0);

  const notice = page.getByTestId("app-notice");
  await expect(notice).toContainText("已停止后续重复");
  await page.getByRole("button", { name: "后一天" }).click();
  await expect(
    page.getByRole("button", { name: `编辑任务：${title}` }),
  ).toHaveCount(0);

  await notice.getByRole("button", { name: "撤销" }).click();
  await expect(notice).toContainText("已撤销");
  await expect(
    page.getByRole("button", { name: `编辑任务：${title}` }),
  ).toBeVisible();
});

test("today focus is limited to three tasks without duplicate rows", async ({ page }) => {
  for (const title of ["重点一", "重点二", "重点三", "普通四"]) {
    await page.getByTestId("quick-task-input").fill(title);
    await page.getByRole("button", { name: "添加任务" }).click();
  }

  for (const title of ["重点一", "重点二", "重点三"]) {
    await page.getByRole("button", { name: `设为今日重点：${title}` }).click();
  }

  await expect(page.getByRole("heading", { name: "今日重点 3" })).toBeVisible();
  await expect(page.getByText("今日重点最多 3 项")).toBeVisible();
  await expect(page.getByRole("button", { name: "设为今日重点：普通四" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "编辑任务：重点一" })).toHaveCount(1);
});

test("completion can be undone from the transient notice", async ({ page }) => {
  await page.getByTestId("quick-task-input").fill("可撤销任务");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "完成任务：可撤销任务" }).click();

  const notice = page.getByTestId("app-notice");
  await expect(notice).toContainText("任务已完成");
  await notice.getByRole("button", { name: "撤销" }).click();
  await expect(notice).toContainText("已撤销");
  await expect(page.getByRole("button", { name: "完成任务：可撤销任务" })).toBeVisible();
});

test("deletion restores the full task through undo", async ({ page }) => {
  await page.getByTestId("quick-task-input").fill("删除后恢复");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "编辑任务：删除后恢复" }).click();

  let dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("备注").fill("撤销后仍要保留");
  await dialog.getByRole("button", { name: "保存" }).click();
  await page.getByRole("button", { name: "编辑任务：删除后恢复" }).click();
  dialog = page.getByRole("dialog", { name: "编辑任务" });
  page.once("dialog", (confirmation) => confirmation.accept());
  await dialog.getByRole("button", { name: "删除" }).click();

  const notice = page.getByTestId("app-notice");
  await expect(notice).toContainText("任务已删除");
  await notice.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByRole("button", { name: "编辑任务：删除后恢复" })).toBeVisible();

  await page.getByRole("button", { name: "编辑任务：删除后恢复" }).click();
  await expect(page.getByRole("dialog", { name: "编辑任务" }).getByLabel("备注")).toHaveValue(
    "撤销后仍要保留",
  );
});

test("rescheduling restores the original date through undo", async ({ page }) => {
  const selectedDate = await page.getByLabel("选择日期").inputValue();
  const tomorrow = shiftDate(selectedDate, 1);
  await page.getByTestId("quick-task-input").fill("改期后恢复");
  await page.getByRole("button", { name: "添加任务" }).click();
  await page.getByRole("button", { name: "编辑任务：改期后恢复" }).click();

  let dialog = page.getByRole("dialog", { name: "编辑任务" });
  await dialog.getByLabel("开始日期").fill(tomorrow);
  await dialog.getByLabel("截止日期").fill(tomorrow);
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("button", { name: "编辑任务：改期后恢复" })).toHaveCount(0);

  const notice = page.getByTestId("app-notice");
  await notice.getByRole("button", { name: "撤销" }).click();
  await page.getByRole("button", { name: "编辑任务：改期后恢复" }).click();
  dialog = page.getByRole("dialog", { name: "编辑任务" });
  await expect(dialog.getByLabel("开始日期")).toHaveValue(selectedDate);
  await expect(dialog.getByLabel("截止日期")).toHaveValue(selectedDate);
});

test("clearing the native date input keeps the current day selected", async ({
  page,
}) => {
  const dateInput = page.getByLabel("选择日期");
  const originalDate = await dateInput.inputValue();

  await dateInput.fill("");

  await expect(dateInput).toHaveValue(originalDate);
  await expect(page.getByText("个人工作台")).toBeVisible();
});
