import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPlanner, focusDiff } from "./agent-planner";
import { clarificationProposalFixture, fixtureDate, fixtureNow, historyFixture, makeApi, noActionProposalFixture, runResponseFixture, sessionStore } from "../__tests__/fixtures";

beforeEach(() => { vi.setSystemTime(new Date(fixtureNow)); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(api = makeApi()) {
  const refresh = vi.fn(async () => undefined);
  render(<AgentPlanner selectedDate={fixtureDate} today={fixtureDate} api={api} sessionStore={sessionStore()} onApplied={refresh} />);
  return { api, refresh };
}
async function generate() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "帮我定今日重点" }));
  await user.click(screen.getByRole("button", { name: "帮我定今日重点" }));
  return user;
}
describe("Agent planning interface", () => {
  it("shows exact added, retained and removed sets before any task writes", async () => {
    const { api, refresh } = setup(); await generate();
    const preview = await screen.findByTestId("agent-focus-preview");
    const added = within(preview).getByText("新增").nextElementSibling;
    const retained = within(preview).getByText("保留").nextElementSibling;
    const removed = within(preview).getByText("移除").nextElementSibling;
    expect(added).toHaveTextContent("整理项目汇报"); expect(retained).toHaveTextContent("核对项目数据"); expect(removed).toHaveTextContent("整理桌面");
    expect(screen.getByText("明确假设")).toBeVisible(); expect(screen.getAllByText("来源：当天输入 · 当天目标：完成项目汇报")).toHaveLength(2);
    expect(api.apply).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "建议的今日重点" })).toHaveFocus();
  });
  it("allows keyboard selection and applies only the displayed final selection", async () => {
    const { api, refresh } = setup(); const user = await generate();
    const checkbox = await screen.findByRole("checkbox", { name: "核对项目数据" });
    checkbox.focus(); await user.keyboard(" ");
    expect(checkbox).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "采纳今日重点" }));
    await screen.findByText("今日重点已更新。");
    expect(api.apply.mock.calls[0]?.[0].taskIds).toEqual(["task-report"]); expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("renders bounded clarification with an explicit unknown fallback", async () => {
    const api = makeApi(); api.createRun.mockResolvedValue({ ...runResponseFixture, run: { ...runResponseFixture.run, status: "needs_clarification" }, proposal: clarificationProposalFixture });
    setup(api); const user = await generate();
    expect(await screen.findByLabelText("今天的汇报优先整理材料还是核对数据？")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "提交回答" }));
    expect(api.answer.mock.calls[0]?.[1].answers[0]?.answer).toBe("不知道");
    expect(api.apply).not.toHaveBeenCalled();
  });
  it("renders no_action honestly without an apply control", async () => {
    const api = makeApi(); api.createRun.mockResolvedValue({ ...runResponseFixture, run: { ...runResponseFixture.run, status: "no_action" }, proposal: noActionProposalFixture });
    setup(api); await generate();
    expect(await screen.findByText("今天已明确休息，保留现有重点")).toBeVisible();
    expect(screen.queryByRole("button", { name: "采纳今日重点" })).not.toBeInTheDocument(); expect(api.apply).not.toHaveBeenCalled();
  });
  it("keeps unconfigured status accurate and disables generation", async () => {
    const api = makeApi(); api.status.mockResolvedValue({ configured: false, modelId: null, today: fixtureDate, timeZone: "Asia/Shanghai" });
    setup(api); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "帮我定今日重点" }));
    expect(screen.getByRole("button", { name: "帮我定今日重点" })).toBeDisabled();
    expect(screen.getByText(/尚未配置规划模型/)).toBeVisible(); expect(api.createRun).not.toHaveBeenCalled();
  });
  it("shows imported history read-only and does not associate unknown outcomes with current task state", async () => {
    const api = makeApi(); api.history.mockResolvedValue({ ...historyFixture, entries: [{ ...historyFixture.entries[0]!, readOnly: true }] });
    setup(api);
    const history = await screen.findByTestId("agent-history");
    fireEvent.click(within(history).getByText(/当日决策记录/));
    expect(await screen.findByText("来自旧数据集，只读记录")).toBeVisible();
    expect(screen.getByText("整理项目汇报 · 结果未知")).toBeVisible();
    expect(within(history).queryByRole("button", { name: "记录反馈" })).not.toBeInTheDocument();
    expect(within(history).queryByRole("button", { name: /恢复/ })).not.toBeInTheDocument();
  });
  it("computes replacement focus rather than additive focus", () => {
    expect(focusDiff(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], retained: ["b"], removed: ["a"] });
  });
  it("waits for legacy migration before restoring planning requests", async () => {
    const api = makeApi(); const store = sessionStore({ date: fixtureDate, runId: "old-run" });
    const refresh = vi.fn(async () => undefined);
    const view = render(<AgentPlanner selectedDate={fixtureDate} today={fixtureDate} disabled disabledReason="正在迁移旧浏览器任务…" api={api} sessionStore={store} onApplied={refresh} />);
    expect(api.status).not.toHaveBeenCalled(); expect(api.run).not.toHaveBeenCalled();
    expect(screen.getByText("正在迁移旧浏览器任务…")).toBeVisible();
    view.rerender(<AgentPlanner selectedDate={fixtureDate} today={fixtureDate} api={api} sessionStore={store} onApplied={refresh} />);
    await screen.findByRole("heading", { name: "建议的今日重点" });
    expect(api.run).toHaveBeenCalledWith("old-run");
  });
  it("does not expose another clarification submission for an interrupted or failed run", async () => {
    const api = makeApi(); api.createRun.mockResolvedValue({ ...runResponseFixture, run: { ...runResponseFixture.run, status: "failed", clarificationRound: 1, error: { code: "MODEL_TIMEOUT", status: 504, message: "模型响应超时", retryable: true } }, proposal: clarificationProposalFixture });
    setup(api); await generate();
    expect(await screen.findByText("模型响应超时")).toBeVisible();
    expect(screen.queryByRole("button", { name: "提交回答" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "采纳今日重点" })).not.toBeInTheDocument();
  });
});
