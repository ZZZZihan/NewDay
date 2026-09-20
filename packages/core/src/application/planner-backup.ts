import {
  parseAndValidateCurrentBackup,
  parsePlannerBackup,
  type PlannerBackup,
} from "../contracts/planner-backup";
import type { PlannerArchiveStore } from "./planner-archive-store";
import { clearUndoReceipts } from "./planner-undo";
import { emptyNotionSyncArchive } from "../contracts/notion-sync";

export { parsePlannerBackup, plannerBackupSchema, type PlannerBackup } from "../contracts/planner-backup";

export async function createPlannerBackup(
  store: PlannerArchiveStore,
  exportedAt = new Date().toISOString(),
): Promise<PlannerBackup> {
  return store.transaction(async () => {
    const [tasks, recurrenceSeries, focusRecords, inboxItems, folders, resources, resourceTaskLinks, notionSync] = await Promise.all([
      store.listAllTasks(),
      store.listAllRecurrenceSeries(),
      store.listAllFocusRecords(),
      store.listAllInboxItems?.() ?? [],
      store.listAllFolders?.() ?? [],
      store.listAllResources?.() ?? [],
      store.listAllResourceTaskLinks?.() ?? [],
      store.listNotionSyncData?.() ?? emptyNotionSyncArchive(),
    ]);

    return parseAndValidateCurrentBackup({
      format: "newday-backup",
      version: 6,
      exportedAt,
      tasks,
      recurrenceSeries,
      focusRecords,
      inboxItems,
      folders,
      resources,
      resourceTaskLinks,
      notionSync,
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
      notionSync: backup.version === 6 ? backup.notionSync : emptyNotionSyncArchive(),
    });
    clearUndoReceipts(store);
  });
  return backup;
}
