import { useEffect, useState } from "react";

import { plannerApi } from "../api/planner-api";
import { downloadBackupSource } from "../lib/backup-download";
import { readLegacyBackup, type LegacyBackup } from "./read-legacy-backup";
import { clearLegacyDatabase } from "./clear-legacy-database";

const MIGRATION_KEY = "newday:server-migration:v1";

type MigrationState = {
  status: "checking" | "ready" | "imported" | "conflict" | "failed" | "cleared";
  message?: string;
  legacy?: LegacyBackup;
};

let migrationAttempt: Promise<MigrationState> | undefined;

function wasMigrated() {
  try { return localStorage.getItem(MIGRATION_KEY) === "complete"; }
  catch { return false; }
}

async function migrateLegacy(): Promise<MigrationState> {
  const migrated = wasMigrated();
  let legacy: LegacyBackup | null = null;
  try {
    legacy = await readLegacyBackup();
    if (!legacy) return { status: "ready" };
    if (migrated) {
      return { status: "imported", legacy, message: "本浏览器仍保留已迁移的旧任务。可下载备份后清除旧浏览器数据。" };
    }
    const result = await plannerApi.migrate(legacy.source);
    if (result.status === "server-not-empty") {
      return {
        status: "conflict",
        legacy,
        message: `检测到本浏览器的 ${legacy.taskCount} 项旧任务，但服务端已有数据。旧数据仍完整保留在浏览器中；可下载旧备份，再通过“导入备份”决定是否替换服务端数据。`,
      };
    }
    try { localStorage.setItem(MIGRATION_KEY, "complete"); } catch { /* Server migration is also idempotent. */ }
    return {
      status: "imported",
      legacy,
      message: "旧浏览器任务已迁移到服务端，浏览器中的原始数据仍然保留。",
    };
  } catch (error) {
    return {
      status: "failed",
      legacy: legacy ?? undefined,
      message: `${error instanceof Error ? error.message : "旧浏览器数据迁移失败"}。原始数据未被修改，可重试迁移。`,
    };
  }
}

export function useLegacyMigration(hydrated: boolean) {
  const [state, setState] = useState<MigrationState>({ status: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [downloaded, setDownloaded] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    // Shared in-flight work prevents StrictMode remounts from issuing imports
    // twice. The backend additionally handles imports from multiple tabs.
    migrationAttempt ??= migrateLegacy();
    void migrationAttempt.then((result) => { if (active) setState(result); });
    return () => { active = false; };
  }, [attempt, hydrated]);

  return {
    ...state,
    downloaded,
    clearing,
    checking: state.status === "checking",
    retry() {
      if (clearing || state.status === "cleared") return;
      setDownloaded(false);
      migrationAttempt = undefined;
      setState({ status: "checking", legacy: state.legacy });
      setAttempt((value) => value + 1);
    },
    download() {
      if (state.legacy) {
        downloadBackupSource(state.legacy.source, state.legacy.exportedAt, "newday-browser-backup");
        setDownloaded(true);
      }
    },
    async clear() {
      if (!state.legacy || !downloaded || clearing || state.status === "cleared") return;
      if (!window.confirm("仅清除此浏览器中的旧 NewDay 数据，服务端任务不会被修改。请确认旧备份已保存，继续吗？")) return;
      setClearing(true);
      try {
        await clearLegacyDatabase(() => {
          setState((current) => ({ ...current, message: "清除操作正在等待：请关闭仍在使用旧 NewDay 的其他页面，关闭后会继续清除。已下载的备份和服务端任务不受影响。" }));
        });
        try { localStorage.setItem(MIGRATION_KEY, "complete"); } catch { /* The old database is now absent. */ }
        const cleared: MigrationState = {
          status: "cleared",
          legacy: state.legacy,
          message: "旧浏览器数据已清除。服务端任务未修改，仍可下载本次保存的旧备份。",
        };
        migrationAttempt = Promise.resolve(cleared);
        setState(cleared);
      } catch (error) {
        setState((current) => ({ ...current, message: error instanceof Error ? error.message : "清除失败，请重试。旧备份仍然保留。" }));
      } finally {
        setClearing(false);
      }
    },
  };
}
