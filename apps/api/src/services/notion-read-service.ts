import { randomUUID } from "node:crypto";

import { AGENT_NAMESPACES, dateInTimeZone, type AgentPreferences } from "@newday/core/contracts/agent-planning";
import {
  notionClientKey, notionLogicalSeriesId, notionTaskFieldsSchema,
  type NotionConnection, type NotionReadNode, type NotionReadTaskContext,
  type NotionScanWatermark, type NotionTaskMapping,
} from "@newday/core/contracts/notion-sync";
import { localDateSchema, taskSchema, type Task } from "@newday/core/domain/planner-model";
import { recursOnDate } from "@newday/core/domain/planner-recurrence";
import { clearUndoReceipts } from "@newday/core/application/planner-undo";

import { ApiError } from "../http/api-error.js";
import type { NotionCredentialVault } from "../storage/notion-credential-vault.js";
import type { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";
import { NotionReadFailure, type AreaRow, type NotionReadGateway, type ProjectRow, type ReadRow, type ReadTable, type RuleRow, type TaskRow } from "./notion-read-gateway.js";
import { applyNotionRules, enqueueNotionRuleInstances } from "./notion-rule-service.js";

const tables: ReadTable[] = ["areas", "projects", "rules", "tasks"];
type ReadStatus = {
  workspaceId: string; connectionStatus: NotionConnection["status"] | "not_initialized";
  pauseReason: NotionConnection["pauseReason"] | null;
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
      pauseReason: connection?.pauseReason ?? null,
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
    const existingRules = await this.store.listNotionRuleMappings(workspaceId);
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
        const expectedKind = { areas: "area", projects: "project", rules: "rule", tasks: "task" }[table];
        if (rows.some((row) => row.kind !== expectedKind)) {
          throw new NotionReadFailure("schema", "Notion scan returned a row from a different data source");
        }
        const distinct = uniqueRows(rows).filter((row) => table === "tasks" || table === "rules" || !row.inTrash);
        const archivedIds = table === "tasks"
          ? await this.checkMissingTasks(token, existingMappings, distinct)
          : table === "rules" ? await this.checkMissingRules(token, existingRules, distinct) : [];
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
          } else if (table === "rules") {
            const preferences = await this.store.getAgentRecord<AgentPreferences>(AGENT_NAMESPACES.preferences, "current");
            if (!preferences?.timeZone && (distinct.length || existingRules.length)) {
              throw new ApiError(409, "请先确认用户时区，再同步 Notion 重复规则");
            }
            const at = this.timestamp();
            const apply = () => applyNotionRules(this.store, connection, distinct as RuleRow[], archivedIds, at);
            const changed = preferences?.timeZone
              ? await this.store.withEventContext({ date: dateInTimeZone(this.clock(), preferences.timeZone),
                at, source: "system", kind: "notion_observed" }, apply)
              : await apply();
            if (changed) clearUndoReceipts(this.store);
          } else {
            const pendingWrite = (await this.store.listNotionOutboxOperations()).some((operation) =>
              operation.workspaceId === workspaceId && ["pending", "sending", "unknown", "quarantined"].includes(operation.status));
            if (pendingWrite) throw new ApiError(409, "Notion 扫描期间有新的待发送操作；先完成写回再重试读取");
            const preferences = await this.store.getAgentRecord<AgentPreferences>(AGENT_NAMESPACES.preferences, "current");
            const apply = async () => {
              const changed = await this.applyTasks(connection, distinct as TaskRow[], archivedIds, areas, projects);
              if (!preferences?.timeZone) return changed;
              const generated = await enqueueNotionRuleInstances(this.store, connection,
                dateInTimeZone(this.clock(), preferences.timeZone), this.timestamp());
              return changed || generated > 0;
            };
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
    const byOccurrence = new Map(mappings.filter((mapping) => mapping.workspaceId === connection.workspaceId && mapping.occurrenceKey)
      .map((mapping) => [mapping.occurrenceKey!, mapping]));
    const rules = new Map((await this.store.listNotionRuleMappings(connection.workspaceId))
      .map((mapping) => [mapping.remotePageId, mapping]));
    const seenOccurrences = new Set<string>();
    for (const row of rows) {
      if (row.ruleIds.length > 1) throw new NotionReadFailure("schema", `Notion task ${row.id} has multiple rules`);
      const previousMapping = byRemote.get(row.id) ?? (row.occurrenceKey ? byOccurrence.get(row.occurrenceKey) : undefined);
      const linkedRulePageId = row.ruleIds[0] ?? null;
      const previousRule = previousMapping?.rulePageId ? rules.get(previousMapping.rulePageId) : undefined;
      // Notion hides a relation after its target rule is moved to trash. Keep
      // the already verified identity only for that archived rule; a missing
      // relation to an active rule remains a schema failure.
      const rulePageId = linkedRulePageId ?? (row.occurrenceKey &&
        previousMapping?.occurrenceKey === row.occurrenceKey && previousRule?.status === "archived"
        ? previousMapping.rulePageId ?? null : null);
      if (Boolean(rulePageId) !== Boolean(row.occurrenceKey)) {
        throw new NotionReadFailure("schema", `Notion task ${row.id} has an incomplete rule instance identity`);
      }
      const rule = rulePageId ? rules.get(rulePageId) : undefined;
      let occurrenceDate: string | undefined;
      if (rulePageId) {
        if (!rule) throw new NotionReadFailure("schema", `Notion task ${row.id} references an inaccessible rule`);
        const prefix = `${notionLogicalSeriesId(connection.workspaceId, rulePageId)}:`;
        const parsedDate = localDateSchema.safeParse(row.occurrenceKey?.startsWith(prefix)
          ? row.occurrenceKey.slice(prefix.length) : null);
        if (!parsedDate.success || !row.occurrenceKey || seenOccurrences.has(row.occurrenceKey)) {
          throw new NotionReadFailure("schema", `Notion task ${row.id} has a duplicate or invalid occurrence key`);
        }
        if (!row.date || row.date[0] !== row.date[1]) {
          throw new NotionReadFailure("schema", `Notion occurrence ${row.id} must have one plan date`);
        }
        occurrenceDate = parsedDate.data;
        seenOccurrences.add(row.occurrenceKey);
      }
      if (row.projectIds.length > 1 || row.directAreaIds.length > 1) {
        throw new NotionReadFailure("schema", `Notion task ${row.id} has ambiguous ownership`);
      }
      const project = row.projectIds[0] ? projectById.get(row.projectIds[0]) : undefined;
      if (row.projectIds[0] && !project) throw new NotionReadFailure("schema", `Notion task ${row.id} project is inaccessible`);
      const areaId = project?.areaIds[0] ?? row.directAreaIds[0] ?? null;
      if (areaId && !areaIds.has(areaId)) throw new NotionReadFailure("schema", `Notion task ${row.id} area is inaccessible`);
      const fields = notionTaskFieldsSchema.parse({ title: row.title, date: row.date, completed: row.completed });
      if (previousMapping && (previousMapping.rulePageId !== (rulePageId ?? undefined) ||
        previousMapping.occurrenceKey !== (row.occurrenceKey ?? undefined) ||
        previousMapping.remotePageId !== null && previousMapping.remotePageId !== row.id)) {
        throw new NotionReadFailure("schema", `Notion task ${row.id} changed its rule identity`);
      }
      let localId = previousMapping?.localTaskId ??
        (row.occurrenceKey ? (await this.store.getTaskByOccurrenceKey(row.occurrenceKey))?.id ?? row.occurrenceKey : randomUUID());
      if (!row.occurrenceKey) while (!previousMapping && await this.store.getTask(localId)) localId = randomUUID();
      const previous = await this.store.getTask(localId);
      if (row.occurrenceKey && previous && previous.occurrenceKey !== row.occurrenceKey) {
        throw new NotionReadFailure("schema", `Notion occurrence ${row.id} collides with a local task`);
      }
      if (row.clientKey !== null && row.clientKey !==
        (previousMapping?.clientKey ?? notionClientKey(connection.installationId, localId))) {
        throw new NotionReadFailure("schema", `Linked task ${row.id} has a different NewDay Key`);
      }
      if (previousMapping?.status === "needs_review") throw new NotionReadFailure("schema", `Notion mapping ${row.id} requires review`);
      const series = rule ? await this.store.getRecurrenceSeries(rule.logicalSeriesId) : undefined;
      if (rule && !series) throw new NotionReadFailure("schema", `Notion rule ${rulePageId} lost its local series`);
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
        ...(rule && series && occurrenceDate && row.occurrenceKey ? {
          seriesId: series.id, logicalSeriesId: rule.logicalSeriesId,
          occurrenceDate, occurrenceKey: row.occurrenceKey,
          isSeriesException: previous?.isSeriesException === true ||
            fields.date?.[0] !== occurrenceDate || fields.title !== series.title ||
            !recursOnDate(series, occurrenceDate),
        } : {}),
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
        ...(rulePageId && row.occurrenceKey ? { rulePageId, occurrenceKey: row.occurrenceKey } : {}),
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

  private async checkMissingRules(token: string,
    mappings: Awaited<ReturnType<SQLitePlannerStore["listNotionRuleMappings"]>>, rows: ReadRow[]): Promise<string[]> {
    const present = new Set(rows.map((row) => row.id));
    const archived = rows.filter((row) => row.inTrash).map((row) => row.id);
    for (const mapping of mappings) {
      if (present.has(mapping.remotePageId)) continue;
      const page = await this.gateway.readKnownPage(token, mapping.remotePageId);
      if (!page || page.id !== mapping.remotePageId) {
        throw new NotionReadFailure("incomplete", "Known Notion rule could not be verified");
      }
      if (!page.inTrash) {
        throw new NotionReadFailure("incomplete", "Known Notion rule was absent from a complete query but was not in trash");
      }
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
