import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureRun } from "@newday/core/contracts/task-capture";
import type { TaskCaptureApi } from "../api/task-capture-api";
import type { CaptureSession, CaptureSessionStore } from "../hooks/task-capture-session";
import { TaskCapture, type TaskCaptureProps } from "./task-capture";

const today = "2026-09-22";
const now = "2026-09-22T02:00:00.000Z";
const drafts: CaptureRun["drafts"] = [
  { id: "draft-report", title: "整理项目汇报", notes: "准备例会材料", startDate: "2026-09-23", endDate: "2026-09-23", sourceText: "明天整理项目汇报", needsReview: false },
  { id: "draft-expenses", title: "核对报销材料", notes: "", startDate: "2026-09-25", endDate: "2026-09-25", sourceText: "周五核对报销材料", needsReview: false },
];

function makeRun(captureId: string, patch: Partial<CaptureRun> = {}): CaptureRun {
  return { captureId, mode: "direct", status: "ready", today, timeZone: "Asia/Shanghai", datasetEpoch: "epoch-1", createdAt: now, drafts, message: "已提取两条安排。", receipt: null, error: null, ...patch };
}

function appliedRun(captureId: string): CaptureRun {
  return makeRun(captureId, {
    status: "applied",
    receipt: { captureId, operationId: "direct-operation", createdAt: now, tasks: drafts.map((draft) => ({ id: `task-${draft.id}`, title: draft.title, notes: draft.notes, startDate: draft.startDate!, endDate: draft.endDate! })) },
  });
}

function makeApi() {
  return {
    status: vi.fn<TaskCaptureApi["status"]>(async () => ({ configured: true, modelId: "test-model" })),
    create: vi.fn<TaskCaptureApi["create"]>(async (body) => makeRun(body.requestId, { mode: body.mode })),
    run: vi.fn<TaskCaptureApi["run"]>(async (id) => makeRun(id)),
    apply: vi.fn<TaskCaptureApi["apply"]>(async (id, body) => makeRun(id, {
      mode: "transcript", status: "applied",
      receipt: { captureId: id, operationId: body.operationId, createdAt: now, tasks: body.tasks.map(({ draftId, ...task }) => ({ id: `task-${draftId}`, ...task })) },
    })),
    cancel: vi.fn<TaskCaptureApi["cancel"]>(async (id) => makeRun(id, { status: "interrupted" })),
  } satisfies TaskCaptureApi;
}

function sessionStore(): CaptureSessionStore {
  let saved: CaptureSession | null = null;
  return { load: () => saved && structuredClone(saved), save: (session) => { saved = structuredClone(session); } };
}

function setup(overrides: Partial<TaskCaptureProps> = {}, api = makeApi()) {
  const refresh = vi.fn(async () => undefined);
  const configure = vi.fn();
  const props = { timeZone: "Asia/Shanghai", onApplied: refresh, onConfigureTimeZone: configure, api, sessionStore: sessionStore(), ...overrides } satisfies TaskCaptureProps;
  return { ...render(<TaskCapture {...props} />), api, refresh, configure, props };
}

async function submit(mode: "direct" | "transcript" = "direct") {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.queryByText("正在读取待办提取设置…")).not.toBeInTheDocument());
  if (mode === "transcript") await user.click(screen.getByRole("button", { name: "粘贴已有对话" }));
  await user.type(screen.getByRole("textbox", { name: mode === "direct" ? "安排或待办内容" : "粘贴对话内容" }), "明天整理项目汇报，周五核对报销材料。");
  await user.click(screen.getByRole("button", { name: mode === "direct" ? "发送并加入待办" : "提取待办" }));
  return user;
}

afterEach(cleanup);

