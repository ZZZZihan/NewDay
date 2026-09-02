import { describe, expect, it } from "vitest";

import { MemoryPlannerStore } from "../adapters/memory-planner-store";
import type { RecurrenceSeries } from "../domain/planner-model";
import { recurrenceOccurrenceKey } from "../domain/planner-recurrence";
import { ensureRecurrenceOccurrences } from "./recurrence-generation";

const AS_OF_DATE = "2026-09-01";
const NOW = "2026-09-01T08:00:00.000Z";

function series(
  overrides: Partial<RecurrenceSeries> = {},
): RecurrenceSeries {
  return {
    id: "series-1",
    title: "每日复盘",
    notes: "记录一句话",
    startDate: "2026-08-29",
    pattern: { kind: "daily" },
    end: { kind: "never" },
    excludedDates: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("ensureRecurrenceOccurrences", () => {
  it("materializes only the requested range without historical backfill", async () => {
    const store = new MemoryPlannerStore();
    await store.putRecurrenceSeries(series());

    const created = await ensureRecurrenceOccurrences(store, {
      asOfDate: AS_OF_DATE,
      throughDate: "2026-09-03",
      now: NOW,
    });

    expect(created.map((task) => task.occurrenceDate)).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
    ]);
    expect(
      (await store.listAllTasks()).some(
        (task) => task.occurrenceDate === "2026-08-31",
      ),
    ).toBe(false);
  });

  it("uses stable occurrence keys and ids and is idempotent", async () => {
    const store = new MemoryPlannerStore();
    await store.putRecurrenceSeries(series());

    const first = await ensureRecurrenceOccurrences(store, {
      asOfDate: AS_OF_DATE,
      throughDate: AS_OF_DATE,
      now: NOW,
    });
    const second = await ensureRecurrenceOccurrences(store, {
      asOfDate: AS_OF_DATE,
      throughDate: AS_OF_DATE,
      now: "2026-09-01T09:00:00.000Z",
    });
    const occurrenceKey = recurrenceOccurrenceKey("series-1", AS_OF_DATE);

    expect(first).toEqual([
      expect.objectContaining({
        id: occurrenceKey,
        occurrenceKey,
        occurrenceDate: AS_OF_DATE,
        seriesId: "series-1",
        startDate: AS_OF_DATE,
        endDate: AS_OF_DATE,
        isSeriesException: false,
      }),
    ]);
    expect(second).toEqual([]);
    expect(await store.listAllTasks()).toHaveLength(1);
  });

  it("skips excluded dates and can ensure one additional future date", async () => {
    const store = new MemoryPlannerStore();
    await store.putRecurrenceSeries(
      series({ excludedDates: ["2026-09-02", "2026-09-10"] }),
    );

    await ensureRecurrenceOccurrences(store, {
      asOfDate: AS_OF_DATE,
      throughDate: "2026-09-03",
      additionallyEnsureDate: "2026-09-10",
      now: NOW,
    });

    expect(
      (await store.listAllTasks()).map((task) => task.occurrenceDate),
    ).toEqual(["2026-09-01", "2026-09-03"]);
  });

  it("ensures a matching future date but never an extra pre-asOf date", async () => {
    const futureStore = new MemoryPlannerStore();
    await futureStore.putRecurrenceSeries(series());
    await ensureRecurrenceOccurrences(futureStore, {
      asOfDate: AS_OF_DATE,
      throughDate: AS_OF_DATE,
      additionallyEnsureDate: "2026-10-01",
      now: NOW,
    });
    expect(
      (await futureStore.listAllTasks()).map((task) => task.occurrenceDate),
    ).toEqual([AS_OF_DATE, "2026-10-01"]);

    const pastStore = new MemoryPlannerStore();
    await pastStore.putRecurrenceSeries(series());
    await ensureRecurrenceOccurrences(pastStore, {
      asOfDate: AS_OF_DATE,
      throughDate: AS_OF_DATE,
      additionallyEnsureDate: "2026-08-31",
      now: NOW,
    });
    expect(
      (await pastStore.listAllTasks()).map((task) => task.occurrenceDate),
    ).toEqual([AS_OF_DATE]);
  });

  it("rejects an inverted generation range without writing", async () => {
    const store = new MemoryPlannerStore();
    await store.putRecurrenceSeries(series());

    await expect(
      ensureRecurrenceOccurrences(store, {
        asOfDate: "2026-09-03",
        throughDate: AS_OF_DATE,
        now: NOW,
      }),
    ).rejects.toThrow("生成结束日期不能早于开始日期");
    expect(await store.listAllTasks()).toEqual([]);
  });
});
