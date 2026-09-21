import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

import type { PlannerArchiveData, PlannerArchiveStore } from "@newday/core/application/planner-archive-store";
import { AGENT_NAMESPACES, dateInTimeZone, type AgentPreferences, type ExecutionReceipt, type OperationResult, type PlannerEvent, type PlanningVersion } from "@newday/core/contracts/agent-planning";
import type { FocusRecord, RecurrenceSeries, Task } from "@newday/core/domain/planner-model";
import type { InboxItem, LifeFolder, LifeResource, ResourceTaskLink } from "@newday/core/domain/life-model";

type Row = Record<string, SQLOutputValue>;
export type StorageFailurePoint = "before_commit" | "after_commit" | "before_event" | "before_receipt";
export type PlannerEventContext = Pick<PlannerEvent, "date" | "at" | "source"> & Partial<Pick<PlannerEvent, "operationId" | "proposalId">> & { kind?: string };
type TransactionState = { callbacks: Array<() => void>; mutated: boolean; eventContext?: PlannerEventContext; active: boolean };
export type ExecutionLedgerRecord = {
  operationId: string; requestDigest: string; proposalId: string; datasetEpoch: string;
  terminalStatus: "applied" | "no_change"; receipt: ExecutionReceipt | null;
};

/** One authoritative connection: repositories join the caller's transaction.
 * The separate execution ledger survives deletion of display history. */
export class SQLitePlannerStore implements PlannerArchiveStore {
  private readonly database: DatabaseSync;
  private readonly transactionContext = new AsyncLocalStorage<TransactionState>();
  private readonly transactionFrames = new AsyncLocalStorage<{ queue: Promise<unknown> }>();
  private transactionQueue: Promise<unknown> = Promise.resolve();
  private savepointCounter = 0;
  private failureInjector?: (point: StorageFailurePoint) => void;

