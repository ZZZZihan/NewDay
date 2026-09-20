import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

import type { PlannerArchiveData, PlannerArchiveStore } from "@newday/core/application/planner-archive-store";
import { AGENT_NAMESPACES, dateInTimeZone, type AgentPreferences, type ExecutionReceipt, type OperationResult, type PlannerEvent, type PlanningVersion } from "@newday/core/contracts/agent-planning";
import type { FocusRecord, RecurrenceSeries, Task } from "@newday/core/domain/planner-model";
import type { InboxItem, LifeFolder, LifeResource, ResourceTaskLink } from "@newday/core/domain/life-model";
import {
  notionConnectionSchema,
  notionInitializationStepSchema,
  notionOutboxOperationSchema,
  notionTaskFieldsSchema,
  notionTaskMappingSchema,
  notionConflictRecordSchema,
  notionScanWatermarkSchema,
  notionReadNodeSchema,
  notionReadTaskContextSchema,
  notionRestoreQuarantineSchema,
  notionSyncArchiveSchema,
  emptyNotionSyncArchive,
  notionClientKey,
  type NotionConnection,
  type NotionInitializationStep,
  type NotionInitializationStepName,
  type NotionConflictRecord,
  type NotionOutboxOperation,
  type NotionTaskFields,
  type NotionTaskMapping,
  type NotionScanWatermark,
  type NotionReadNode,
  type NotionReadTaskContext,
  type NotionRestoreQuarantine,
  type NotionSyncArchive,
} from "@newday/core/contracts/notion-sync";

type Row = Record<string, SQLOutputValue>;
export type StorageFailurePoint = "before_commit" | "after_commit" | "before_event" | "before_receipt";
export type PlannerEventContext = Pick<PlannerEvent, "date" | "at" | "source"> & Partial<Pick<PlannerEvent, "operationId" | "proposalId">> & { kind?: string };
type TransactionState = { callbacks: Array<() => void>; mutated: boolean; eventContext?: PlannerEventContext; active: boolean };
const activeNotionSenderInstances = new Set<string>();
export type ExecutionLedgerRecord = {
  operationId: string; requestDigest: string; proposalId: string; datasetEpoch: string;
  terminalStatus: "applied" | "no_change"; receipt: ExecutionReceipt | null;
};

/** One authoritative connection: repositories join the caller's transaction.
 * The separate execution ledger survives deletion of display history. */
export class SQLitePlannerStore implements PlannerArchiveStore {
  private readonly database: DatabaseSync;
  private readonly senderInstanceId = randomUUID();
  private readonly transactionContext = new AsyncLocalStorage<TransactionState>();
  private readonly transactionFrames = new AsyncLocalStorage<{ queue: Promise<unknown> }>();
  private transactionQueue: Promise<unknown> = Promise.resolve();
  private savepointCounter = 0;
  private failureInjector?: (point: StorageFailurePoint) => void;

