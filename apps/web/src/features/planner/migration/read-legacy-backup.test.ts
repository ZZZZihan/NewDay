import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { parsePlannerBackup } from "@newday/core/contracts/planner-backup";
import { readLegacyBackup } from "./read-legacy-backup";

function createLegacyDatabase(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 20);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("tasks", { keyPath: "id" });
      request.result.createObjectStore("preferences", { keyPath: "id" });
      request.result.createObjectStore("timeBlocks", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("legacy browser backup reader", () => {
  it("does not create a database when no old data exists", async () => {
    const name = `missing-${crypto.randomUUID()}`;
    expect(await readLegacyBackup(name)).toBeNull();
    expect((await indexedDB.databases()).some((database) => database.name === name)).toBe(false);
  });

  it("exports old records without upgrading or changing their original schema", async () => {
    const name = `legacy-${crypto.randomUUID()}`;
    const database = await createLegacyDatabase(name);
    const task = {
      id: "old-task",
      title: "原始浏览器任务",
      notes: "保留备注",
      plannedDate: "2026-09-08",
      status: "open",
      estimatedMinutes: 45,
      createdAt: "2026-09-08T01:00:00.000Z",
      updatedAt: "2026-09-08T01:00:00.000Z",
      completedAt: null,
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("tasks", "readwrite");
      transaction.objectStore("tasks").put(task);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });

    try {
      const backup = await readLegacyBackup(name);
      expect(backup?.taskCount).toBe(1);
      expect(JSON.parse(backup!.source).tasks).toEqual([task]);
      expect(parsePlannerBackup(backup!.source).tasks[0]).toMatchObject({
        id: "old-task", startDate: "2026-09-08", endDate: "2026-09-08", notes: "保留备注",
      });
      expect(database.version).toBe(20);
      expect([...database.objectStoreNames]).toEqual(["preferences", "tasks", "timeBlocks"]);
      const original = await new Promise((resolve) => {
        database.transaction("tasks", "readonly").objectStore("tasks").get("old-task").onsuccess = (event) => {
          resolve((event.target as IDBRequest).result);
        };
      });
      expect(original).toEqual(task);
    } finally {
      database.close();
      indexedDB.deleteDatabase(name);
    }
  });

  it("preserves an invalid source for download and server-side validation", async () => {
    const name = `invalid-${crypto.randomUUID()}`;
    const database = await createLegacyDatabase(name);
    await new Promise<void>((resolve) => {
      const transaction = database.transaction("tasks", "readwrite");
      transaction.objectStore("tasks").put({ id: "broken", title: "还可导出的原始记录" });
      transaction.oncomplete = () => resolve();
    });
    database.close();
    const backup = await readLegacyBackup(name);
    expect(backup?.source).toContain("还可导出的原始记录");
    expect(() => parsePlannerBackup(backup!.source)).toThrow();
    indexedDB.deleteDatabase(name);
  });
});
