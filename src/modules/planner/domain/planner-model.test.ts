import { describe, expect, it } from "vitest";

import {
  focusRecordSchema,
  localDateSchema,
  recurrenceSeriesSchema,
  taskSchema,
} from "./planner-model";

const OPEN_TASK = {
  id: "task-1",
  title: "写周报",
  notes: "",
  startDate: "2026-09-01",
  endDate: "2026-09-02",
  status: "open" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  completedAt: null,
};

const SERIES = {
  id: "series-1",
  title: "每日复盘",
  notes: "",
  startDate: "2026-09-01",
  pattern: { kind: "daily" as const },
  end: { kind: "never" as const },
  excludedDates: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("localDateSchema", () => {
  it("accepts real calendar dates including leap days", () => {
    expect(localDateSchema.parse("2028-02-29")).toBe("2028-02-29");
  });

  it.each(["2026-02-29", "2026-02-31", "2026-13-01", "2026-00-10"])(
    "rejects the invalid calendar date %s",
    (date) => {
      expect(localDateSchema.safeParse(date).success).toBe(false);
    },
  );
});

describe("taskSchema", () => {
  it("keeps current creation paths compatible and defaults completedOn", () => {
    expect(taskSchema.parse(OPEN_TASK)).toEqual({
      ...OPEN_TASK,
      completedOn: null,
    });
  });

  it("accepts an inclusive start and end date", () => {
    expect(taskSchema.parse({ ...OPEN_TASK, endDate: OPEN_TASK.startDate })).toEqual({
      ...OPEN_TASK,
      endDate: OPEN_TASK.startDate,
      completedOn: null,
    });
  });

  it("rejects an end date before the start date", () => {
    const result = taskSchema.safeParse({
      ...OPEN_TASK,
      startDate: "2026-09-02",
      endDate: "2026-09-01",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("截止日期不能早于开始日期");
  });

  it("enforces open and completed metadata while allowing legacy completedOn null", () => {
    expect(
      taskSchema.safeParse({
        ...OPEN_TASK,
        completedAt: "2026-09-01T08:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      taskSchema.safeParse({
        ...OPEN_TASK,
        completedOn: "2026-09-01",
      }).success,
    ).toBe(false);
    expect(
      taskSchema.safeParse({
        ...OPEN_TASK,
        status: "completed",
        completedAt: null,
      }).success,
    ).toBe(false);
    expect(
      taskSchema.parse({
        ...OPEN_TASK,
        status: "completed",
        completedAt: "2026-09-01T08:00:00.000Z",
      }).completedOn,
    ).toBeNull();
  });

  it("requires the recurrence metadata tuple to be all present or all absent", () => {
    const recurrenceMetadata = {
      seriesId: "series-1",
      occurrenceDate: "2026-09-01",
      occurrenceKey: "series-1:2026-09-01",
      isSeriesException: false,
    };

    expect(
      taskSchema.safeParse({
        ...OPEN_TASK,
        startDate: "2026-09-01",
        endDate: "2026-09-01",
        ...recurrenceMetadata,
      }).success,
    ).toBe(true);

    for (const field of Object.keys(recurrenceMetadata)) {
      const incompleteMetadata = { ...recurrenceMetadata };
      delete incompleteMetadata[field as keyof typeof incompleteMetadata];

      expect(
        taskSchema.safeParse({
          ...OPEN_TASK,
          startDate: "2026-09-01",
          endDate: "2026-09-01",
          ...incompleteMetadata,
        }).success,
      ).toBe(false);
    }

    expect(
      taskSchema.safeParse({
        ...OPEN_TASK,
        startDate: "2026-09-01",
        endDate: "2026-09-01",
        ...recurrenceMetadata,
        occurrenceKey: "wrong-key",
      }).success,
    ).toBe(false);
  });

  it("requires recurring instances to remain single-day and marks moved dates as exceptions", () => {
    const recurrenceMetadata = {
      seriesId: "series-1",
      occurrenceDate: "2026-09-01",
      occurrenceKey: "series-1:2026-09-01",
    };

    expect(
      taskSchema.safeParse({
        ...OPEN_TASK,
        ...recurrenceMetadata,
        isSeriesException: false,
      }).success,
    ).toBe(false);
    expect(
      taskSchema.safeParse({
        ...OPEN_TASK,
        startDate: "2026-09-02",
        endDate: "2026-09-02",
        ...recurrenceMetadata,
        isSeriesException: false,
      }).success,
    ).toBe(false);
    expect(
      taskSchema.safeParse({
        ...OPEN_TASK,
        startDate: "2026-09-02",
        endDate: "2026-09-02",
        ...recurrenceMetadata,
        isSeriesException: true,
      }).success,
    ).toBe(true);
  });
});

describe("recurrenceSeriesSchema", () => {
  it("accepts the supported recurrence patterns and inclusive ending", () => {
    for (const pattern of [
      { kind: "daily" },
      { kind: "weekdays" },
      { kind: "weekly", weekdays: [1, 3, 5] },
      { kind: "monthly", dayOfMonth: 31 },
    ]) {
      expect(
        recurrenceSeriesSchema.safeParse({
          ...SERIES,
          pattern,
          end: { kind: "onDate", date: SERIES.startDate },
        }).success,
      ).toBe(true);
    }
  });

  it("rejects invalid weekly weekdays", () => {
    for (const weekdays of [[], [0], [8], [1, 1], [5, 2]]) {
      expect(
        recurrenceSeriesSchema.safeParse({
          ...SERIES,
          pattern: { kind: "weekly", weekdays },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects an ending date before the series starts", () => {
    expect(
      recurrenceSeriesSchema.safeParse({
        ...SERIES,
        end: { kind: "onDate", date: "2026-08-31" },
      }).success,
    ).toBe(false);
  });
});

describe("focusRecordSchema", () => {
  it("accepts a date-scoped task focus record", () => {
    expect(
      focusRecordSchema.parse({
        id: "focus-1",
        date: "2026-09-01",
        taskId: "task-1",
        focusedAt: "2026-09-01T08:00:00.000Z",
      }),
    ).toEqual({
      id: "focus-1",
      date: "2026-09-01",
      taskId: "task-1",
      focusedAt: "2026-09-01T08:00:00.000Z",
    });
  });
});
