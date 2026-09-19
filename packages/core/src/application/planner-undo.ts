import type {
  FocusRecord,
  RecurrenceSeries,
  Task,
} from "../domain/planner-model";
import type { PlannerStore } from "./planner-store";

declare const undoReceiptBrand: unique symbol;

export type UndoReceipt = {
  readonly [undoReceiptBrand]: "UndoReceipt";
};

export type UndoChangeSet = {
  tasks: Map<string, Task | undefined>;
  recurrenceSeries: Map<string, RecurrenceSeries | undefined>;
  focusRecords: Map<string, FocusRecord | undefined>;
};

type StoredUndo = {
  token: string;
  changes: UndoChangeSet;
};

const latestUndoByStore = new WeakMap<PlannerStore, StoredUndo>();

export function createUndoChangeSet(): UndoChangeSet {
  return {
    tasks: new Map(),
    recurrenceSeries: new Map(),
    focusRecords: new Map(),
  };
}

export function publishUndoReceipt(
  store: PlannerStore,
  changes: UndoChangeSet,
): UndoReceipt | undefined {
  if (
    changes.tasks.size === 0 &&
    changes.recurrenceSeries.size === 0 &&
    changes.focusRecords.size === 0
  ) {
    clearUndoReceipts(store);
    return undefined;
  }

  const stored = {
    token: crypto.randomUUID(),
    changes: cloneChangeSet(changes),
  };
  afterCommit(store, () => latestUndoByStore.set(store, stored));

  return { token: stored.token } as unknown as UndoReceipt;
}

export async function undoPlannerCommand(
  store: PlannerStore,
  receipt: UndoReceipt,
): Promise<void> {
  const token = (receipt as unknown as { token?: string }).token;

  await store.transaction(async () => {
    const stored = latestUndoByStore.get(store);
    if (!stored || stored.token !== token) {
      throw new Error("撤销操作已失效");
    }

    await deleteCreatedFocusRecords(store, stored.changes.focusRecords);
    await deleteUntrackedTasksForCreatedSeries(
      store,
      stored.changes.recurrenceSeries,
      stored.changes.tasks,
    );
    await deleteCreatedTasks(store, stored.changes.tasks);
    await deleteCreatedRecurrenceSeries(store, stored.changes.recurrenceSeries);
    await restoreRecurrenceSeries(store, stored.changes.recurrenceSeries);
    await restoreTasks(store, stored.changes.tasks);
    await restoreFocusRecords(store, stored.changes.focusRecords);
    afterCommit(store, () => {
      if (latestUndoByStore.get(store) === stored) {
        latestUndoByStore.delete(store);
      }
    });
  });
}

export function clearUndoReceipts(store: PlannerStore) {
  afterCommit(store, () => latestUndoByStore.delete(store));
}

function afterCommit(store: PlannerStore, callback: () => void) {
  if (store.afterCommit) store.afterCommit(callback);
  else callback();
}

async function restoreTasks(
  store: PlannerStore,
  snapshots: ReadonlyMap<string, Task | undefined>,
) {
  for (const task of snapshots.values()) {
    if (task !== undefined) {
      await store.putTask(structuredClone(task));
    }
  }
}

async function restoreRecurrenceSeries(
  store: PlannerStore,
  snapshots: ReadonlyMap<string, RecurrenceSeries | undefined>,
) {
  for (const series of snapshots.values()) {
    if (series !== undefined) {
      await store.putRecurrenceSeries(structuredClone(series));
    }
  }
}

async function restoreFocusRecords(
  store: PlannerStore,
  snapshots: ReadonlyMap<string, FocusRecord | undefined>,
) {
  for (const record of snapshots.values()) {
    if (record !== undefined) {
      await store.putFocusRecord(structuredClone(record));
    }
  }
}

async function deleteUntrackedTasksForCreatedSeries(
  store: PlannerStore,
  seriesSnapshots: ReadonlyMap<string, RecurrenceSeries | undefined>,
  taskSnapshots: ReadonlyMap<string, Task | undefined>,
) {
  for (const [seriesId, series] of seriesSnapshots) {
    if (series !== undefined) continue;

    const tasks = await store.listTasksBySeries(seriesId);
    for (const task of tasks) {
      if (taskSnapshots.has(task.id)) continue;
      if (task.status !== "open" || task.isSeriesException !== false) {
        throw new Error("重复系列在撤销前已发生变化");
      }

      for (const record of await store.listFocusRecordsForTask(task.id)) {
        await store.deleteFocusRecord(record.id);
      }
      await store.deleteTask(task.id);
    }
  }
}

async function deleteCreatedTasks(
  store: PlannerStore,
  snapshots: ReadonlyMap<string, Task | undefined>,
) {
  for (const [id, task] of snapshots) {
    if (task === undefined) {
      await store.deleteTask(id);
    }
  }
}

async function deleteCreatedRecurrenceSeries(
  store: PlannerStore,
  snapshots: ReadonlyMap<string, RecurrenceSeries | undefined>,
) {
  for (const [id, series] of snapshots) {
    if (series === undefined) {
      await store.deleteRecurrenceSeries(id);
    }
  }
}

async function deleteCreatedFocusRecords(
  store: PlannerStore,
  snapshots: ReadonlyMap<string, FocusRecord | undefined>,
) {
  for (const [id, record] of snapshots) {
    if (record === undefined) {
      await store.deleteFocusRecord(id);
    }
  }
}

function cloneChangeSet(changes: UndoChangeSet): UndoChangeSet {
  return {
    tasks: cloneSnapshots(changes.tasks),
    recurrenceSeries: cloneSnapshots(changes.recurrenceSeries),
    focusRecords: cloneSnapshots(changes.focusRecords),
  };
}

function cloneSnapshots<T>(snapshots: ReadonlyMap<string, T | undefined>) {
  return new Map(
    [...snapshots].map(([id, value]) => [
      id,
      value === undefined ? undefined : structuredClone(value),
    ]),
  );
}
