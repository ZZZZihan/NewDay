import { describe, expect, it } from "vitest";

import type { RecurrenceSeries } from "@newday/core/domain/planner-model";
import {
  recurrenceDatesInRange,
  recurrenceOccurrenceKey,
  recursOnDate,
} from "@newday/core/domain/planner-recurrence";

function series(
  overrides: Partial<RecurrenceSeries> = {},
): RecurrenceSeries {
  return {
    id: "series:morning",
    logicalSeriesId: "series:morning",
    title: "晨间复盘",
    notes: "",
    startDate: "2026-01-01",
    effectiveEndDate: null,
    pattern: { kind: "daily" },
    end: { kind: "never" },
    excludedDates: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("recurrenceOccurrenceKey", () => {
  it("builds the canonical key from series id and nominal date", () => {
    expect(recurrenceOccurrenceKey("series:morning", "2026-09-01")).toBe(
      "series:morning:2026-09-01",
    );
  });
});

describe("recursOnDate", () => {
  it("supports daily and weekday patterns using local calendar dates", () => {
    expect(recursOnDate(series(), "2026-09-05")).toBe(true);

    const weekdays = series({ pattern: { kind: "weekdays" } });
    expect(recursOnDate(weekdays, "2026-09-04")).toBe(true);
    expect(recursOnDate(weekdays, "2026-09-05")).toBe(false);
    expect(recursOnDate(weekdays, "2026-09-06")).toBe(false);
    expect(recursOnDate(weekdays, "2026-09-07")).toBe(true);
  });

  it("supports sorted ISO weekdays", () => {
    const weekly = series({
      startDate: "2026-09-01",
      pattern: { kind: "weekly", weekdays: [1, 3, 7] },
    });

    expect(recurrenceDatesInRange(weekly, "2026-09-01", "2026-09-07")).toEqual([
      "2026-09-02",
      "2026-09-06",
      "2026-09-07",
    ]);
  });

  it("treats user and effective ending dates as inclusive", () => {
    const ending = series({
      startDate: "2026-09-01",
      effectiveEndDate: "2026-09-03",
      end: { kind: "onDate", date: "2026-09-04" },
    });

    expect(recurrenceDatesInRange(ending, "2026-08-30", "2026-09-05")).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
    ]);
  });

  it("excludes nominal dates without shifting recurrence", () => {
    const excluding = series({
      startDate: "2026-09-01",
      excludedDates: ["2026-09-02"],
    });

    expect(recurrenceDatesInRange(excluding, "2026-09-01", "2026-09-03")).toEqual([
      "2026-09-01",
      "2026-09-03",
    ]);
  });
});

describe("monthly recurrence", () => {
  it.each([
    [29, ["2026-01-29", "2026-02-28", "2026-03-29"]],
    [30, ["2026-01-30", "2026-02-28", "2026-03-30"]],
    [31, ["2026-01-31", "2026-02-28", "2026-03-31"]],
  ] as const)("clamps day %i independently without drift", (dayOfMonth, expected) => {
    const monthly = series({
      startDate: `2026-01-${dayOfMonth}`,
      pattern: { kind: "monthly", dayOfMonth },
    });

    expect(recurrenceDatesInRange(monthly, "2026-01-01", "2026-03-31")).toEqual(
      expected,
    );
  });

  it("uses leap day in leap years and clamps February otherwise", () => {
    const monthly = series({
      startDate: "2027-01-29",
      pattern: { kind: "monthly", dayOfMonth: 29 },
    });

    expect(recurrenceDatesInRange(monthly, "2027-02-01", "2028-03-31")).toContain(
      "2027-02-28",
    );
    expect(recurrenceDatesInRange(monthly, "2028-02-01", "2028-03-31")).toEqual([
      "2028-02-29",
      "2028-03-29",
    ]);
  });
});
