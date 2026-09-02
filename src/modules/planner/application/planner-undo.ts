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
  clearUndoReceipts(store);

  if (
    changes.tasks.size === 0 &&
    changes.recurrenceSeries.size === 0 &&
    changes.focusRecords.size === 0
  ) {
    return undefined;
  }

  const stored = {
    token: crypto.randomUUID(),
    changes: cloneChangeSet(changes),
  };
  latestUndoByStore.set(store, stored);

  return { token: stored.token } as unknown as UndoReceipt;
}

export async function undoPlannerCommand(
  store: PlannerStore,
  receipt: UndoReceipt,
): Promise<void> {
  const stored = latestUndoByStore.get(store);
  const token = (receipt as unknown as { token?: string }).token;

  if (!stored || stored.token !== token) {
    throw new Error("撤销操作已失效");
  }

  await store.transaction(async () => {
    await restoreRecurrenceSeries(store, stored.changes.recurrenceSeries);
    await restoreTasks(store, stored.changes.tasks);
    await restoreFocusRecords(store, stored.changes.focusRecords);
  });

  latestUndoByStore.delete(store);
}

export function clearUndoReceipts(store: PlannerStore) {
  latestUndoByStore.delete(store);
}

async function restoreTasks(
  store: PlannerStore,
  snapshots: ReadonlyMap<string, Task | undefined>,
) {
  for (const [id, task] of snapshots) {
    if (task === undefined) {
      await store.deleteTask(id);
    } else {
      await store.putTask(structuredClone(task));
    }
  }
}

async function restoreRecurrenceSeries(
  store: PlannerStore,
  snapshots: ReadonlyMap<string, RecurrenceSeries | undefined>,
) {
  for (const [id, series] of snapshots) {
    if (series === undefined) {
      await store.deleteRecurrenceSeries(id);
    } else {
      await store.putRecurrenceSeries(structuredClone(series));
    }
  }
}

async function restoreFocusRecords(
  store: PlannerStore,
  snapshots: ReadonlyMap<string, FocusRecord | undefined>,
) {
  for (const [id, record] of snapshots) {
    if (record === undefined) {
      await store.deleteFocusRecord(id);
    } else {
      await store.putFocusRecord(structuredClone(record));
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
