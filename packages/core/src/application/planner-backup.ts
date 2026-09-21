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
    const [tasks, recurrenceSeries, focusRecords, inboxItems, folders, resources, resourceTaskLinks] = await Promise.all([
      store.listAllTasks(),
      store.listAllRecurrenceSeries(),
      store.listAllFocusRecords(),
      store.listAllInboxItems?.() ?? [],
      store.listAllFolders?.() ?? [],
      store.listAllResources?.() ?? [],
      store.listAllResourceTaskLinks?.() ?? [],
    ]);

    return parseAndValidateCurrentBackup({
      format: "newday-backup",
      version: 5,
      exportedAt,
      tasks,
      recurrenceSeries,
      focusRecords,
      inboxItems,
      folders,
      resources,
      resourceTaskLinks,
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
      inboxItems: backup.inboxItems,
      folders: backup.folders,
      resources: backup.resources,
      resourceTaskLinks: backup.resourceTaskLinks,
    });
    clearUndoReceipts(store);
  });
  return backup;
}
