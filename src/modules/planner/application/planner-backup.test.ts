import { describe, expect, it } from "vitest";

import { MemoryPlannerStore } from "../adapters/memory-planner-store";
import { executePlannerCommand } from "./planner-command";
import {
  createPlannerBackup,
  restorePlannerBackup,
} from "./planner-backup";

const DATE = "2026-09-01";

async function seedStore(store: MemoryPlannerStore) {
  await executePlannerCommand(store, {
    type: "createTask",
    input: {
      id: "task-1",
      title: "写周报",
      plannedDate: DATE,
      estimatedMinutes: 60,
      now: "2026-09-01T00:00:00.000Z",
    },
  });
  await executePlannerCommand(store, {
    type: "scheduleTask",
    input: {
      id: "block-1",
      taskId: "task-1",
      start: "2026-09-01T09:00:00.000Z",
      end: "2026-09-01T10:00:00.000Z",
      now: "2026-09-01T00:05:00.000Z",
    },
  });
}

describe("planner backup", () => {
  it("exports a versioned, validated archive", async () => {
    const store = new MemoryPlannerStore();
    await seedStore(store);

    const backup = await createPlannerBackup(
      store,
      "2026-09-01T12:00:00.000Z",
    );

    expect(backup).toEqual(
      expect.objectContaining({
        format: "newday-backup",
        version: 1,
        exportedAt: "2026-09-01T12:00:00.000Z",
        preferences: expect.objectContaining({
          slotMinutes: 15,
          defaultBlockMinutes: 30,
        }),
      }),
    );
    expect(backup.tasks).toHaveLength(1);
    expect(backup.timeBlocks).toHaveLength(1);
  });

  it("replaces current data with a valid archive", async () => {
    const source = new MemoryPlannerStore();
    await seedStore(source);
    const backup = await createPlannerBackup(
      source,
      "2026-09-01T12:00:00.000Z",
    );

    const target = new MemoryPlannerStore();
    await executePlannerCommand(target, {
      type: "createTask",
      input: {
        id: "old-task",
        title: "旧数据",
        plannedDate: DATE,
        now: "2026-09-01T00:00:00.000Z",
      },
    });

    await restorePlannerBackup(target, JSON.stringify(backup));

    const day = await target.getDayPlan(DATE);
    expect(day.tasks.map((task) => task.id)).toEqual(["task-1"]);
    expect(day.timeBlocks.map((block) => block.id)).toEqual(["block-1"]);
  });

  it("rejects orphaned time blocks without changing current data", async () => {
    const store = new MemoryPlannerStore();
    await seedStore(store);
    const malformed = {
      format: "newday-backup",
      version: 1,
      exportedAt: "2026-09-01T12:00:00.000Z",
      preferences: {
        id: "default",
        timeZone: "Asia/Shanghai",
        dayStartMinute: 420,
        dayEndMinute: 1380,
        slotMinutes: 15,
        defaultBlockMinutes: 30,
      },
      tasks: [],
      timeBlocks: [
        {
          id: "orphan",
          taskId: "missing",
          date: DATE,
          start: "2026-09-01T09:00:00.000Z",
          end: "2026-09-01T10:00:00.000Z",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };

    await expect(
      restorePlannerBackup(store, JSON.stringify(malformed)),
    ).rejects.toThrow("时间块引用了不存在的任务");

    expect((await store.getDayPlan(DATE)).tasks).toHaveLength(1);
    expect((await store.getDayPlan(DATE)).timeBlocks).toHaveLength(1);
  });

  it("rejects impossible calendar dates without changing current data", async () => {
    const store = new MemoryPlannerStore();
    await seedStore(store);
    const backup = await createPlannerBackup(
      store,
      "2026-09-01T12:00:00.000Z",
    );
    const malformed = {
      ...backup,
      tasks: backup.tasks.map((task) => ({
        ...task,
        plannedDate: "2026-02-31",
      })),
      timeBlocks: [],
    };

    await expect(
      restorePlannerBackup(store, JSON.stringify(malformed)),
    ).rejects.toThrow("日期不是有效的日历日期");

    expect((await store.getDayPlan(DATE)).tasks).toHaveLength(1);
  });

  it("rejects invalid JSON without changing current data", async () => {
    const store = new MemoryPlannerStore();
    await seedStore(store);

    await expect(restorePlannerBackup(store, "not-json")).rejects.toThrow(
      "无法解析备份文件",
    );

    expect((await store.getDayPlan(DATE)).tasks).toHaveLength(1);
  });
});
