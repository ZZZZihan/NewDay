import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DayPlan } from "@newday/core/domain/planner-model";
import { plannerApi, type RecurrenceSeriesSnapshot } from "../api/planner-api";
import { usePlannerData, usePlannerSeries } from "./use-planner-data";

vi.mock("../api/planner-api", () => ({ plannerApi: { day: vi.fn(), series: vi.fn() } }));

function plan(selectedDate: string): DayPlan {
  return {
    selectedDate, asOfDate: "2026-09-08", isToday: selectedDate === "2026-09-08",
    focus: [], overdue: [], open: [], completed: [],
    counts: { open: 0, completed: 0, overdue: 0, focus: 0 },
  };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("planner API data lifecycle", () => {
  it("ignores a delayed response from the previously selected date", async () => {
    let finishOld!: (value: DayPlan) => void;
    vi.mocked(plannerApi.day)
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(plan("2026-09-09"));
    const { result, rerender } = renderHook(
      ({ date }) => usePlannerData(date, "2026-09-08", true),
      { initialProps: { date: "2026-09-08" } },
    );
    await waitFor(() => expect(plannerApi.day).toHaveBeenCalledTimes(1));
    rerender({ date: "2026-09-09" });
    await waitFor(() => expect(result.current.dayPlan?.selectedDate).toBe("2026-09-09"));
    await act(async () => finishOld(plan("2026-09-08")));
    expect(result.current.dayPlan?.selectedDate).toBe("2026-09-09");
  });

  it("refreshes the current date even when a mutation retained the old refresh callback", async () => {
    vi.mocked(plannerApi.day).mockImplementation(async (date) => plan(date));
    const { result, rerender } = renderHook(
      ({ date }) => usePlannerData(date, "2026-09-08", true),
      { initialProps: { date: "2026-09-08" } },
    );
    await waitFor(() => expect(result.current.dayPlan).toBeDefined());
    const refreshFromOldMutation = result.current.refresh;
    rerender({ date: "2026-09-09" });
    await waitFor(() => expect(result.current.dayPlan?.selectedDate).toBe("2026-09-09"));
    await act(async () => { await refreshFromOldMutation(); });
    expect(plannerApi.day).toHaveBeenLastCalledWith("2026-09-09", "2026-09-08", expect.any(AbortSignal));
    expect(result.current.dayPlan?.selectedDate).toBe("2026-09-09");
  });

  it("gates requests during legacy migration and exposes recoverable API failure", async () => {
    vi.mocked(plannerApi.day).mockRejectedValueOnce(new Error("后端未启动"));
    const { result, rerender } = renderHook(
      ({ enabled }) => usePlannerData("2026-09-08", "2026-09-08", enabled),
      { initialProps: { enabled: false } },
    );
    expect(plannerApi.day).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.error).toBe("后端未启动"));
    vi.mocked(plannerApi.day).mockResolvedValueOnce(plan("2026-09-08"));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.error).toBeNull();
    expect(result.current.dayPlan?.selectedDate).toBe("2026-09-08");
  });

  it("never exposes an old series as editable after a task revision changes or its request fails", async () => {
    const oldSeries: RecurrenceSeriesSnapshot = {
      id: "series", logicalSeriesId: "series", title: "重复任务", notes: "",
      startDate: "2026-09-08", effectiveEndDate: null, pattern: { kind: "daily" },
      end: { kind: "never" }, excludedDates: [],
      createdAt: "2026-09-08T01:00:00.000Z", updatedAt: "2026-09-08T01:00:00.000Z",
      tailRevision: "a".repeat(64),
    };
    let failReload!: (error: Error) => void;
    vi.mocked(plannerApi.series).mockResolvedValueOnce(oldSeries)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failReload = reject; }));
    const { result, rerender } = renderHook(
      ({ revision }) => usePlannerSeries("series", revision),
      { initialProps: { revision: "one" } },
    );
    await waitFor(() => expect(result.current.series).toEqual(oldSeries));
    expect(result.current.loading).toBe(false);
    rerender({ revision: "two" });
    expect(result.current.series).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await act(async () => { failReload(new Error("无法读取最新规则")); });
    expect(result.current.series).toBeUndefined();
    expect(result.current.error).toBe("无法读取最新规则");
  });

  it("checks series again after a day refresh while keeping the editor mounted and mutations blocked", async () => {
    const oldSeries: RecurrenceSeriesSnapshot = {
      id: "series", logicalSeriesId: "series", title: "重复任务", notes: "",
      startDate: "2026-09-08", effectiveEndDate: null, pattern: { kind: "daily" },
      end: { kind: "never" }, excludedDates: [],
      createdAt: "2026-09-08T01:00:00.000Z", updatedAt: "2026-09-08T01:00:00.000Z",
      tailRevision: "a".repeat(64),
    };
    let finishReload!: (series: RecurrenceSeriesSnapshot) => void;
    vi.mocked(plannerApi.series).mockResolvedValueOnce(oldSeries)
      .mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; }));
    const { result, rerender } = renderHook(
      ({ day }) => usePlannerSeries("series", "unchanged-task", day),
      { initialProps: { day: plan("2026-09-08") } },
    );
    await waitFor(() => expect(result.current.series).toEqual(oldSeries));
    rerender({ day: plan("2026-09-08") });
    expect(result.current.series).toEqual(oldSeries);
    expect(result.current.loading).toBe(true);
    const stoppedSeries: RecurrenceSeriesSnapshot = {
      ...oldSeries,
      end: { kind: "onDate", date: "2026-09-08" },
      tailRevision: "b".repeat(64),
    };
    await act(async () => { finishReload(stoppedSeries); });
    expect(result.current.loading).toBe(false);
    expect(result.current.series?.end).toEqual(stoppedSeries.end);
  });
});
