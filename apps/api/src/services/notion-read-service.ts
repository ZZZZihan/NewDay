import { randomUUID } from "node:crypto";

import { AGENT_NAMESPACES, dateInTimeZone, type AgentPreferences } from "@newday/core/contracts/agent-planning";
import {
  notionClientKey, notionTaskFieldsSchema,
  type NotionConnection, type NotionReadNode, type NotionReadTaskContext,
  type NotionScanWatermark, type NotionTaskMapping,
} from "@newday/core/contracts/notion-sync";
import { taskSchema, type Task } from "@newday/core/domain/planner-model";
import { clearUndoReceipts } from "@newday/core/application/planner-undo";

import { ApiError } from "../http/api-error.js";
import type { NotionCredentialVault } from "../storage/notion-credential-vault.js";
import type { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";
import { NotionReadFailure, type AreaRow, type NotionReadGateway, type ProjectRow, type ReadRow, type ReadTable, type TaskRow } from "./notion-read-gateway.js";

const tables: ReadTable[] = ["areas", "projects", "tasks"];
type ReadStatus = {
  workspaceId: string; connectionStatus: NotionConnection["status"] | "not_initialized";
  sources: Array<{ table: ReadTable; dataSourceId: string | null; watermark: NotionScanWatermark | null }>;
};

/** A full read is intentionally restarted after an interrupted query. Cursors
 * never become durable state; only an applied table gets a success watermark. */
export class NotionReadService {
  private readonly tails = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly store: SQLitePlannerStore, private readonly vault: NotionCredentialVault,
    private readonly gateway: NotionReadGateway, private readonly clock: () => number = Date.now) {}

  async status(workspaceId: string): Promise<ReadStatus> {
    const connection = await this.store.getNotionConnection(workspaceId);
    const watermarks = await this.store.listNotionScanWatermarks();
    return { workspaceId, connectionStatus: connection?.status ?? "not_initialized",
      sources: tables.map((table) => {
        const dataSourceId = connection?.dataSources[table]?.dataSourceId ?? null;
        return { table, dataSourceId, watermark: dataSourceId
          ? watermarks.find((item) => item.workspaceId === workspaceId && item.dataSourceId === dataSourceId) ?? null : null };
      }) };
  }

  scan(workspaceId: string): Promise<ReadStatus> {
    return this.withLock(workspaceId, async () => {
      await this.scanLocked(workspaceId);
      return this.status(workspaceId);
    });
  }

  startPolling(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.store.listNotionConnections().then(async (connections) => {
        for (const connection of connections) {
          if (connection.status !== "active" || !connection.dataSources.tasks || this.tails.has(connection.workspaceId)) continue;
          try { await this.scan(connection.workspaceId); } catch { /* persisted status reports the failure */ }
        }
      }).catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
  }

  close(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private async scanLocked(workspaceId: string): Promise<void> {
    const connection = await this.store.getNotionConnection(workspaceId);
    const credential = this.vault.getCredential(workspaceId);
    if (!connection || connection.status !== "active" || !credential) {
      throw new ApiError(409, "Notion 尚未完成授权和结构初始化，或同步已暂停");
    }
    if (tables.some((table) => !connection.dataSources[table]) || !connection.dataSources.rules) {
      throw new ApiError(409, "Notion 数据源结构尚未齐备");
    }
    const token = credential.access_token;
    const epoch = (await this.store.getPlanningVersion()).datasetEpoch;
    const existingMappings = (await this.store.listNotionTaskMappings()).filter((mapping) => mapping.workspaceId === workspaceId);
    const unresolved = (await this.store.listNotionOutboxOperations()).some((operation) =>
      operation.workspaceId === workspaceId && ["pending", "sending", "unknown", "quarantined"].includes(operation.status));
    if (unresolved) throw new ApiError(409, "Notion 待发送或未知操作需先核对，不能直接覆盖本地任务");

    let areas: AreaRow[] = [];
    let projects: ProjectRow[] = [];
    for (const table of tables) {
      const sourceId = connection.dataSources[table]!.dataSourceId;
      const startAt = this.timestamp();
      await this.setWatermark(workspaceId, sourceId, { lastAttemptAt: startAt });
      try {
        const rows = await this.gateway.scan(token, connection, table);
        if (rows.some((row) => row.kind !== (table === "areas" ? "area" : table === "projects" ? "project" : "task"))) {
          throw new NotionReadFailure("schema", "Notion scan returned a row from a different data source");
        }
        const distinct = uniqueRows(rows).filter((row) => table === "tasks" || !row.inTrash);
        const archivedIds = table === "tasks"
          ? await this.checkMissingTasks(token, existingMappings, distinct) : [];
        await this.store.transaction(async () => {
          await this.assertCurrent(connection, token, epoch);
          if (table === "areas") {
            areas = distinct as AreaRow[];
            await this.applyNodes(connection, table, areas.map((row) => ({
              workspaceId, dataSourceId: sourceId, remotePageId: row.id, kind: "area", title: row.title,
              url: row.url, areaPageId: null, updatedAt: row.editedAt,
            })));
          } else if (table === "projects") {
            projects = distinct as ProjectRow[];
            const areaIds = new Set(areas.map((row) => row.id));
            await this.applyNodes(connection, table, projects.map((row) => {
              if (row.areaIds.length !== 1 || !areaIds.has(row.areaIds[0])) {
                throw new NotionReadFailure("schema", `Notion project ${row.id} has no single accessible area`);
              }
              return { workspaceId, dataSourceId: sourceId, remotePageId: row.id,
                kind: "project" as const, title: row.title, url: row.url,
                areaPageId: row.areaIds[0], updatedAt: row.editedAt };
            }));
          } else {
            const preferences = await this.store.getAgentRecord<AgentPreferences>(AGENT_NAMESPACES.preferences, "current");
            const apply = () => this.applyTasks(connection, distinct as TaskRow[], archivedIds, areas, projects);
            const changed = preferences?.timeZone
              ? await this.store.withEventContext({ date: dateInTimeZone(this.clock(), preferences.timeZone),
                at: this.timestamp(), source: "system", kind: "notion_observed" }, apply)
              : await apply();
            if (changed) {
              clearUndoReceipts(this.store);
            }
          }
          await this.assertCurrent(connection, token, epoch);
          await this.setWatermark(workspaceId, sourceId, {
            completedThrough: startAt, lastSuccessAt: this.timestamp(), lastError: null, lastErrorAt: null,
          });
        });
      } catch (error) {
        const category = error instanceof NotionReadFailure ? error.category : error instanceof ApiError ? "local" : "local";
        await this.setWatermark(workspaceId, sourceId, { lastError: category, lastErrorAt: this.timestamp() });
        throw error;
      }
    }
  }

  private async applyNodes(connection: NotionConnection, table: "areas" | "projects", nodes: NotionReadNode[]): Promise<void> {
    await this.store.replaceNotionReadNodes(connection.workspaceId, connection.dataSources[table]!.dataSourceId, nodes);
  }

  private async applyTasks(connection: NotionConnection, rows: TaskRow[], archivedIds: string[],
    areas: AreaRow[], projects: ProjectRow[]): Promise<boolean> {
    const at = this.timestamp();
    let changed = false;
    const areaIds = new Set(areas.map((row) => row.id));
    const projectById = new Map(projects.map((row) => [row.id, row]));
    const mappings = await this.store.listNotionTaskMappings();
    const byRemote = new Map(mappings.filter((mapping) => mapping.workspaceId === connection.workspaceId && mapping.remotePageId)
      .map((mapping) => [mapping.remotePageId!, mapping]));
    for (const row of rows) {
      if (row.ruleIds.length > 1) throw new NotionReadFailure("schema", `Notion task ${row.id} has multiple rules`);
      if (Boolean(row.ruleIds.length) !== Boolean(row.occurrenceKey)) {
        throw new NotionReadFailure("schema", `Notion task ${row.id} has an incomplete rule instance identity`);
      }
      if (row.ruleIds.length === 1) {
        if (byRemote.has(row.id)) throw new NotionReadFailure("schema", `Linked task ${row.id} became a rule instance`);
        continue; // Rule instances belong to T7, never materialize as one-off tasks.
      }
      if (row.projectIds.length > 1 || row.directAreaIds.length > 1) {
        throw new NotionReadFailure("schema", `Notion task ${row.id} has ambiguous ownership`);
      }
      const project = row.projectIds[0] ? projectById.get(row.projectIds[0]) : undefined;
      if (row.projectIds[0] && !project) throw new NotionReadFailure("schema", `Notion task ${row.id} project is inaccessible`);
      const areaId = project?.areaIds[0] ?? row.directAreaIds[0] ?? null;
      if (areaId && !areaIds.has(areaId)) throw new NotionReadFailure("schema", `Notion task ${row.id} area is inaccessible`);
      const fields = notionTaskFieldsSchema.parse({ title: row.title, date: row.date, completed: row.completed });
      const previousMapping = byRemote.get(row.id);
      let localId = previousMapping?.localTaskId ?? randomUUID();
      while (!previousMapping && await this.store.getTask(localId)) localId = randomUUID();
      const previous = await this.store.getTask(localId);
      if (previousMapping?.status === "needs_review") throw new NotionReadFailure("schema", `Notion mapping ${row.id} requires review`);
      // Notion's checkbox does not identify when completion happened. Keep a
      // known local completion timestamp, otherwise explicitly record unknown.
      const completedAt = fields.completed && previous?.status === "completed" ? previous.completedAt : null;
      const completedOn = fields.completed && previous?.status === "completed" ? previous.completedOn : null;
      const next: Task = taskSchema.parse({
        id: localId, title: fields.title, notes: previous?.notes ?? "",
        startDate: fields.date?.[0] ?? null, endDate: fields.date?.[1] ?? null,
        status: fields.completed ? "completed" : "open",
        createdAt: previous?.createdAt ?? row.createdAt,
        updatedAt: at, completedAt, completedOn,
        ...(previous?.archived !== undefined || row.inTrash ? { archived: row.inTrash } : {}),
      });
      const sameBusinessState = previous && JSON.stringify({ ...previous, updatedAt: next.updatedAt }) === JSON.stringify(next);
      if (!sameBusinessState) {
        if (previous && (previous.startDate !== next.startDate || previous.endDate !== next.endDate ||
          previous.status !== next.status || row.inTrash)) {
          for (const record of await this.store.listFocusRecordsForTask(localId)) await this.store.deleteFocusRecord(record.id);
        }
        await this.store.putTask(next);
        changed = true;
      }
      const mapping: NotionTaskMapping = {
        localTaskId: localId, workspaceId: connection.workspaceId,
        dataSourceId: connection.dataSources.tasks!.dataSourceId, remotePageId: row.id,
        clientKey: previousMapping?.clientKey ?? notionClientKey(connection.installationId, localId),
        baseline: fields, status: row.inTrash ? "archived" : "active", updatedAt: at,
      };
      if (!previousMapping || JSON.stringify({ ...previousMapping, updatedAt: at }) !== JSON.stringify(mapping)) {
        await this.store.putNotionTaskMapping(mapping);
      }
      const context: NotionReadTaskContext = {
        localTaskId: localId, workspaceId: connection.workspaceId, remotePageId: row.id,
        url: row.url, projectPageId: project?.id ?? null, areaPageId: areaId, updatedAt: row.editedAt,
      };
      await this.store.putNotionReadTaskContext(context);
    }
    for (const remoteId of archivedIds) {
      const mapping = byRemote.get(remoteId);
      if (!mapping) continue;
      const task = await this.store.getTask(mapping.localTaskId);
      if (task && task.archived !== true) {
        for (const record of await this.store.listFocusRecordsForTask(task.id)) await this.store.deleteFocusRecord(record.id);
        await this.store.putTask(taskSchema.parse({ ...task, archived: true, updatedAt: at }));
        changed = true;
      }
      if (mapping.status !== "archived") await this.store.putNotionTaskMapping({ ...mapping, status: "archived", updatedAt: at });
    }
    return changed;
  }

  private async checkMissingTasks(token: string, mappings: NotionTaskMapping[], rows: ReadRow[]): Promise<string[]> {
    const present = new Set(rows.map((row) => row.id));
    const archived: string[] = [];
    for (const mapping of mappings) {
      if (!mapping.remotePageId || present.has(mapping.remotePageId)) continue;
      const page = await this.gateway.readKnownPage(token, mapping.remotePageId);
      if (!page || page.id !== mapping.remotePageId) throw new NotionReadFailure("incomplete", "Known Notion task could not be verified");
      if (!page.inTrash) throw new NotionReadFailure("incomplete", "Known Notion task was absent from a complete query but was not in trash");
      archived.push(mapping.remotePageId);
    }
    return archived;
  }

  private async assertCurrent(connection: NotionConnection, token: string, epoch: string): Promise<void> {
    const current = await this.store.getNotionConnection(connection.workspaceId);
    if (!current || current.status !== "active" || current.installationId !== connection.installationId ||
      (await this.store.getPlanningVersion()).datasetEpoch !== epoch ||
      this.vault.getCredential(connection.workspaceId)?.access_token !== token) {
      throw new ApiError(409, "Notion 授权或本地数据在扫描期间改变，请重新扫描");
    }
  }

  private async setWatermark(workspaceId: string, dataSourceId: string, patch: Partial<NotionScanWatermark>): Promise<void> {
    await this.store.transaction(async () => {
      const old = (await this.store.listNotionScanWatermarks()).find((item) =>
        item.workspaceId === workspaceId && item.dataSourceId === dataSourceId);
      await this.store.putNotionScanWatermark({ workspaceId, dataSourceId,
        completedThrough: old?.completedThrough ?? null, lastAttemptAt: old?.lastAttemptAt ?? null,
        lastSuccessAt: old?.lastSuccessAt ?? null, lastError: old?.lastError ?? null,
        lastErrorAt: old?.lastErrorAt ?? null, ...patch });
    });
  }

  private async withLock<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(workspaceId);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(workspaceId, tail);
    if (previous) await previous;
    try { return await action(); }
    finally { release(); if (this.tails.get(workspaceId) === tail) this.tails.delete(workspaceId); }
  }

  private timestamp(): string { return new Date(this.clock()).toISOString(); }
}

function uniqueRows(rows: ReadRow[]): ReadRow[] {
  const seen = new Map<string, ReadRow>();
  for (const row of rows) {
    if (!row.id || seen.has(row.id) && JSON.stringify(seen.get(row.id)) !== JSON.stringify(row)) {
      throw new NotionReadFailure("incomplete", "Notion scan contained conflicting copies of one page");
    }
    seen.set(row.id, row);
  }
  return [...seen.values()];
}
