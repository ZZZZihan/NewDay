import {
  parseAndValidateCurrentBackup,
  parsePlannerBackup,
  type PlannerBackup,
} from "../contracts/planner-backup";
import type { PlannerArchiveStore } from "./planner-archive-store";
import { clearUndoReceipts } from "./planner-undo";

export { parsePlannerBackup, plannerBackupSchema, type PlannerBackup } from "../contracts/planner-backup";

export async function createPlannerBackup(
  store: PlannerArchiveStore,
  exportedAt = new Date().toISOString(),
): Promise<PlannerBackup> {
  return store.transaction(async () => {
    const [tasks, recurrenceSeries, focusRecords] = await Promise.all([
      store.listAllTasks(),
      store.listAllRecurrenceSeries(),
      store.listAllFocusRecords(),
    ]);

    return parseAndValidateCurrentBackup({
      format: "newday-backup",
      version: 4,
      exportedAt,
      tasks,
      recurrenceSeries,
      focusRecords,
    });
  });
}

export async function restorePlannerBackup(
  store: PlannerArchiveStore,
  source: string,
): Promise<PlannerBackup> {
  const backup = parsePlannerBackup(source);
  await store.transaction(async () => {
    await store.replaceAllData({
      tasks: backup.tasks,
      recurrenceSeries: backup.recurrenceSeries,
      focusRecords: backup.focusRecords,
    });
    clearUndoReceipts(store);
  });
  return backup;
}