describe("Conversation task capture interface", () => {
  it("shows a direct creation receipt and refreshes tasks only once across remounts", async () => {
    const api = makeApi();
    api.create.mockImplementation(async (body) => appliedRun(body.requestId));
    api.run.mockImplementation(async (id) => appliedRun(id));
    const { refresh, props, unmount } = setup({}, api);
    await submit();
    const receipt = await screen.findByTestId("capture-receipt");
    expect(within(receipt).getByText("已加入 2 条待办")).toBeVisible();
    expect(within(receipt).getByText("整理项目汇报")).toBeVisible();
    expect(within(receipt).getByText("2026-09-25")).toBeVisible();
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ mode: "direct", text: "明天整理项目汇报，周五核对报销材料。" }));
    expect(api.apply).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);

    unmount();
    render(<TaskCapture {...props} />);
    await screen.findByTestId("capture-receipt");
    expect(api.run).toHaveBeenCalledWith(api.create.mock.calls[0]![0].requestId);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("previews transcript drafts and applies only the selected, edited task", async () => {
    const { api, refresh } = setup();
    const user = await submit("transcript");
    expect(await screen.findByRole("heading", { name: "确认要加入的待办" })).toBeVisible();
    expect(screen.getAllByTestId("capture-draft")).toHaveLength(2);
    expect(screen.getByText("原文：明天整理项目汇报")).toBeVisible();
    expect(screen.getByLabelText("标题 1")).toHaveValue("整理项目汇报");
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ mode: "transcript" }));
    expect(api.apply).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    const second = screen.getByRole("checkbox", { name: "选择待办 2" });
    second.focus();
    await user.keyboard(" ");
    expect(second).not.toBeChecked();
    await user.clear(screen.getByLabelText("标题 1"));
    await user.type(screen.getByLabelText("标题 1"), "完成项目汇报初稿");
    await user.clear(screen.getByLabelText("备注 1"));
    await user.type(screen.getByLabelText("备注 1"), "补充收入数据");
    fireEvent.change(screen.getByLabelText("结束日期 1"), { target: { value: "2026-09-24" } });
    await user.click(screen.getByRole("button", { name: "加入 1 条待办" }));

    const receipt = await screen.findByTestId("capture-receipt");
    expect(api.apply).toHaveBeenCalledExactlyOnceWith(api.create.mock.calls[0]![0].requestId, {
      operationId: expect.any(String),
      tasks: [{ draftId: "draft-report", title: "完成项目汇报初稿", notes: "补充收入数据", startDate: "2026-09-23", endDate: "2026-09-24" }],
    });
    expect(within(receipt).getByText("完成项目汇报初稿")).toBeVisible();
    expect(within(receipt).queryByText("核对报销材料")).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("requires valid dates for uncertain drafts before allowing creation", async () => {
    const api = makeApi();
    api.create.mockImplementation(async (body) => makeRun(body.requestId, {
      drafts: [{ ...drafts[0]!, startDate: null, endDate: null, needsReview: true }],
    }));
    setup({}, api);
    const user = await submit();
    expect(await screen.findByText("需要你确认：原文中的日期、归属或安排细节不够明确。")).toBeVisible();
    const apply = screen.getByRole("button", { name: "加入 1 条待办" });
    expect(apply).toBeDisabled();
    expect(api.apply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("开始日期 1"), { target: { value: "2026-09-23" } });
    fireEvent.change(screen.getByLabelText("结束日期 1"), { target: { value: "2026-09-22" } });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText("结束日期 1"), { target: { value: "2026-09-23" } });
    expect(apply).toBeEnabled();
    await user.click(apply);
    expect(await screen.findByTestId("capture-receipt")).toBeVisible();
  });

  it("never treats a model claim of creation as a saved-task receipt", async () => {
    const api = makeApi();
    api.create.mockImplementation(async (body) => makeRun(body.requestId, { message: "已创建 2 条待办。" }));
    const { refresh } = setup({}, api);
    await submit();
    expect(await screen.findByText("助手说明：已创建 2 条待办。")).toBeVisible();
    expect(screen.queryByTestId("capture-receipt")).not.toBeInTheDocument();
    expect(screen.queryByText("已加入 2 条待办")).not.toBeInTheDocument();
    expect(api.apply).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "加入 2 条待办" })).toBeEnabled();
  });

  it("explains an unconfigured model and keeps submission disabled", async () => {
    const api = makeApi();
    api.status.mockResolvedValue({ configured: false, modelId: null });
    setup({}, api);
    expect(await screen.findByText("尚未配置待办提取模型，配置后即可使用。")).toBeVisible();
    fireEvent.change(screen.getByLabelText("安排或待办内容"), { target: { value: "明天整理项目汇报" } });
    expect(screen.getByRole("button", { name: "发送并加入待办" })).toBeDisabled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("opens timezone setup and waits for a timezone before submitting", async () => {
    const { api, configure } = setup({ timeZone: null });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "设置规划时区" }));
    expect(configure).toHaveBeenCalledTimes(1);
    expect(screen.getByText("先保存规划时区，助手才能正确理解“今天”和“明天”。")).toBeVisible();
    fireEvent.change(screen.getByLabelText("安排或待办内容"), { target: { value: "明天整理项目汇报" } });
    expect(screen.getByRole("button", { name: "发送并加入待办" })).toBeDisabled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("waits for migration to finish before loading capture status", async () => {
    const { api, props, rerender } = setup({ disabled: true, disabledReason: "正在迁移旧浏览器任务…" });
    expect(screen.getByRole("status")).toHaveTextContent("正在迁移旧浏览器任务…");
    expect(screen.getByLabelText("安排或待办内容")).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送并加入待办" })).toBeDisabled();
    expect(api.status).not.toHaveBeenCalled();
    expect(api.run).not.toHaveBeenCalled();
    rerender(<TaskCapture {...props} disabled={false} disabledReason={undefined} />);
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("安排或待办内容")).toBeEnabled();
  });
});