  constructor(public readonly databasePath: string, options: { failureInjector?: (point: StorageFailurePoint) => void } = {}) {
    this.failureInjector = options.failureInjector;
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      this.initializeSchema();
    } catch (error) { this.database.close(); throw error; }
  }

  close() { this.database.close(); }
  setFailureInjector(injector?: (point: StorageFailurePoint) => void) { this.failureInjector = injector; }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    const active = this.transactionContext.getStore();
    if (active?.active) {
      const frame = this.transactionFrames.getStore()!;
      const result = frame.queue.then(() => this.transactionFrames.run({ queue: Promise.resolve() }, () => this.nestedTransaction(operation, active)));
      frame.queue = result.catch(() => undefined);
      return result;
    }
    const result = this.transactionQueue.then(() => this.transactionContext.run({ callbacks: [], mutated: false, active: true }, async () => {
      const state = this.transactionContext.getStore()!;
      this.database.exec("BEGIN IMMEDIATE");
      let value: T;
      try {
        value = await this.transactionFrames.run({ queue: Promise.resolve() }, operation);
        this.failureInjector?.("before_commit");
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        state.active = false;
        throw error;
      }
      state.active = false;
      for (const callback of state.callbacks) callback();
      // Deliberately outside the rollback path: useful for proving lost acknowledgements.
      this.failureInjector?.("after_commit");
      return value;
    }));
    this.transactionQueue = result.catch(() => undefined);
    return result;
  }

  afterCommit(callback: () => void) {
    const state = this.transactionContext.getStore();
    if (state?.active) state.callbacks.push(callback);
    else callback();
  }

  async withEventContext<T>(context: PlannerEventContext, operation: () => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      const state = this.transactionContext.getStore()!;
      const previous = state.eventContext;
      state.eventContext = context;
      try { return await operation(); }
      finally { state.eventContext = previous; }
    });
  }

  private async nestedTransaction<T>(operation: () => Promise<T>, state: TransactionState) {
    const savepoint = `nested_${++this.savepointCounter}`;
    const callbackCount = state.callbacks.length;
    const mutated = state.mutated;
    this.database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const value = await operation();
      this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      state.callbacks.length = callbackCount;
      state.mutated = mutated;
      throw error;
    }
  }

  async getPlanningVersion(): Promise<PlanningVersion> {
    const epoch = this.database.prepare("SELECT value FROM metadata WHERE key = 'dataset_epoch'").get();
    const revision = this.database.prepare("SELECT value FROM metadata WHERE key = 'planner_revision'").get();
    return { datasetEpoch: String(epoch!.value), plannerRevision: Number(revision!.value) };
  }

  async rotateDatasetEpoch(): Promise<PlanningVersion> {
    return this.transaction(async () => {
      this.database.prepare("UPDATE metadata SET value = ? WHERE key = 'dataset_epoch'").run(randomUUID());
      this.database.prepare("UPDATE metadata SET value = '0' WHERE key = 'planner_revision'").run();
      this.transactionContext.getStore()!.mutated = true;
      return this.getPlanningVersion();
    });
  }

  private markMutation() {
    const state = this.transactionContext.getStore();
    if (!state?.active) throw new Error("Planner mutation requires a transaction");
    if (!state.mutated) {
      this.database.prepare("UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'planner_revision'").run();
      state.mutated = true;
    }
  }

  async getTask(id: string) { return this.one<Task>("SELECT payload FROM tasks WHERE id = ?", id); }
  async getTaskByOccurrenceKey(key: string) { return this.one<Task>("SELECT payload FROM tasks WHERE occurrence_key = ?", key); }
  async putTask(task: Task) {
    await this.transaction(async () => {
      const before = await this.getTask(task.id);
      if (JSON.stringify(before) === JSON.stringify(task)) return;
      this.database.prepare(`INSERT INTO tasks (id, series_id, occurrence_key, payload) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET series_id=excluded.series_id, occurrence_key=excluded.occurrence_key, payload=excluded.payload`)
        .run(task.id, task.seriesId ?? null, task.occurrenceKey ?? null, JSON.stringify(task));
      this.markMutation();
      await this.recordMutation(this.taskChangeKind(before, task), { taskId: task.id, taskBefore: before, taskAfter: task });
    });
  }
  async deleteTask(id: string) {
    await this.transaction(async () => {
      const before = await this.getTask(id);
      if (!before) return;
      this.database.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      this.markMutation();
      await this.recordMutation("deleted", { taskId: id, taskBefore: before });
    });
  }
  async listAllTasks() { return this.many<Task>("SELECT payload FROM tasks ORDER BY id"); }
  async listTasksBySeries(id: string) { return this.many<Task>("SELECT payload FROM tasks WHERE series_id = ? ORDER BY id", id); }
  async getRecurrenceSeries(id: string) { return this.one<RecurrenceSeries>("SELECT payload FROM recurrence_series WHERE id = ?", id); }
  async putRecurrenceSeries(series: RecurrenceSeries) {
    await this.transaction(async () => {
      if (JSON.stringify(await this.getRecurrenceSeries(series.id)) === JSON.stringify(series)) return;
      this.database.prepare(`INSERT INTO recurrence_series (id, logical_series_id, start_date, payload) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET logical_series_id=excluded.logical_series_id,start_date=excluded.start_date,payload=excluded.payload`)
        .run(series.id, series.logicalSeriesId, series.startDate, JSON.stringify(series));
      this.markMutation();
      await this.recordMutation("recurrence_changed");
    });
  }
  async deleteRecurrenceSeries(id: string) {
    await this.transaction(async () => {
      if (!await this.getRecurrenceSeries(id)) return;
      this.database.prepare("DELETE FROM recurrence_series WHERE id = ?").run(id);
      this.markMutation(); await this.recordMutation("recurrence_deleted");
    });
  }
  async listAllRecurrenceSeries() { return this.many<RecurrenceSeries>("SELECT payload FROM recurrence_series ORDER BY id"); }
  async listRecurrenceSeriesByLogicalSeriesId(id: string) { return this.many<RecurrenceSeries>("SELECT payload FROM recurrence_series WHERE logical_series_id = ? ORDER BY start_date,id", id); }
  async getFocusRecord(id: string) { return this.one<FocusRecord>("SELECT payload FROM focus_records WHERE id = ?", id); }
  async putFocusRecord(record: FocusRecord) {
    await this.transaction(async () => {
      if (JSON.stringify(await this.getFocusRecord(record.id)) === JSON.stringify(record)) return;
      this.database.prepare(`INSERT INTO focus_records (id,date,task_id,payload) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET date=excluded.date,task_id=excluded.task_id,payload=excluded.payload`)
        .run(record.id, record.date, record.taskId, JSON.stringify(record));
      this.markMutation(); await this.recordMutation("focus_added", { taskId: record.taskId });
    });
  }
  async deleteFocusRecord(id: string) {
    await this.transaction(async () => {
      const before = await this.getFocusRecord(id);
      if (!before) return;
      this.database.prepare("DELETE FROM focus_records WHERE id = ?").run(id);
      this.markMutation(); await this.recordMutation("focus_removed", { taskId: before.taskId });
    });
  }
  async listFocusRecordsForDate(date: string) { return this.many<FocusRecord>("SELECT payload FROM focus_records WHERE date = ? ORDER BY id", date); }
  async listFocusRecordsForTask(id: string) { return this.many<FocusRecord>("SELECT payload FROM focus_records WHERE task_id = ? ORDER BY id", id); }
  async listAllFocusRecords() { return this.many<FocusRecord>("SELECT payload FROM focus_records ORDER BY id"); }

  async getInboxItem(id: string) { return this.one<InboxItem>("SELECT payload FROM life_inbox WHERE id=?", id); }
  async listAllInboxItems() { return this.many<InboxItem>("SELECT payload FROM life_inbox ORDER BY created_at DESC,id"); }
  async putInboxItem(item: InboxItem) {
    await this.transaction(async () => {
      this.database.prepare(`INSERT INTO life_inbox(id,source_resource_id,created_at,payload) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET source_resource_id=excluded.source_resource_id,payload=excluded.payload`)
        .run(item.id, item.sourceResourceId, item.createdAt, JSON.stringify(item));
    });
  }
  async deleteInboxItem(id: string) { await this.transaction(async () => { this.database.prepare("DELETE FROM life_inbox WHERE id=?").run(id); }); }

  async getFolder(id: string) { return this.one<LifeFolder>("SELECT payload FROM life_folders WHERE id=?", id); }
  async listAllFolders() { return this.many<LifeFolder>("SELECT payload FROM life_folders ORDER BY parent_id,name,id"); }
  async putFolder(folder: LifeFolder) {
    await this.transaction(async () => {
      this.database.prepare(`INSERT INTO life_folders(id,parent_id,name,payload) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,payload=excluded.payload`)
        .run(folder.id, folder.parentId, folder.name, JSON.stringify(folder));
    });
  }

  async getResource(id: string) { return this.one<LifeResource>("SELECT payload FROM life_resources WHERE id=?", id); }
  async listAllResources() { return this.many<LifeResource>("SELECT payload FROM life_resources ORDER BY updated_at DESC,id"); }
  async putResource(resource: LifeResource) {
    await this.transaction(async () => {
      this.database.prepare(`INSERT INTO life_resources(id,folder_id,updated_at,payload) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,updated_at=excluded.updated_at,payload=excluded.payload`)
        .run(resource.id, resource.folderId, resource.updatedAt, JSON.stringify(resource));
    });
  }
  async listAllResourceTaskLinks(): Promise<ResourceTaskLink[]> {
    return this.database.prepare("SELECT resource_id,task_id FROM life_resource_tasks ORDER BY resource_id,task_id").all()
      .map((row) => ({ resourceId: String(row.resource_id), taskId: String(row.task_id) }));
  }
  async listResourceTaskLinksForTask(taskId: string): Promise<ResourceTaskLink[]> {
    return this.database.prepare("SELECT resource_id,task_id FROM life_resource_tasks WHERE task_id=? ORDER BY resource_id").all(taskId)
      .map((row) => ({ resourceId: String(row.resource_id), taskId: String(row.task_id) }));
  }
  async putResourceTaskLink(link: ResourceTaskLink) {
    await this.transaction(async () => {
      this.database.prepare("INSERT OR IGNORE INTO life_resource_tasks(resource_id,task_id) VALUES(?,?)").run(link.resourceId, link.taskId);
    });
  }
  async deleteResourceTaskLink(link: ResourceTaskLink) {
    await this.transaction(async () => {
      this.database.prepare("DELETE FROM life_resource_tasks WHERE resource_id=? AND task_id=?").run(link.resourceId, link.taskId);
    });
  }

  async replaceAllData(data: PlannerArchiveData) {
    await this.transaction(async () => {
      await this.rotateDatasetEpoch();
      this.database.exec("DELETE FROM life_resource_tasks; DELETE FROM life_inbox; DELETE FROM life_resources; DELETE FROM life_folders WHERE parent_id IS NOT NULL; DELETE FROM life_folders WHERE parent_id IS NULL; DELETE FROM focus_records; DELETE FROM tasks; DELETE FROM recurrence_series;");
      for (const series of data.recurrenceSeries ?? []) await this.putRecurrenceSeries(series);
      for (const task of data.tasks) await this.putTask(task);
      for (const record of data.focusRecords ?? []) await this.putFocusRecord(record);
      const folders = data.folders ?? [];
      for (const folder of folders.filter((value) => value.parentId === null)) await this.putFolder(folder);
      for (const folder of folders.filter((value) => value.parentId !== null)) await this.putFolder(folder);
      for (const resource of data.resources ?? []) await this.putResource(resource);
      for (const item of data.inboxItems ?? []) await this.putInboxItem(item);
      for (const link of data.resourceTaskLinks ?? []) await this.putResourceTaskLink(link);
      await this.recordMutation("dataset_replaced");
    });
  }

  /** This marker survives replacement so old browser data cannot overwrite a restore. */
  async importBrowserData(data: PlannerArchiveData, hash: string) {
    return this.transaction(async () => {
      const imported = this.database.prepare("SELECT value FROM metadata WHERE key = 'browser_import_hash'").get();
      if (imported) return imported.value === hash ? "already-imported" as const : "server-not-empty" as const;
      const counts = this.database.prepare("SELECT (SELECT COUNT(*) FROM tasks)+(SELECT COUNT(*) FROM recurrence_series)+(SELECT COUNT(*) FROM focus_records)+(SELECT COUNT(*) FROM life_inbox)+(SELECT COUNT(*) FROM life_folders)+(SELECT COUNT(*) FROM life_resources) AS count").get();
      if (Number(counts?.count) > 0) return "server-not-empty" as const;
      await this.replaceAllData(data);
      this.database.prepare("INSERT INTO metadata (key,value) VALUES ('browser_import_hash',?)").run(hash);
      return "imported" as const;
    });
  }

  async getAgentRecord<T>(namespace: string, id: string): Promise<T | undefined> { return this.one<T>("SELECT payload FROM agent_records WHERE namespace=? AND id=?", namespace, id); }
  async putAgentRecord<T>(namespace: string, id: string, value: T): Promise<void> {
    await this.transaction(async () => {
      this.database.prepare("INSERT INTO agent_records(namespace,id,payload) VALUES(?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET payload=excluded.payload").run(namespace, id, JSON.stringify(value));
    });
  }
  async listAgentRecords<T>(namespace: string): Promise<T[]> { return this.many<T>("SELECT payload FROM agent_records WHERE namespace=? ORDER BY id", namespace); }
  async deleteAgentRecord(namespace: string, id: string): Promise<void> { await this.transaction(async () => { this.database.prepare("DELETE FROM agent_records WHERE namespace=? AND id=?").run(namespace, id); }); }
  async deleteAgentRecords(namespace: string): Promise<void> { await this.transaction(async () => { this.database.prepare("DELETE FROM agent_records WHERE namespace=?").run(namespace); }); }

  async appendPlannerEvent(event: PlannerEvent): Promise<void> {
    await this.transaction(async () => {
      this.failureInjector?.("before_event");
      this.database.prepare("INSERT INTO planner_events(id,dataset_epoch,date,payload) VALUES(?,?,?,?)").run(event.id, event.datasetEpoch, event.date, JSON.stringify(event));
    });
  }
  async listPlannerEvents(): Promise<PlannerEvent[]> { return this.many<PlannerEvent>("SELECT payload FROM planner_events ORDER BY rowid"); }
  async deletePlannerEvents(): Promise<void> { await this.transaction(async () => { this.database.exec("DELETE FROM planner_events"); }); }

  async getExecutionLedger(operationId: string): Promise<ExecutionLedgerRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM execution_ledger WHERE operation_id=?").get(operationId);
    if (!row) return undefined;
    return { operationId, requestDigest: String(row.request_digest), proposalId: String(row.proposal_id), datasetEpoch: String(row.dataset_epoch), terminalStatus: row.terminal_status as "applied" | "no_change", receipt: typeof row.payload === "string" ? JSON.parse(row.payload) as ExecutionReceipt : null };
  }
  async putExecutionReceipt(requestDigest: string, receipt: ExecutionReceipt): Promise<void> {
    await this.transaction(async () => {
      this.failureInjector?.("before_receipt");
      this.database.prepare("INSERT INTO execution_ledger(operation_id,request_digest,proposal_id,dataset_epoch,terminal_status,payload) VALUES(?,?,?,?,?,?)")
        .run(receipt.operationId, requestDigest, receipt.proposalId, receipt.beforeVersion.datasetEpoch, receipt.status, JSON.stringify(receipt));
    });
  }
  async getOperationResult(operationId: string): Promise<OperationResult> {
    const record = await this.getExecutionLedger(operationId);
    if (!record) return { status: "not_found", operationId };
    if (record.receipt) return { status: "found", receipt: record.receipt };
    return { status: "details_deleted", operationId, proposalId: record.proposalId, datasetEpoch: record.datasetEpoch, terminalStatus: record.terminalStatus, detailsDeleted: true };
  }
  async listExecutionReceipts(): Promise<ExecutionReceipt[]> { return this.many<ExecutionReceipt>("SELECT payload FROM execution_ledger WHERE payload IS NOT NULL ORDER BY rowid"); }
  async clearExecutionDetails(): Promise<void> { await this.transaction(async () => { this.database.exec("UPDATE execution_ledger SET payload=NULL"); }); }

  private taskChangeKind(before: Task | undefined, after: Task) {
    if (!before) return "created";
    if (before.status !== after.status) return after.status === "completed" ? "completed" : "reopened";
    if (before.startDate !== after.startDate || before.endDate !== after.endDate) return "rescheduled";
    return "updated";
  }
  private async recordMutation(kind: string, task: Partial<Pick<PlannerEvent, "taskId" | "taskBefore" | "taskAfter">> = {}) {
    const explicit = this.transactionContext.getStore()?.eventContext;
    const preferences = await this.getAgentRecord<AgentPreferences>(AGENT_NAMESPACES.preferences, "current");
    // Before the user chooses a timezone there is no defensible event-day attribution.
    if (!explicit && !preferences?.timeZone) return;
    const at = explicit?.at ?? new Date().toISOString();
    const context = explicit ?? { date: dateInTimeZone(new Date(at), preferences!.timeZone!), at, source: "system" as const };
    await this.appendPlannerEvent({ id: randomUUID(), ...await this.getPlanningVersion(), ...context, kind: explicit?.kind ?? kind, ...task });
  }

  private one<T>(sql: string, ...parameters: SQLInputValue[]): T | undefined { const row = this.database.prepare(sql).get(...parameters); return row ? this.decode<T>(row) : undefined; }
  private many<T>(sql: string, ...parameters: SQLInputValue[]): T[] { return this.database.prepare(sql).all(...parameters).map((row) => this.decode<T>(row)); }
  private decode<T>(row: Row): T { if (typeof row.payload !== "string") throw new Error("Invalid SQLite payload"); return JSON.parse(row.payload) as T; }

  private initializeSchema() {
    const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version);
    if (version > 3) throw new Error("This database was created by a newer version of NewDay");
    if (version === 3) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (version < 2) this.database.exec(`
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY NOT NULL,series_id TEXT,occurrence_key TEXT UNIQUE,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
        CREATE INDEX IF NOT EXISTS tasks_by_series ON tasks(series_id);
        CREATE TABLE IF NOT EXISTS recurrence_series (id TEXT PRIMARY KEY NOT NULL,logical_series_id TEXT NOT NULL,start_date TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
        CREATE INDEX IF NOT EXISTS recurrence_by_logical_series ON recurrence_series(logical_series_id,start_date);
        CREATE TABLE IF NOT EXISTS focus_records (id TEXT PRIMARY KEY NOT NULL,date TEXT NOT NULL,task_id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),UNIQUE(date,task_id)) STRICT;
        CREATE INDEX IF NOT EXISTS focus_by_task ON focus_records(task_id);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL) STRICT;
        CREATE TABLE agent_records (namespace TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(namespace,id)) STRICT;
        CREATE TABLE planner_events (id TEXT PRIMARY KEY NOT NULL,dataset_epoch TEXT NOT NULL,date TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
        CREATE INDEX planner_events_by_date ON planner_events(date);
        CREATE TABLE execution_ledger (operation_id TEXT PRIMARY KEY NOT NULL,request_digest TEXT NOT NULL,proposal_id TEXT NOT NULL,dataset_epoch TEXT NOT NULL,terminal_status TEXT NOT NULL CHECK(terminal_status IN ('applied','no_change')),payload TEXT CHECK(payload IS NULL OR json_valid(payload))) STRICT;
      `);
      if (version < 2) {
        this.database.prepare("INSERT INTO metadata(key,value) VALUES('dataset_epoch',?) ON CONFLICT(key) DO NOTHING").run(randomUUID());
        this.database.exec("INSERT INTO metadata(key,value) VALUES('planner_revision','0') ON CONFLICT(key) DO NOTHING");
      }
      this.database.exec(`
        CREATE TABLE life_folders (id TEXT PRIMARY KEY NOT NULL,parent_id TEXT REFERENCES life_folders(id) ON DELETE RESTRICT,name TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
        CREATE UNIQUE INDEX life_folders_root_name ON life_folders(name COLLATE NOCASE) WHERE parent_id IS NULL;
        CREATE UNIQUE INDEX life_folders_child_name ON life_folders(parent_id,name COLLATE NOCASE) WHERE parent_id IS NOT NULL;
        CREATE TABLE life_resources (id TEXT PRIMARY KEY NOT NULL,folder_id TEXT REFERENCES life_folders(id) ON DELETE RESTRICT,updated_at TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
        CREATE INDEX life_resources_by_folder ON life_resources(folder_id);
        CREATE TABLE life_inbox (id TEXT PRIMARY KEY NOT NULL,source_resource_id TEXT REFERENCES life_resources(id) ON DELETE SET NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
        CREATE TABLE life_resource_tasks (resource_id TEXT NOT NULL REFERENCES life_resources(id) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,PRIMARY KEY(resource_id,task_id)) STRICT;
        CREATE INDEX life_resource_tasks_by_task ON life_resource_tasks(task_id);
        PRAGMA user_version=3;
        COMMIT;
      `);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

/** In-memory SQLite retains exactly the transaction semantics of the file store. */
export class MemoryAgentStore extends SQLitePlannerStore { constructor() { super(":memory:"); } }
