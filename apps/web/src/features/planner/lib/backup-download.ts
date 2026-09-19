import type { PlannerBackup } from "@newday/core/contracts/planner-backup";

export function downloadBackupSource(source: string, exportedAt: string, prefix = "newday-backup") {
  const blob = new Blob([`${source}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${prefix}-${exportedAt.replaceAll(":", "-")}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadBackup(backup: PlannerBackup, prefix?: string) {
  downloadBackupSource(JSON.stringify(backup, null, 2), backup.exportedAt, prefix);
}
