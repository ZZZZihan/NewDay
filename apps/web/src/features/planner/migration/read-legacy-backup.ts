export type LegacyBackup = { source: string; exportedAt: string; taskCount: number };

function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let missing = false;
    request.onupgradeneeded = () => {
      // Opening a missing database would create it. Abort that transaction;
      // existing databases open at their current version without any upgrade.
      missing = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      if (missing) resolve(null);
      else reject(request.error ?? new Error("无法读取旧浏览器数据"));
    };
    request.onblocked = () => reject(new Error("旧数据正在被其他页面使用，请关闭旧版页面后重试"));
  });
}

function readTables(database: IDBDatabase): Promise<Record<string, unknown[]>> {
  const names = ["tasks", "recurrenceSeries", "focusRecords", "timeBlocks", "preferences"]
    .filter((name) => database.objectStoreNames.contains(name));
  if (names.length === 0) return Promise.resolve({});
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(names, "readonly");
    const tables: Record<string, unknown[]> = {};
    for (const name of names) {
      const request = transaction.objectStore(name).getAll();
      request.onsuccess = () => { tables[name] = request.result; };
    }
    transaction.oncomplete = () => resolve(tables);
    transaction.onerror = () => reject(transaction.error ?? new Error("无法读取旧浏览器数据"));
    transaction.onabort = () => reject(transaction.error ?? new Error("旧数据读取已中断"));
  });
}

/** Read the old Dexie database without upgrading, modifying, or deleting it. */
export async function readLegacyBackup(databaseName = "newday"): Promise<LegacyBackup | null> {
  if (typeof indexedDB === "undefined") return null;
  if (typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases();
    if (!databases.some(({ name }) => name === databaseName)) return null;
  }

  const database = await openExistingDatabase(databaseName);
  if (!database) return null;
  try {
    const tables = await readTables(database);
    const tasks = tables.tasks ?? [];
    if (tasks.length === 0 && !(tables.recurrenceSeries?.length) && !(tables.focusRecords?.length)) {
      return null;
    }

    // Dexie stores its schema version multiplied by ten in IndexedDB.
    const version = database.version >= 50 ? 4 : database.version >= 40 ? 3 : database.version >= 30 ? 2 : 1;
    const exportedAt = new Date().toISOString();
    const source = JSON.stringify({
      format: "newday-backup",
      version,
      exportedAt,
      tasks,
      recurrenceSeries: tables.recurrenceSeries ?? [],
      focusRecords: tables.focusRecords ?? [],
      ...(version === 1 ? { timeBlocks: tables.timeBlocks ?? [], preferences: tables.preferences ?? [] } : {}),
    });
    return { source, exportedAt, taskCount: tasks.length };
  } finally {
    database.close();
  }
}
