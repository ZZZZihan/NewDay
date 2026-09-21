import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeWorkspace } from "@newday/core/domain/life-model";
import type { Task } from "@newday/core/domain/planner-model";
import { lifeApi } from "../api/life-api";
import { useLifeWorkspace } from "./use-life-workspace";

vi.mock("../api/life-api", () => ({ lifeApi: { workspace: vi.fn() } }));

const at = "2026-09-22T00:00:00.000Z";
const pollInterval = 30_000;
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
let visibility: DocumentVisibilityState = "visible";

function task(title: string, overrides: Partial<Task> = {}): Task {
  return { id: "task-1", title, notes: "", startDate: "2026-09-22", endDate: "2026-09-22",
    status: "open", createdAt: at, updatedAt: at, completedAt: null, completedOn: null, ...overrides };
}

function workspace(tasks: Task[]): LifeWorkspace {
  return { inboxItems: [], folders: [], resources: [], resourceTaskLinks: [], tasks };
}

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
});

describe("life workspace background freshness", () => {
  it("shows backend task title, status, and date changes on the next 30 second visible poll", async () => {
    vi.mocked(lifeApi.workspace)
      .mockResolvedValueOnce(workspace([task("轮询前任务")]))
      .mockResolvedValueOnce(workspace([
        task("轮询后的标题", {
          startDate: "2026-09-23",
          endDate: "2026-09-24",
          status: "completed",
          completedAt: "2026-09-22T00:00:01.000Z",
          completedOn: "2026-09-23",
          updatedAt: "2026-09-22T00:00:01.000Z",
        }),
      ]));
    const { result } = renderHook(() => useLifeWorkspace(true));
    await flush();
    expect(result.current.workspace?.tasks.map((item) => item.title)).toEqual(["轮询前任务"]);

    await act(async () => { await vi.advanceTimersByTimeAsync(pollInterval); });
    expect(result.current.workspace?.tasks[0]).toEqual(expect.objectContaining({
      title: "轮询后的标题",
      startDate: "2026-09-23",
      endDate: "2026-09-24",
      status: "completed",
    }));
    expect(lifeApi.workspace).toHaveBeenCalledTimes(2);
  });

  it("shows a backend addition and an existing task becoming archived without duplication", async () => {
    vi.mocked(lifeApi.workspace)
      .mockResolvedValueOnce(workspace([task("待归档任务")]))
      .mockResolvedValueOnce(workspace([
        task("待归档任务", { archived: true, updatedAt: "2026-09-22T00:00:01.000Z" }),
        task("后台新增任务", { id: "task-2", updatedAt: "2026-09-22T00:00:01.000Z" }),
      ]));
    const { result } = renderHook(() => useLifeWorkspace(true));
    await flush();

    await act(async () => { await vi.advanceTimersByTimeAsync(pollInterval); });
    expect(result.current.workspace?.tasks.map((item) => [item.id, item.archived ?? false])).toEqual([
      ["task-1", true], ["task-2", false],
    ]);
    expect(new Set(result.current.workspace?.tasks.map((item) => item.id))).toEqual(
      new Set(["task-1", "task-2"]),
    );
  });

  it("stops polling while hidden and revalidates once visibility or focus returns", async () => {
    vi.mocked(lifeApi.workspace).mockResolvedValue(workspace([]));
    renderHook(() => useLifeWorkspace(true));
    await flush();
    expect(lifeApi.workspace).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(pollInterval * 3); });
    expect(lifeApi.workspace).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(lifeApi.workspace).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(lifeApi.workspace).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("ignores an older response and any response after the workspace is disabled", async () => {
    vi.mocked(lifeApi.workspace).mockResolvedValueOnce(workspace([task("初始任务")]));
    const { result, rerender } = renderHook(({ enabled }) => useLifeWorkspace(enabled),
      { initialProps: { enabled: true } });
    await flush();

    let finishOld!: (value: LifeWorkspace) => void;
    let finishNew!: (value: LifeWorkspace) => void;
    vi.mocked(lifeApi.workspace)
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    let oldRequest!: Promise<void>;
    let newRequest!: Promise<void>;
    act(() => { oldRequest = result.current.refresh(); });
    act(() => { newRequest = result.current.refresh(); });
    await act(async () => { finishNew(workspace([task("较新响应")])); await newRequest; });
    await act(async () => { finishOld(workspace([task("迟到旧响应")])); await oldRequest; });
    expect(result.current.workspace?.tasks[0]?.title).toBe("较新响应");

    let finishDisabled!: (value: LifeWorkspace) => void;
    vi.mocked(lifeApi.workspace).mockImplementationOnce(() => new Promise((resolve) => { finishDisabled = resolve; }));
    let disabledRequest!: Promise<void>;
    act(() => { disabledRequest = result.current.refresh(); });
    rerender({ enabled: false });
    await act(async () => { finishDisabled(workspace([task("禁用后迟到响应")])); await disabledRequest; });
    expect(result.current.workspace?.tasks[0]?.title).toBe("较新响应");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains loaded data on failure and clears the error after the next successful poll", async () => {
    vi.mocked(lifeApi.workspace)
      .mockResolvedValueOnce(workspace([task("已加载任务")]))
      .mockRejectedValueOnce(new Error("网络暂不可用"))
      .mockResolvedValueOnce(workspace([task("网络恢复后的任务")]));
    const { result } = renderHook(() => useLifeWorkspace(true));
    await flush();

    await act(async () => { await vi.advanceTimersByTimeAsync(pollInterval); });
    expect(result.current.error).toBe("网络暂不可用");
    expect(result.current.workspace?.tasks[0]?.title).toBe("已加载任务");
    await act(async () => { await vi.advanceTimersByTimeAsync(pollInterval); });
    expect(result.current.error).toBeNull();
    expect(result.current.workspace?.tasks[0]?.title).toBe("网络恢复后的任务");
  });
});
