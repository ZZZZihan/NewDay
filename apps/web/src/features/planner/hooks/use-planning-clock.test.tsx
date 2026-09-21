import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "@/shared/http/request";
import { usePlanningClock } from "./use-planning-clock";

vi.mock("@/shared/http/request", () => ({ request: vi.fn() }));
const status = { configured: false, modelId: null, today: "2026-09-08", timeZone: "Asia/Shanghai" };
describe("saved planning clock", () => {
  beforeEach(() => vi.mocked(request).mockReset());
  it("uses the server date even when it differs from the browser date", async () => {
    vi.mocked(request).mockResolvedValue(status);
    const { result } = renderHook(() => usePlanningClock(10));
    await waitFor(() => expect(result.current.status?.today).toBe("2026-09-08"));
    expect(result.current.status?.timeZone).toBe("Asia/Shanghai");
  });
  it("refreshes at the minute boundary and after a timezone change", async () => {
    vi.mocked(request).mockResolvedValue(status);
    const { result, rerender } = renderHook(({ minute }) => usePlanningClock(minute), { initialProps: { minute: 10 } });
    await waitFor(() => expect(result.current.ready).toBe(true));
    vi.mocked(request).mockResolvedValue({ ...status, today: "2026-09-09" });
    rerender({ minute: 11 });
    await waitFor(() => expect(result.current.status?.today).toBe("2026-09-09"));
    vi.mocked(request).mockResolvedValue({ ...status, timeZone: "America/Los_Angeles" });
    act(() => window.dispatchEvent(new Event("newday:planning-clock-changed")));
    await waitFor(() => expect(result.current.status?.timeZone).toBe("America/Los_Angeles"));
  });
  it("ignores an older response after a preference refresh", async () => {
    let release!: (value: unknown) => void;
    vi.mocked(request).mockReturnValueOnce(new Promise((resolve) => { release = resolve; })).mockResolvedValue(status);
    const { result } = renderHook(() => usePlanningClock(10));
    act(() => window.dispatchEvent(new Event("newday:planning-clock-changed")));
    await waitFor(() => expect(result.current.status?.today).toBe("2026-09-08"));
    await act(async () => release({ ...status, today: "2026-09-07" }));
    expect(result.current.status?.today).toBe("2026-09-08");
  });
});
