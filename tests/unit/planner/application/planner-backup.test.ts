import { describe, expect, it } from "vitest";

import { MemoryPlannerStore } from "../../../support/memory-planner-store";
import type {
  FocusRecord,
  RecurrenceSeries,
  Task,
} from "@newday/core/domain/planner-model";
import { executePlannerCommand } from "@newday/core/application/planner-command";
import {
  createPlannerBackup,
  parsePlannerBackup,
  restorePlannerBackup,
} from "@newday/core/application/planner-backup";

const DATE = "2026-09-01";
const NOW = "2026-09-01T00:00:00.000Z";

async function seedStore(store: MemoryPlannerStore) {
  await executePlannerCommand(store, {
    type: "createTask",
    input: {
      id: "task-1",
      title: "写周报",
      startDate: DATE,
      endDate: "2026-09-03",
      now: NOW,
    },
  });
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "写周报",
    notes: "",
    startDate: DATE,
    endDate: DATE,
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    completedOn: null,
    ...overrides,
  };
}

function series(overrides: Partial<RecurrenceSeries> = {}): RecurrenceSeries {
  return {
    id: "series-1",
    logicalSeriesId: "series-1",
    title: "每日复盘",
    notes: "",
    startDate: DATE,
    effectiveEndDate: null,
    pattern: { kind: "daily" },
    end: { kind: "never" },
    excludedDates: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function focus(overrides: Partial<FocusRecord> = {}): FocusRecord {
  return {
    id: "focus-1",
    date: DATE,
    taskId: "task-1",
    focusedAt: NOW,
    ...overrides,
  };
}

describe("planner backup", () => {
  it("exports a version 6 archive with tasks, recurrence, focus, life, and sync collections", async () => {
    const store = new MemoryPlannerStore();
    const recurrenceSeries = series();
    const occurrence = task({
      seriesId: recurrenceSeries.id,
      logicalSeriesId: recurrenceSeries.logicalSeriesId,
      occurrenceDate: DATE,
      occurrenceKey: `${recurrenceSeries.id}:${DATE}`,
      isSeriesException: false,
    });
    await store.putRecurrenceSeries(recurrenceSeries);
    await store.putTask(occurrence);
    await store.putFocusRecord(focus());

    const backup = await createPlannerBackup(
      store,
      "2026-09-01T12:00:00.000Z",
    );

    expect(backup).toEqual({
      format: "newday-backup",
      version: 6,
      exportedAt: "2026-09-01T12:00:00.000Z",
      tasks: [occurrence],
      recurrenceSeries: [recurrenceSeries],
      focusRecords: [focus()],
      inboxItems: [],
      folders: [],
      resources: [],
      resourceTaskLinks: [],
      notionSync: { version: 1, connections: [], initializationSteps: [], taskMappings: [], outbox: [], conflicts: [], watermarks: [], restoreQuarantine: [] },
    });
  });

  it("replaces all current collections with a valid archive", async () => {
    const source = new MemoryPlannerStore();
    const recurrenceSeries = series();
    const occurrence = task({
      seriesId: recurrenceSeries.id,
      logicalSeriesId: recurrenceSeries.logicalSeriesId,
      occurrenceDate: DATE,
      occurrenceKey: `${recurrenceSeries.id}:${DATE}`,
      isSeriesException: false,
    });
    await source.putRecurrenceSeries(recurrenceSeries);
    await source.putTask(occurrence);
    await source.putFocusRecord(focus());
    const backup = await createPlannerBackup(source);

    const target = new MemoryPlannerStore();
    await seedStore(target);
    await restorePlannerBackup(target, JSON.stringify(backup));

    expect(await target.listAllTasks()).toEqual([occurrence]);
    expect(await target.listAllRecurrenceSeries()).toEqual([recurrenceSeries]);
    expect(await target.listAllFocusRecords()).toEqual([focus()]);
  });

  it("normalizes version 3 recurrence identity without rewriting occurrences", () => {
    const normalized = parsePlannerBackup(
      JSON.stringify({
        format: "newday-backup",
        version: 3,
        exportedAt: NOW,
        tasks: [
          {
            ...task({ id: "stable-occurrence" }),
            seriesId: "series-1",
            occurrenceDate: DATE,
            occurrenceKey: `series-1:${DATE}`,
            isSeriesException: false,
          },
        ],
        recurrenceSeries: [
          {
            id: "series-1",
            title: "每日复盘",
            notes: "",
            startDate: DATE,
            pattern: { kind: "daily" },
            end: { kind: "never" },
            excludedDates: [],
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        focusRecords: [],
      }),
    );

    expect(normalized.version).toBe(5);
    expect(normalized.recurrenceSeries).toEqual([
      expect.objectContaining({
        id: "series-1",
        logicalSeriesId: "series-1",
        effectiveEndDate: null,
      }),
    ]);
    expect(normalized.tasks).toEqual([
      expect.objectContaining({
        id: "stable-occurrence",
        seriesId: "series-1",
        logicalSeriesId: "series-1",
        occurrenceKey: `series-1:${DATE}`,
      }),
    ]);
  });

  it("round-trips linked recurrence segments and their physical parent", async () => {
    const store = new MemoryPlannerStore();
    const prefix = series({
      id: "series-prefix",
      logicalSeriesId: "logical-series",
      effectiveEndDate: "2026-09-02",
    });
    const tail = series({
      id: "series-tail",
      logicalSeriesId: "logical-series",
      startDate: "2026-09-03",
    });
    const occurrence = task({
      id: "stable-occurrence",
      startDate: "2026-09-03",
      endDate: "2026-09-03",
      seriesId: tail.id,
      logicalSeriesId: tail.logicalSeriesId,
      occurrenceDate: "2026-09-03",
      occurrenceKey: "logical-series:2026-09-03",
      isSeriesException: false,
    });
    await store.putRecurrenceSeries(prefix);
    await store.putRecurrenceSeries(tail);
    await store.putTask(occurrence);

    const parsed = parsePlannerBackup(
      JSON.stringify(await createPlannerBackup(store, NOW)),
    );

    expect(parsed.recurrenceSeries).toEqual([prefix, tail]);
    expect(parsed.tasks).toEqual([occurrence]);
  });

  it("imports version 1 and version 2 archives as one-off v5 data", () => {
    const versionOne = parsePlannerBackup(
      JSON.stringify({
        format: "newday-backup",
        version: 1,
        exportedAt: NOW,
        tasks: [
          {
            id: "legacy-task",
            title: "旧任务",
            notes: "",
            plannedDate: DATE,
            status: "open",
            estimatedMinutes: 60,
            createdAt: NOW,
            updatedAt: NOW,
            completedAt: null,
          },
        ],
        timeBlocks: [],
      }),
    );
    const versionTwo = parsePlannerBackup(
      JSON.stringify({
        format: "newday-backup",
        version: 2,
        exportedAt: NOW,
        tasks: [task({ completedOn: undefined })],
      }),
    );

    for (const backup of [versionOne, versionTwo]) {
      expect(backup.version).toBe(5);
      expect(backup.tasks[0]).toEqual(
        expect.objectContaining({
          startDate: DATE,
          endDate: DATE,
          completedOn: null,
        }),
      );
      expect(backup.recurrenceSeries).toEqual([]);
      expect(backup.focusRecords).toEqual([]);
    }
  });

  it("rejects invalid or duplicate data before replacing current data", async () => {
    const store = new MemoryPlannerStore();
    await seedStore(store);
    const base = {
      format: "newday-backup",
      version: 4,
      exportedAt: NOW,
      recurrenceSeries: [],
      focusRecords: [],
    } as const;
    const malformedArchives = [
      {
        ...base,
        tasks: [
          task({
            id: "broken",
            startDate: "2026-09-03",
            endDate: DATE,
          }),
        ],
      },
      { ...base, tasks: [task(), task()] },
      {
        ...base,
        tasks: [
          task({
            seriesId: "missing-series",
            logicalSeriesId: "missing-series",
            occurrenceDate: DATE,
            occurrenceKey: `missing-series:${DATE}`,
            isSeriesException: false,
          }),
        ],
      },
      {
        ...base,
        tasks: [
          task({
            seriesId: "series-1",
            logicalSeriesId: "other-logical-series",
            occurrenceDate: DATE,
            occurrenceKey: `other-logical-series:${DATE}`,
            isSeriesException: false,
          }),
        ],
        recurrenceSeries: [series()],
      },
      {
        ...base,
        tasks: [
          task({
            id: "outside-rule",
            startDate: "2026-09-03",
            endDate: "2026-09-03",
            seriesId: "series-1",
            logicalSeriesId: "series-1",
            occurrenceDate: "2026-09-03",
            occurrenceKey: "series-1:2026-09-03",
            isSeriesException: false,
          }),
        ],
        recurrenceSeries: [
          series({ end: { kind: "onDate", date: "2026-09-02" } }),
        ],
      },
      {
        ...base,
        tasks: [],
        recurrenceSeries: [
          series({
            id: "series-prefix",
            logicalSeriesId: "logical-series",
            effectiveEndDate: "2026-09-01",
          }),
          series({
            id: "series-tail",
            logicalSeriesId: "logical-series",
            startDate: "2026-09-03",
          }),
        ],
      },
      {
        ...base,
        tasks: [],
        recurrenceSeries: [
          series({
            effectiveEndDate: "2026-09-10",
            end: { kind: "onDate", date: "2026-09-03" },
          }),
          series({
            id: "series-tail",
            logicalSeriesId: "series-1",
            startDate: "2026-09-11",
          }),
        ],
      },
      {
        ...base,
        tasks: [task()],
        focusRecords: [focus(), focus({ id: "focus-2" })],
      },
    ];

    for (const archive of malformedArchives) {
      await expect(
        restorePlannerBackup(store, JSON.stringify(archive)),
      ).rejects.toThrow();
      expect((await store.listAllTasks()).map((value) => value.id)).toEqual([
        "task-1",
      ]);
    }
  });

  it("rejects missing focus references and more than three daily focus records", () => {
    const focusedTasks = [1, 2, 3, 4].map((index) =>
      task({ id: `task-${index}` }),
    );
    const base = {
      format: "newday-backup",
      version: 4,
      exportedAt: NOW,
      tasks: focusedTasks,
      recurrenceSeries: [],
    } as const;

    expect(() =>
      parsePlannerBackup(
        JSON.stringify({
          ...base,
          focusRecords: [focus({ taskId: "missing" })],
        }),
      ),
    ).toThrow("不存在的任务");

    expect(() =>
      parsePlannerBackup(
        JSON.stringify({
          ...base,
          focusRecords: focusedTasks.map((value, index) =>
            focus({ id: `focus-${index}`, taskId: value.id }),
          ),
        }),
      ),
    ).toThrow("不能超过 3 项");
  });

  it("rejects invalid JSON and unsupported versions", async () => {
    const store = new MemoryPlannerStore();
    await seedStore(store);

    await expect(restorePlannerBackup(store, "not-json")).rejects.toThrow(
      "无法解析备份文件",
    );
    expect(() =>
      parsePlannerBackup(
        JSON.stringify({ format: "newday-backup", version: 99 }),
      ),
    ).toThrow("备份版本不受支持");
    expect(await store.listAllTasks()).toHaveLength(1);
  });
});