  constructor(public readonly databasePath: string, options: { failureInjector?: (point: StorageFailurePoint) => void } = {}) {
    this.failureInjector = options.failureInjector;
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath, { timeout: 5_000 });
    activeNotionSenderInstances.add(this.senderInstanceId);
    try {
      this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      this.initializeSchema();
      this.recoverNotionSendingAfterRestart();
    } catch (error) { activeNotionSenderInstances.delete(this.senderInstanceId); this.database.close(); throw error; }
  }

  close() {
    // A process can keep running after this connection closes. Persist the
    // ambiguous HTTP outcome before removing the only live store instance;
    // PID liveness alone cannot reveal that the connection was closed.
    activeNotionSenderInstances.delete(this.senderInstanceId);
    try {
      if (this.database.prepare("SELECT 1 FROM notion_outbox WHERE status='sending' LIMIT 1").get()) {
        this.database.exec("BEGIN IMMEDIATE");
        try { this.recoverOrphanedNotionSends(); this.database.exec("COMMIT"); }
        catch (error) { this.database.exec("ROLLBACK"); throw error; }
      }
    } catch (error) {
      // Keep the store usable if SQLite could not persist the pause.
      activeNotionSenderInstances.add(this.senderInstanceId);
      throw error;
    }
    this.database.close();
  }
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

  async getNotionConnection(workspaceId: string): Promise<NotionConnection | undefined> {
    return this.one<NotionConnection>("SELECT payload FROM notion_connections WHERE workspace_id=?", workspaceId);
  }

  async listNotionConnections(): Promise<NotionConnection[]> {
    return this.many<NotionConnection>("SELECT payload FROM notion_connections ORDER BY workspace_id");
  }

  async putNotionConnection(value: NotionConnection): Promise<void> {
    const connection = notionConnectionSchema.parse(value);
    await this.transaction(async () => {
      const existing = await this.getNotionConnection(connection.workspaceId);
      if (existing && existing.installationId !== connection.installationId) {
        throw new Error("Notion workspace installation identity cannot change");
      }
      this.database.prepare(`INSERT INTO notion_connections(workspace_id,status,payload) VALUES(?,?,?)
        ON CONFLICT(workspace_id) DO UPDATE SET status=excluded.status,payload=excluded.payload`)
        .run(connection.workspaceId, connection.status, JSON.stringify(connection));
    });
  }

  async getNotionInitializationStep(workspaceId: string, step: NotionInitializationStepName): Promise<NotionInitializationStep | undefined> {
    return this.one<NotionInitializationStep>(
      "SELECT payload FROM notion_initialization_steps WHERE workspace_id=? AND step=?", workspaceId, step);
  }

  async listNotionInitializationSteps(workspaceId?: string): Promise<NotionInitializationStep[]> {
    return workspaceId
      ? this.many<NotionInitializationStep>("SELECT payload FROM notion_initialization_steps WHERE workspace_id=? ORDER BY rowid", workspaceId)
      : this.many<NotionInitializationStep>("SELECT payload FROM notion_initialization_steps ORDER BY workspace_id,rowid");
  }

  async putNotionInitializationStep(value: NotionInitializationStep): Promise<void> {
    const step = notionInitializationStepSchema.parse(value);
    await this.transaction(async () => {
      const connection = await this.getNotionConnection(step.workspaceId);
      if (!connection) throw new Error("Notion initialization workspace does not exist");
      const previous = await this.getNotionInitializationStep(step.workspaceId, step.step);
      if (previous && (previous.expectedTitle !== step.expectedTitle || previous.parentId !== step.parentId ||
        previous.schemaFingerprint !== step.schemaFingerprint || previous.attemptedAt !== step.attemptedAt ||
        (previous.status === "confirmed" && (step.status !== "confirmed" || step.remoteId !== previous.remoteId)))) {
        throw new Error("Notion initialization attempt identity cannot change");
      }
      this.database.prepare(`INSERT INTO notion_initialization_steps(workspace_id,step,status,payload) VALUES(?,?,?,?)
        ON CONFLICT(workspace_id,step) DO UPDATE SET status=excluded.status,payload=excluded.payload`)
        .run(step.workspaceId, step.step, step.status, JSON.stringify(step));
    });
  }

  async getNotionTaskMapping(localTaskId: string): Promise<NotionTaskMapping | undefined> {
    return this.one<NotionTaskMapping>("SELECT payload FROM notion_task_mappings WHERE local_task_id=?", localTaskId);
  }

  async listNotionTaskMappings(): Promise<NotionTaskMapping[]> {
    return this.many<NotionTaskMapping>("SELECT payload FROM notion_task_mappings ORDER BY local_task_id");
  }

  async putNotionTaskMapping(value: NotionTaskMapping): Promise<void> {
    const mapping = notionTaskMappingSchema.parse(value);
    await this.transaction(async () => {
      if (!await this.getTask(mapping.localTaskId)) throw new Error("Notion mapping task does not exist");
      const connection = await this.getNotionConnection(mapping.workspaceId);
      if (!connection) throw new Error("Notion mapping workspace does not exist");
      if (mapping.clientKey !== notionClientKey(connection.installationId, mapping.localTaskId)) {
        throw new Error("Notion mapping client key does not match the installation");
      }
      if (connection.dataSources.tasks && connection.dataSources.tasks.dataSourceId !== mapping.dataSourceId) {
        throw new Error("Notion mapping data source does not match the workspace schema");
      }
      const existing = await this.getNotionTaskMapping(mapping.localTaskId);
      if (existing && (existing.workspaceId !== mapping.workspaceId || existing.dataSourceId !== mapping.dataSourceId ||
        existing.clientKey !== mapping.clientKey ||
        (existing.remotePageId !== null && existing.remotePageId !== mapping.remotePageId))) {
        throw new Error("Notion mapping identity cannot change");
      }
      this.database.prepare(`INSERT INTO notion_task_mappings(local_task_id,workspace_id,data_source_id,remote_page_id,client_key,payload)
        VALUES(?,?,?,?,?,?) ON CONFLICT(local_task_id) DO UPDATE SET
        data_source_id=excluded.data_source_id,remote_page_id=excluded.remote_page_id,payload=excluded.payload`)
        .run(mapping.localTaskId, mapping.workspaceId, mapping.dataSourceId, mapping.remotePageId,
          mapping.clientKey, JSON.stringify(mapping));
    });
  }

  async getNotionOutboxOperation(operationId: string): Promise<NotionOutboxOperation | undefined> {
    return this.one<NotionOutboxOperation>("SELECT payload FROM notion_outbox WHERE operation_id=?", operationId);
  }

  async listNotionOutboxOperations(): Promise<NotionOutboxOperation[]> {
    return this.many<NotionOutboxOperation>("SELECT payload FROM notion_outbox ORDER BY created_at,operation_id");
  }

  /** Called inside the same outer transaction as the matching task command. */
  async enqueueNotionOutbox(value: NotionOutboxOperation): Promise<void> {
    const operation = notionOutboxOperationSchema.parse(value);
    if (operation.status !== "pending" || operation.attemptCount !== 0 || operation.lastAttemptAt !== null) {
      throw new Error("New Notion operation must be pending and unsent");
    }
    await this.transaction(async () => {
      const mapping = await this.getNotionTaskMapping(operation.localTaskId);
      if (!mapping || mapping.workspaceId !== operation.workspaceId) throw new Error("Notion operation mapping is missing");
      const currentVersion = await this.getPlanningVersion();
      if (currentVersion.datasetEpoch !== operation.datasetEpoch) throw new Error("Notion operation epoch is stale");
      if (JSON.stringify(mapping.baseline) !== JSON.stringify(operation.baseline)) {
        throw new Error("Notion operation baseline is stale");
      }
      await this.assertNotionOperationTaskState(operation);
      for (const older of this.many<NotionOutboxOperation>(
        "SELECT payload FROM notion_outbox WHERE local_task_id=? AND status='pending'", operation.localTaskId)) {
        this.updateNotionOutbox({ ...older, status: "superseded" });
      }
      this.database.prepare(`INSERT INTO notion_outbox(operation_id,local_task_id,workspace_id,dataset_epoch,status,created_at,payload)
        VALUES(?,?,?,?,?,?,?)`).run(operation.operationId, operation.localTaskId, operation.workspaceId,
          operation.datasetEpoch, operation.status, operation.createdAt, JSON.stringify(operation));
    });
  }

  /** Persist the send attempt before HTTP. An absent sender is unknown; a
   * second live API process must not reclaim its in-flight request. */
  async markNotionOutboxSending(operationId: string, at: string): Promise<NotionOutboxOperation> {
    if (this.transactionContext.getStore()?.active) throw new Error("Notion send claim must run outside a business transaction");
    // Recovery must commit separately. A later claim rejection must not roll
    // an orphaned attempt back to sending or reopen its workspace.
    await this.transaction(async () => { this.recoverOrphanedNotionSends(); });
    const claim = await this.transaction(async () => {
      const operation = await this.getNotionOutboxOperation(operationId);
      if (!operation || operation.status !== "pending") throw new Error("Notion operation is not pending");
      // The owner may have exited after the first committed recovery. Recheck
      // under the claim write lock; return a result rather than throwing so
      // the unknown transition and workspace pause are committed.
      if (this.recoverOrphanedNotionSends(operation.workspaceId)) return null;
      const connection = await this.getNotionConnection(operation.workspaceId);
      if (connection?.status !== "active") throw new Error("Notion connection is paused");
      const version = await this.getPlanningVersion();
      if (version.datasetEpoch !== operation.datasetEpoch) throw new Error("Notion operation epoch is stale");
      const mapping = await this.getNotionTaskMapping(operation.localTaskId);
      if (!mapping || mapping.workspaceId !== operation.workspaceId ||
        JSON.stringify(mapping.baseline) !== JSON.stringify(operation.baseline)) {
        throw new Error("Notion operation baseline is stale");
      }
      await this.assertNotionOperationTaskState(operation);
      const blocker = this.database.prepare(`SELECT 1 FROM notion_outbox WHERE local_task_id=?
        AND status IN ('sending','unknown','quarantined') LIMIT 1`).get(operation.localTaskId);
      if (blocker) throw new Error("Notion mapping has an unresolved send");
      if (this.database.prepare("SELECT 1 FROM notion_restore_quarantine WHERE workspace_id=? LIMIT 1").get(operation.workspaceId)) {
        throw new Error("Notion workspace has an unresolved pre-restore send");
      }
      const sending = notionOutboxOperationSchema.parse({
        ...operation, status: "sending", attemptCount: operation.attemptCount + 1, lastAttemptAt: at,
        sendingOwner: { pid: process.pid, instanceId: this.senderInstanceId },
      });
      this.updateNotionOutbox(sending);
      return sending;
    });
    if (claim === null) throw new Error("Notion connection is paused");
    return claim;
  }

  /** The caller has completed preflight but has not started HTTP. A later
   * committed intent can replace this attempt without creating an unknown
   * remote result or pausing the entire workspace. */
  async supersedeNotionUnsentIfNewer(operationId: string): Promise<boolean> {
    return this.transaction(async () => {
      const operation = await this.getNotionOutboxOperation(operationId);
      if (!operation || operation.status !== "sending") return false;
      const [newer] = this.many<NotionOutboxOperation>(
        "SELECT payload FROM notion_outbox WHERE local_task_id=? AND operation_id<>? AND status='pending'",
        operation.localTaskId, operationId);
      if (!newer || newer.workspaceId !== operation.workspaceId || newer.datasetEpoch !== operation.datasetEpoch) return false;
      const mapping = await this.getNotionTaskMapping(operation.localTaskId);
      if (!mapping || JSON.stringify(mapping.baseline) !== JSON.stringify(newer.baseline)) return false;
      await this.assertNotionOperationTaskState(newer);
      this.updateNotionOutbox({ ...operation, status: "superseded" });
      return true;
    });
  }

  /** Recheck after an asynchronous remote preflight. A restore may have fenced
   * or replaced this attempt while the provider was being read. */
  canDispatchNotionOutbox(operationId: string, datasetEpoch: string): boolean {
    // Keep this synchronous: the dispatcher calls the provider immediately
    // afterwards, with no event-loop turn where a restore could slip in.
    const operation = this.database.prepare("SELECT workspace_id,dataset_epoch,status FROM notion_outbox WHERE operation_id=?").get(operationId);
    if (!operation || operation.status !== "sending" || operation.dataset_epoch !== datasetEpoch) return false;
    const connection = this.database.prepare("SELECT status FROM notion_connections WHERE workspace_id=?").get(operation.workspace_id);
    const currentEpoch = this.database.prepare("SELECT value FROM metadata WHERE key='dataset_epoch'").get();
    return connection?.status === "active" && currentEpoch?.value === datasetEpoch;
  }

  async markNotionOutboxUnknown(operationId: string): Promise<void> {
    await this.transaction(async () => {
      const operation = await this.getNotionOutboxOperation(operationId);
      if (!operation || operation.status !== "sending") throw new Error("Notion operation is not sending");
      this.updateNotionOutbox({ ...operation, status: "unknown" });
      const connection = await this.getNotionConnection(operation.workspaceId);
      if (connection) await this.putNotionConnection({ ...connection, status: "paused_unknown", updatedAt: new Date().toISOString() });
    });
  }

  /** A provider read failed before any create or update request was sent.
   * Keep the intent retryable but pause the workspace for an explicit retry. */
  async pauseNotionUnsent(operationId: string, at: string): Promise<boolean> {
    return this.transaction(async () => {
      const operation = await this.getNotionOutboxOperation(operationId);
      if (!operation || operation.status !== "sending") return false;
      const connection = await this.getNotionConnection(operation.workspaceId);
      if (!connection || connection.status !== "active" ||
        (await this.getPlanningVersion()).datasetEpoch !== operation.datasetEpoch) return false;
      this.updateNotionOutbox({ ...operation, status: "pending", sendingOwner: undefined });
      await this.putNotionConnection({ ...connection, status: "paused", updatedAt: at });
      return true;
    });
  }

  /** Rebase one claimed intent after remote fields and the local business
   * merge have been committed in the same outer transaction. */
  async rebaseNotionSending(
    operationId: string,
    remote: NotionTaskFields,
    merged: NotionTaskFields,
    at: string,
  ): Promise<NotionOutboxOperation> {
    const baseline = notionTaskFieldsSchema.parse(remote);
    const desired = notionTaskFieldsSchema.parse(merged);
    return this.transaction(async () => {
      const operation = await this.getNotionOutboxOperation(operationId);
      if (!operation || operation.status !== "sending") throw new Error("Notion operation is not sending");
      if ((await this.getNotionConnection(operation.workspaceId))?.status !== "active") {
        throw new Error("Notion workspace was paused during preflight");
      }
      if ((await this.getPlanningVersion()).datasetEpoch !== operation.datasetEpoch) {
        throw new Error("Notion operation epoch changed during preflight");
      }
      const mapping = await this.getNotionTaskMapping(operation.localTaskId);
      if (!mapping || mapping.workspaceId !== operation.workspaceId || mapping.remotePageId === null ||
        JSON.stringify(mapping.baseline) !== JSON.stringify(operation.baseline)) {
        throw new Error("Notion mapping changed during preflight");
      }
      const next = notionOutboxOperationSchema.parse({ ...operation, baseline, desired });
      await this.assertNotionOperationTaskState(next);
      await this.putNotionTaskMapping({ ...mapping, baseline, updatedAt: at });
      this.updateNotionOutbox(next);
      return next;
    });
  }

  /** A write is confirmed only after reading the exact desired fields back. */
  async confirmNotionOutbox(operationId: string, remotePageId: string, readBack: NotionTaskFields, at: string): Promise<"confirmed" | "unknown" | "quarantined"> {
    const confirmedFields = notionTaskFieldsSchema.parse(readBack);
    if (!remotePageId) throw new Error("Notion read-back page ID is missing");
    return this.transaction(async () => {
      const operation = await this.getNotionOutboxOperation(operationId);
      if (!operation || !["sending", "unknown"].includes(operation.status)) throw new Error("Notion operation has no send attempt");
      const connection = await this.getNotionConnection(operation.workspaceId);
      if (!connection) throw new Error("Notion operation workspace is missing");
      if ((await this.getPlanningVersion()).datasetEpoch !== operation.datasetEpoch) {
        this.updateNotionOutbox({ ...operation, status: "quarantined" });
        await this.putNotionConnection({ ...connection, status: "paused_unknown", updatedAt: at });
        return "quarantined";
      }
      if (JSON.stringify(confirmedFields) !== JSON.stringify(operation.desired)) {
        this.updateNotionOutbox({ ...operation, status: "unknown" });
        await this.putNotionConnection({ ...connection, status: "paused_unknown", updatedAt: at });
        return "unknown";
      }
      const mapping = await this.getNotionTaskMapping(operation.localTaskId);
      if (!mapping || mapping.workspaceId !== operation.workspaceId ||
        (mapping.remotePageId !== null && mapping.remotePageId !== remotePageId)) {
        throw new Error("Notion operation mapping changed");
      }
      await this.putNotionTaskMapping({ ...mapping, remotePageId, baseline: confirmedFields, status: "active", updatedAt: at });
      this.updateNotionOutbox({ ...operation, status: "confirmed", confirmedAt: at });
      // A newer local intent may have arrived while this HTTP request was in
      // flight. Its comparison point is now the fields we actually read back.
      for (const pending of this.many<NotionOutboxOperation>(
        "SELECT payload FROM notion_outbox WHERE local_task_id=? AND status='pending'", operation.localTaskId)) {
        this.updateNotionOutbox(JSON.stringify(pending.desired) === JSON.stringify(confirmedFields)
          ? { ...pending, baseline: confirmedFields, status: "confirmed", confirmedAt: at }
          : { ...pending, baseline: confirmedFields });
      }
      return "confirmed";
    });
  }

  async appendNotionConflict(value: NotionConflictRecord): Promise<void> {
    const conflict = notionConflictRecordSchema.parse(value);
    await this.transaction(async () => {
      const mapping = await this.getNotionTaskMapping(conflict.localTaskId);
      if (!mapping || mapping.workspaceId !== conflict.workspaceId) throw new Error("Notion conflict mapping is missing");
      this.database.prepare("INSERT INTO notion_conflicts(id,local_task_id,workspace_id,payload) VALUES(?,?,?,?)")
        .run(conflict.id, conflict.localTaskId, conflict.workspaceId, JSON.stringify(conflict));
    });
  }

  async listNotionConflicts(): Promise<NotionConflictRecord[]> {
    return this.many<unknown>("SELECT payload FROM notion_conflicts ORDER BY rowid")
      .map((value) => notionConflictRecordSchema.parse(value));
  }

  async listNotionScanWatermarks(): Promise<NotionScanWatermark[]> {
    return this.many<NotionScanWatermark>("SELECT payload FROM notion_scan_watermarks ORDER BY workspace_id,data_source_id");
  }

  async listNotionReadNodes(workspaceId?: string): Promise<NotionReadNode[]> {
    return workspaceId
      ? this.many<NotionReadNode>("SELECT payload FROM notion_read_nodes WHERE workspace_id=? ORDER BY data_source_id,remote_page_id", workspaceId)
      : this.many<NotionReadNode>("SELECT payload FROM notion_read_nodes ORDER BY workspace_id,data_source_id,remote_page_id");
  }

  async replaceNotionReadNodes(workspaceId: string, dataSourceId: string, values: NotionReadNode[]): Promise<void> {
    const nodes = values.map((value) => notionReadNodeSchema.parse(value));
    if (nodes.some((node) => node.workspaceId !== workspaceId || node.dataSourceId !== dataSourceId)) {
      throw new Error("Notion read nodes have a different namespace");
    }
    await this.transaction(async () => {
      this.database.prepare("DELETE FROM notion_read_nodes WHERE workspace_id=? AND data_source_id=?").run(workspaceId, dataSourceId);
      const insert = this.database.prepare("INSERT INTO notion_read_nodes(workspace_id,data_source_id,remote_page_id,payload) VALUES(?,?,?,?)");
      for (const node of nodes) insert.run(node.workspaceId, node.dataSourceId, node.remotePageId, JSON.stringify(node));
    });
  }

  async listNotionReadTaskContexts(): Promise<NotionReadTaskContext[]> {
    return this.many<NotionReadTaskContext>("SELECT payload FROM notion_read_task_contexts ORDER BY local_task_id");
  }

  async putNotionReadTaskContext(value: NotionReadTaskContext): Promise<void> {
    const context = notionReadTaskContextSchema.parse(value);
    await this.transaction(async () => {
      const mapping = await this.getNotionTaskMapping(context.localTaskId);
      if (!mapping || mapping.workspaceId !== context.workspaceId || mapping.remotePageId !== context.remotePageId) {
        throw new Error("Notion task context has no matching mapping");
      }
      this.database.prepare(`INSERT INTO notion_read_task_contexts(local_task_id,workspace_id,payload) VALUES(?,?,?)
        ON CONFLICT(local_task_id) DO UPDATE SET payload=excluded.payload`)
        .run(context.localTaskId, context.workspaceId, JSON.stringify(context));
    });
  }

  async listNotionRestoreQuarantine(): Promise<NotionRestoreQuarantine[]> {
    return this.many<NotionRestoreQuarantine>("SELECT payload FROM notion_restore_quarantine ORDER BY source_epoch,operation_id");
  }

  async putNotionScanWatermark(value: NotionScanWatermark): Promise<void> {
    const watermark = notionScanWatermarkSchema.parse(value);
    await this.transaction(async () => {
      if (!await this.getNotionConnection(watermark.workspaceId)) throw new Error("Notion scan workspace does not exist");
      this.database.prepare(`INSERT INTO notion_scan_watermarks(workspace_id,data_source_id,payload) VALUES(?,?,?)
        ON CONFLICT(workspace_id,data_source_id) DO UPDATE SET payload=excluded.payload`)
        .run(watermark.workspaceId, watermark.dataSourceId, JSON.stringify(watermark));
    });
  }

  async listNotionSyncData(): Promise<NotionSyncArchive> {
    return {
      version: 1,
      connections: await this.listNotionConnections(),
      initializationSteps: await this.listNotionInitializationSteps(),
      taskMappings: await this.listNotionTaskMappings(),
      outbox: await this.listNotionOutboxOperations(),
      conflicts: await this.listNotionConflicts(),
      watermarks: await this.listNotionScanWatermarks(),
      readNodes: await this.listNotionReadNodes(),
      readTaskContexts: await this.listNotionReadTaskContexts(),
      restoreQuarantine: await this.listNotionRestoreQuarantine(),
    };
  }

  /** Committed before archive replacement so no later claim can start. */
  async pauseNotionForRestore(): Promise<void> {
    await this.transaction(async () => {
      const at = new Date().toISOString();
      this.database.prepare(`UPDATE notion_connections SET status='paused_after_restore',
        payload=json_set(payload,'$.status','paused_after_restore','$.updatedAt',?)`).run(at);
    });
  }

  /** The restore fence is already committed. Let known HTTP attempts finish;
   * a timeout leaves their durable sending records for quarantine. */
  async waitForNotionSendingToSettle(timeoutMs: number): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid Notion drain timeout");
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const sending = this.database.prepare("SELECT 1 FROM notion_outbox WHERE status='sending' LIMIT 1").get();
      if (!sending) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    }
  }

  private updateNotionOutbox(value: NotionOutboxOperation) {
    const operation = notionOutboxOperationSchema.parse(value);
    this.database.prepare("UPDATE notion_outbox SET status=?,payload=? WHERE operation_id=?")
      .run(operation.status, JSON.stringify(operation), operation.operationId);
  }

  private async assertNotionOperationTaskState(operation: NotionOutboxOperation) {
    const task = await this.getTask(operation.localTaskId);
    if (!task || task.title !== operation.desired.title || task.startDate !== (operation.desired.date?.[0] ?? null) ||
      task.endDate !== (operation.desired.date?.[1] ?? null) || (task.status === "completed") !== operation.desired.completed) {
      throw new Error("Notion operation does not match the committed task");
    }
  }

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
    const sync = notionSyncArchiveSchema.parse(data.notionSync ?? emptyNotionSyncArchive());
    await this.transaction(async () => {
      const quarantinedAt = new Date().toISOString();
      // A replacement backup may contain no Notion records even though this
      // installation has already attempted remote creation. Keep that local
      // identity fenced until a person reconciles the existing remote objects.
      const priorSteps = await this.listNotionInitializationSteps();
      const importedWorkspaces = new Set(sync.connections.map((connection) => connection.workspaceId));
      const orphanedStructures = (await this.listNotionConnections()).filter((connection) =>
        !importedWorkspaces.has(connection.workspaceId) && (connection.rootPageId !== null ||
          Object.keys(connection.dataSources).length > 0 ||
          priorSteps.some((step) => step.workspaceId === connection.workspaceId) ||
          connection.status === "paused_after_restore" || connection.status === "paused_unknown"));
      for (const operation of this.many<NotionOutboxOperation>(
        "SELECT payload FROM notion_outbox WHERE status IN ('sending','unknown','quarantined')")) {
        const mapping = await this.getNotionTaskMapping(operation.localTaskId);
        if (!mapping) throw new Error("Notion unresolved send lost its mapping");
        this.putNotionRestoreQuarantine({ operation, mapping, quarantinedAt });
      }
      await this.rotateDatasetEpoch();
      this.database.exec("DELETE FROM notion_read_task_contexts; DELETE FROM notion_read_nodes; DELETE FROM notion_scan_watermarks; DELETE FROM notion_conflicts; DELETE FROM notion_outbox; DELETE FROM notion_task_mappings; DELETE FROM notion_initialization_steps; DELETE FROM notion_connections;");
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
      for (const connection of sync.connections) {
        await this.putNotionConnection({ ...connection, status: "paused_after_restore", updatedAt: quarantinedAt });
      }
      for (const step of sync.initializationSteps ?? []) await this.putNotionInitializationStep(step);
      for (const connection of orphanedStructures) {
        await this.putNotionConnection({ ...connection, status: "paused_after_restore", updatedAt: quarantinedAt });
        for (const step of priorSteps.filter((item) => item.workspaceId === connection.workspaceId)) {
          await this.putNotionInitializationStep(step);
        }
      }
      for (const mapping of sync.taskMappings) await this.putNotionTaskMapping(mapping);
      for (const operation of sync.outbox) {
        const restored: NotionOutboxOperation = ["confirmed", "superseded"].includes(operation.status)
          ? operation : { ...operation, status: "quarantined" };
        this.database.prepare(`INSERT INTO notion_outbox(operation_id,local_task_id,workspace_id,dataset_epoch,status,created_at,payload)
          VALUES(?,?,?,?,?,?,?)`).run(restored.operationId, restored.localTaskId, restored.workspaceId,
            restored.datasetEpoch, restored.status, restored.createdAt, JSON.stringify(restored));
      }
      for (const conflict of sync.conflicts) await this.appendNotionConflict(conflict);
      for (const watermark of sync.watermarks) await this.putNotionScanWatermark(watermark);
      for (const node of sync.readNodes ?? []) {
        this.database.prepare("INSERT INTO notion_read_nodes(workspace_id,data_source_id,remote_page_id,payload) VALUES(?,?,?,?)")
          .run(node.workspaceId, node.dataSourceId, node.remotePageId, JSON.stringify(node));
      }
      for (const context of sync.readTaskContexts ?? []) await this.putNotionReadTaskContext(context);
      for (const item of sync.restoreQuarantine) this.putNotionRestoreQuarantine(item);
      await this.recordMutation("dataset_replaced");
    });
  }

  private putNotionRestoreQuarantine(value: NotionRestoreQuarantine) {
    const item = notionRestoreQuarantineSchema.parse(value);
    const previous = this.one<NotionRestoreQuarantine>(
      "SELECT payload FROM notion_restore_quarantine WHERE source_epoch=? AND operation_id=?",
      item.operation.datasetEpoch, item.operation.operationId);
    if (previous) {
      if (JSON.stringify(previous.operation) !== JSON.stringify(item.operation) ||
        JSON.stringify(previous.mapping) !== JSON.stringify(item.mapping)) {
        throw new Error("Notion restore quarantine identity collision");
      }
      return;
    }
    this.database.prepare(`INSERT INTO notion_restore_quarantine(source_epoch,operation_id,workspace_id,local_task_id,payload)
      VALUES(?,?,?,?,?)`).run(item.operation.datasetEpoch, item.operation.operationId,
        item.operation.workspaceId, item.operation.localTaskId, JSON.stringify(item));
  }

  /** This marker survives replacement so old browser data cannot overwrite a restore. */
  async importBrowserData(data: PlannerArchiveData, hash: string) {
    return this.transaction(async () => {
      const imported = this.database.prepare("SELECT value FROM metadata WHERE key = 'browser_import_hash'").get();
      if (imported) return imported.value === hash ? "already-imported" as const : "server-not-empty" as const;
      const counts = this.database.prepare("SELECT (SELECT COUNT(*) FROM tasks)+(SELECT COUNT(*) FROM recurrence_series)+(SELECT COUNT(*) FROM focus_records)+(SELECT COUNT(*) FROM life_inbox)+(SELECT COUNT(*) FROM life_folders)+(SELECT COUNT(*) FROM life_resources)+(SELECT COUNT(*) FROM notion_connections) AS count").get();
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
    if (version > 6) throw new Error("This database was created by a newer version of NewDay");
    if (version < 3) {
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
    if (version < 4) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          CREATE TABLE notion_connections (
            workspace_id TEXT PRIMARY KEY NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('disconnected','active','paused','paused_after_restore','paused_unknown')),
            payload TEXT NOT NULL CHECK(json_valid(payload))
          ) STRICT;
          CREATE TABLE notion_task_mappings (
            local_task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
            workspace_id TEXT NOT NULL REFERENCES notion_connections(workspace_id) ON DELETE RESTRICT,
            data_source_id TEXT NOT NULL,
            remote_page_id TEXT,
            client_key TEXT NOT NULL,
            payload TEXT NOT NULL CHECK(json_valid(payload)),
            UNIQUE(workspace_id,client_key)
          ) STRICT;
          CREATE UNIQUE INDEX notion_task_mapping_remote ON notion_task_mappings(workspace_id,data_source_id,remote_page_id)
            WHERE remote_page_id IS NOT NULL;
          CREATE TABLE notion_outbox (
            operation_id TEXT PRIMARY KEY NOT NULL,
            local_task_id TEXT NOT NULL REFERENCES notion_task_mappings(local_task_id) ON DELETE RESTRICT,
            workspace_id TEXT NOT NULL REFERENCES notion_connections(workspace_id) ON DELETE RESTRICT,
            dataset_epoch TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','sending','unknown','confirmed','superseded','quarantined')),
            created_at TEXT NOT NULL,
            payload TEXT NOT NULL CHECK(json_valid(payload))
          ) STRICT;
          CREATE INDEX notion_outbox_ready ON notion_outbox(workspace_id,status,created_at);
          CREATE INDEX notion_outbox_by_task ON notion_outbox(local_task_id,status);
          CREATE TABLE notion_conflicts (
            id TEXT PRIMARY KEY NOT NULL,
            local_task_id TEXT NOT NULL REFERENCES notion_task_mappings(local_task_id) ON DELETE RESTRICT,
            workspace_id TEXT NOT NULL REFERENCES notion_connections(workspace_id) ON DELETE RESTRICT,
            payload TEXT NOT NULL CHECK(json_valid(payload))
          ) STRICT;
          CREATE TABLE notion_scan_watermarks (
            workspace_id TEXT NOT NULL REFERENCES notion_connections(workspace_id) ON DELETE RESTRICT,
            data_source_id TEXT NOT NULL,
            payload TEXT NOT NULL CHECK(json_valid(payload)),
            PRIMARY KEY(workspace_id,data_source_id)
          ) STRICT;
          CREATE TABLE notion_restore_quarantine (
            source_epoch TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            local_task_id TEXT NOT NULL,
            payload TEXT NOT NULL CHECK(json_valid(payload)),
            PRIMARY KEY(source_epoch,operation_id)
          ) STRICT;
          CREATE INDEX notion_restore_quarantine_by_mapping ON notion_restore_quarantine(workspace_id,local_task_id);
          PRAGMA user_version=4;
          COMMIT;
        `);
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    }
    if (version < 5) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS notion_initialization_steps (
            workspace_id TEXT NOT NULL REFERENCES notion_connections(workspace_id) ON DELETE RESTRICT,
            step TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('attempted','needs_review','confirmed')),
            payload TEXT NOT NULL CHECK(json_valid(payload)),
            PRIMARY KEY(workspace_id,step)
          ) STRICT;
          PRAGMA user_version=5;
          COMMIT;
        `);
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    }
    if (version < 6) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          CREATE TABLE notion_read_nodes (
            workspace_id TEXT NOT NULL REFERENCES notion_connections(workspace_id) ON DELETE RESTRICT,
            data_source_id TEXT NOT NULL,
            remote_page_id TEXT NOT NULL,
            payload TEXT NOT NULL CHECK(json_valid(payload)),
            PRIMARY KEY(workspace_id,data_source_id,remote_page_id)
          ) STRICT;
          CREATE TABLE notion_read_task_contexts (
            local_task_id TEXT PRIMARY KEY NOT NULL REFERENCES notion_task_mappings(local_task_id) ON DELETE RESTRICT,
            workspace_id TEXT NOT NULL REFERENCES notion_connections(workspace_id) ON DELETE RESTRICT,
            payload TEXT NOT NULL CHECK(json_valid(payload))
          ) STRICT;
          PRAGMA user_version=6;
          COMMIT;
        `);
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    }
  }

  private recoverNotionSendingAfterRestart() {
    const hasSending = this.database.prepare("SELECT 1 FROM notion_outbox WHERE status='sending' LIMIT 1").get();
    if (!hasSending) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.recoverOrphanedNotionSends();
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  /** Caller holds a SQLite write transaction. A live process owns its HTTP
   * attempt; an absent owner is an ambiguous result that blocks later sends. */
  private recoverOrphanedNotionSends(workspaceId?: string): boolean {
    const at = new Date().toISOString();
    const orphanedWorkspaces = new Set<string>();
    const query = workspaceId
      ? this.many<unknown>("SELECT payload FROM notion_outbox WHERE status='sending' AND workspace_id=?", workspaceId)
      : this.many<unknown>("SELECT payload FROM notion_outbox WHERE status='sending'");
    for (const raw of query) {
      const operation = notionOutboxOperationSchema.parse(raw);
      if (isNotionSenderLive(operation.sendingOwner)) continue;
      this.updateNotionOutbox({ ...operation, status: "unknown" });
      orphanedWorkspaces.add(operation.workspaceId);
    }
    for (const workspaceId of orphanedWorkspaces) {
      this.database.prepare(`UPDATE notion_connections SET status='paused_unknown',
        payload=json_set(payload,'$.status','paused_unknown','$.updatedAt',?)
        WHERE workspace_id=? AND status IN ('active','paused')`).run(at, workspaceId);
    }
    return orphanedWorkspaces.size > 0;
  }
}

function isNotionSenderLive(owner: NotionOutboxOperation["sendingOwner"]): boolean {
  if (!owner) return false;
  if (owner.pid === process.pid) return activeNotionSenderInstances.has(owner.instanceId);
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** In-memory SQLite retains exactly the transaction semantics of the file store. */
export class MemoryAgentStore extends SQLitePlannerStore { constructor() { super(":memory:"); } }
