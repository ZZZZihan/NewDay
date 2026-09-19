import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { clearLegacyDatabase } from "./clear-legacy-database";
import { readLegacyBackup } from "./read-legacy-backup";

function open(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 20);
    request.onupgradeneeded = () => request.result.createObjectStore("tasks", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("old browser database cleanup", () => {
  it("deletes only newday and leaves the downloaded source available in memory", async () => {
    const original = await open("newday");
    const unrelatedName = `other-app-${crypto.randomUUID()}`;
    const unrelated = await open(unrelatedName);
    await new Promise<void>((resolve) => {
      const transaction = original.transaction("tasks", "readwrite");
      transaction.objectStore("tasks").put({ id: "test-task", title: "备份留存内容" });
      transaction.oncomplete = () => resolve();
    });
    const snapshot = await readLegacyBackup();
    original.close();
    try {
      await clearLegacyDatabase();
      const names = (await indexedDB.databases()).map(({ name }) => name);
      expect(names).not.toContain("newday");
      expect(names).toContain(unrelatedName);
      expect(snapshot?.source).toContain("备份留存内容");
      expect(await readLegacyBackup()).toBeNull();
    } finally {
      unrelated.close();
      indexedDB.deleteDatabase(unrelatedName);
    }
  });

  it("reports a blocked deletion and completes after the old connection closes", async () => {
    const original = await open("newday");
    let blocked = false;
    await clearLegacyDatabase(() => {
      blocked = true;
      original.close();
    });
    expect(blocked).toBe(true);
    expect((await indexedDB.databases()).some(({ name }) => name === "newday")).toBe(false);
  });
});
