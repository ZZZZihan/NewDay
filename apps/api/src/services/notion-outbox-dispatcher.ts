import { randomUUID } from "node:crypto";

import { clearUndoReceipts } from "@newday/core/application/planner-undo";
import { reconcileNotionTask } from "@newday/core/application/notion-sync-reconcile";
import { AGENT_NAMESPACES, dateInTimeZone, type AgentPreferences } from "@newday/core/contracts/agent-planning";
import { taskSchema } from "@newday/core/domain/planner-model";
import {
  notionTaskFieldsSchema,
  type NotionFieldConflict,
  type NotionConnection,
  type NotionOutboxOperation,
  type NotionTaskFields,
  type NotionTaskMapping,
} from "@newday/core/contracts/notion-sync";

import type { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";

export type NotionTaskPage = {
  workspaceId: string;
  dataSourceId: string;
  remotePageId: string;
  clientKey: string | null;
  rulePageId?: string;
  occurrenceKey?: string;
  fields: NotionTaskFields;
  inTrash: boolean;
};

/** A transport must fully read the key search before returning complete=true. */
export interface NotionTaskTransport {
  findByClientKey(connection: NotionConnection, mapping: NotionTaskMapping): Promise<{
    complete: boolean;
    pages: NotionTaskPage[];
  }>;
  readPage(connection: NotionConnection, mapping: NotionTaskMapping): Promise<NotionTaskPage | null>;
  createPage(connection: NotionConnection, mapping: NotionTaskMapping, fields: NotionTaskFields): Promise<void>;
  /** Only the locally changed properties may be sent in one PATCH. */
  updatePage(connection: NotionConnection, mapping: NotionTaskMapping, patch: Partial<NotionTaskFields>): Promise<void>;
}

/** The transport proves that no page write was attempted. */
export class NotionWritePreflightFailure extends Error {}

type DispatchResult = "confirmed" | "unknown" | "quarantined" | "superseded" | "paused";

/** Serializes one local process; SQLite fences unresolved sends across restarts. */
export class NotionOutboxDispatcher {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: SQLitePlannerStore,
    private readonly transport: NotionTaskTransport,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** One dispatcher serializes its writes. SQLite also blocks unresolved sends
   * per mapping, including across a process restart. */
  dispatch(operationId: string): Promise<DispatchResult> {
    const result = this.tail.then(() => this.dispatchOne(operationId));
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Unknown attempts are read-only. A missing search result cannot prove that
   * a remote create did not happen, so this method never retries the write. */
  reconcileUnknown(operationId: string): Promise<DispatchResult> {
    const result = this.tail.then(() => this.reconcileOne(operationId));
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async dispatchOne(operationId: string): Promise<DispatchResult> {
    let operation = await this.store.markNotionOutboxSending(operationId, this.now());
    const connection = await this.store.getNotionConnection(operation.workspaceId);
    let mapping = await this.store.getNotionTaskMapping(operation.localTaskId);
    if (!connection || !mapping) return this.markUnknownOrQuarantined(operation);

    let before: Awaited<ReturnType<NotionOutboxDispatcher["readTarget"]>>;
    try { before = await this.readTarget(connection, mapping); }
    catch (error) { return this.pauseBeforeWrite(operation, error); }
    if (before === "uncertain") return this.markUnknownOrQuarantined(operation);
    if (before && sameFields(before.fields, operation.desired)) return this.confirmOrQuarantine(operation, before);
    try {
      if (await this.store.supersedeNotionUnsentIfNewer(operation.operationId)) return "superseded";
    } catch { return this.markUnknownOrQuarantined(operation); }

    if (mapping.remotePageId === null) {
      if (before !== null || !this.store.canDispatchNotionOutbox(operation.operationId, operation.datasetEpoch)) {
        if (before === null && await this.store.deferNotionUnsentAfterManualPause(operation.operationId, operation.datasetEpoch)) return "paused";
        return this.markUnknownOrQuarantined(operation);
      }
      try { await this.transport.createPage(connection, mapping, operation.desired); }
      catch (error) {
        if (error instanceof NotionWritePreflightFailure) return this.pauseBeforeWrite(operation, error);
        // The page write may have committed before its response was lost.
      }
      return this.readBackAndConfirm(operation, connection, mapping);
    }

    if (!before || !mapping.baseline) return this.markUnknownOrQuarantined(operation);
    if (!sameFields(before.fields, mapping.baseline)) {
      const resolution = reconcileNotionTask({
        baseline: mapping.baseline, local: operation.desired, remote: before.fields,
      });
      try {
        const merged = await this.applyPreflightMerge(operation, mapping, before.fields,
          resolution.merged, resolution.conflicts);
        if (merged === "superseded") return merged;
        operation = merged;
        mapping = (await this.store.getNotionTaskMapping(operation.localTaskId))!;
      } catch {
        if (await this.store.deferNotionUnsentAfterManualPause(operation.operationId, operation.datasetEpoch)) return "paused";
        return this.markUnknownOrQuarantined(operation);
      }
    }
    if (sameFields(before.fields, operation.desired)) return this.confirmOrQuarantine(operation, before);
    if (!this.store.canDispatchNotionOutbox(operation.operationId, operation.datasetEpoch)) {
      if (await this.store.deferNotionUnsentAfterManualPause(operation.operationId, operation.datasetEpoch)) return "paused";
      return this.markUnknownOrQuarantined(operation);
    }
    const patch = reconcileNotionTask({
      baseline: before.fields, local: operation.desired, remote: before.fields,
    }).remotePatch;
    if (Object.keys(patch).length === 0) return this.markUnknownOrQuarantined(operation);
    try { await this.transport.updatePage(connection, mapping, patch); }
    catch (error) {
      if (error instanceof NotionWritePreflightFailure) return this.pauseBeforeWrite(operation, error);
      // Read back before treating an attempted write as failed.
    }
    return this.readBackAndConfirm(operation, connection, mapping);
  }

  private async reconcileOne(operationId: string): Promise<DispatchResult> {
    const operation = await this.store.getNotionOutboxOperation(operationId);
    if (!operation || operation.status !== "unknown") throw new Error("Notion operation is not unknown");
    const connection = await this.store.getNotionConnection(operation.workspaceId);
    const mapping = await this.store.getNotionTaskMapping(operation.localTaskId);
    if (!connection || !mapping) return this.quarantineIfRestored(operation);
    return this.readBackAndConfirm(operation, connection, mapping);
  }

  private async readBackAndConfirm(
    operation: NotionOutboxOperation,
    connection: NotionConnection,
    mapping: NotionTaskMapping,
  ): Promise<DispatchResult> {
    try {
      const after = await this.readTarget(connection, mapping);
      if (after && after !== "uncertain" && sameFields(after.fields, operation.desired)) {
        return this.confirmOrQuarantine(operation, after);
      }
    } catch { /* Keep the persisted attempt unknown. */ }
    return this.markUnknownOrQuarantined(operation);
  }

  private async readTarget(
    connection: NotionConnection,
    mapping: NotionTaskMapping,
  ): Promise<NotionTaskPage | null | "uncertain"> {
    if (mapping.remotePageId !== null) {
      const page = await this.transport.readPage(connection, mapping);
      if (!page || page.inTrash || page.workspaceId !== mapping.workspaceId ||
        page.dataSourceId !== mapping.dataSourceId || page.remotePageId !== mapping.remotePageId ||
        page.rulePageId !== mapping.rulePageId || page.occurrenceKey !== mapping.occurrenceKey ||
        (page.clientKey !== null && page.clientKey !== mapping.clientKey)) {
        return "uncertain";
      }
      return { ...page, fields: notionTaskFieldsSchema.parse(page.fields) };
    }
    const result = await this.transport.findByClientKey(connection, mapping);
    if (!result.complete || result.pages.length > 1) return "uncertain";
    const page = result.pages[0];
    if (!page) return null;
    if (page.inTrash || page.workspaceId !== mapping.workspaceId || page.dataSourceId !== mapping.dataSourceId ||
      !page.remotePageId || page.clientKey !== mapping.clientKey ||
      page.rulePageId !== mapping.rulePageId || page.occurrenceKey !== mapping.occurrenceKey) return "uncertain";
    return { ...page, fields: notionTaskFieldsSchema.parse(page.fields) };
  }

  private async applyPreflightMerge(
    operation: NotionOutboxOperation,
    mapping: NotionTaskMapping,
    remote: NotionTaskFields,
    merged: NotionTaskFields,
    conflicts: NotionFieldConflict[],
  ): Promise<NotionOutboxOperation | "superseded"> {
    const at = this.now();
    return this.store.transaction(async () => {
      if (!this.store.canDispatchNotionOutbox(operation.operationId, operation.datasetEpoch)) {
        throw new Error("Notion send was fenced during preflight");
      }
      const task = await this.store.getTask(operation.localTaskId);
      if (!task || !sameFields({
        title: task.title, date: task.startDate === null || task.endDate === null ? null : [task.startDate, task.endDate], completed: task.status === "completed",
      }, operation.desired)) {
        // A newer local command can commit after the earlier preflight check.
        // This transaction still holds the send before any external HTTP.
        if (await this.store.supersedeNotionUnsentIfNewer(operation.operationId)) return "superseded";
        throw new Error("Local task changed during Notion preflight");
      }
      const changed = task.title !== merged.title || task.startDate !== (merged.date?.[0] ?? null) ||
        task.endDate !== (merged.date?.[1] ?? null) || (task.status === "completed") !== merged.completed;
      if (changed) {
        const next = taskSchema.parse({ ...task, title: merged.title,
          startDate: merged.date?.[0] ?? null, endDate: merged.date?.[1] ?? null,
          status: merged.completed ? "completed" : "open",
          completedAt: merged.completed && task.status === "completed" ? task.completedAt : null,
          completedOn: merged.completed && task.status === "completed" ? task.completedOn : null,
          updatedAt: at });
        if (task.startDate !== next.startDate || task.endDate !== next.endDate || task.status !== next.status) {
          for (const record of await this.store.listFocusRecordsForTask(task.id)) await this.store.deleteFocusRecord(record.id);
        }
        const preferences = await this.store.getAgentRecord<AgentPreferences>(AGENT_NAMESPACES.preferences, "current");
        const apply = () => this.store.putTask(next);
        if (preferences?.timeZone) await this.store.withEventContext({
          date: dateInTimeZone(new Date(at), preferences.timeZone), at, source: "system", kind: "notion_observed",
        }, apply);
        else await apply();
        clearUndoReceipts(this.store);
      }
      const rebased = await this.store.rebaseNotionSending(operation.operationId, remote, merged, at);
      for (const conflict of conflicts) {
        await this.store.appendNotionConflict({
          id: randomUUID(), localTaskId: mapping.localTaskId, workspaceId: mapping.workspaceId,
          field: conflict.field, baseline: conflict.baseline, local: conflict.local,
          remote: conflict.remote, winner: "notion", recordedAt: at,
        });
      }
      return rebased;
    });
  }

  private async confirmOrQuarantine(operation: NotionOutboxOperation, page: NotionTaskPage): Promise<DispatchResult> {
    try {
      return await this.store.confirmNotionOutbox(operation.operationId, page.remotePageId, page.fields, this.now());
    } catch {
      return this.quarantineIfRestored(operation);
    }
  }

  private async markUnknownOrQuarantined(operation: NotionOutboxOperation): Promise<DispatchResult> {
    try {
      const current = await this.store.getNotionOutboxOperation(operation.operationId);
      if (current?.status === "sending") await this.store.markNotionOutboxUnknown(operation.operationId);
      if (current?.status === "unknown") return "unknown";
      if (current?.status === "sending") return "unknown";
      return this.quarantineIfRestored(operation);
    } catch {
      return this.quarantineIfRestored(operation);
    }
  }

  private async pauseBeforeWrite(operation: NotionOutboxOperation, error: unknown): Promise<DispatchResult> {
    try {
      const at = this.now();
      if (await this.store.pauseNotionUnsent(operation.operationId, at, retryAfterAt(error, at))) return "paused";
      return this.quarantineIfRestored(operation);
    } catch { return this.markUnknownOrQuarantined(operation); }
  }

  private async quarantineIfRestored(operation: NotionOutboxOperation): Promise<DispatchResult> {
    const old = (await this.store.listNotionRestoreQuarantine()).some((item) =>
      item.operation.datasetEpoch === operation.datasetEpoch && item.operation.operationId === operation.operationId);
    if (old) return "quarantined";
    throw new Error("Notion operation changed during dispatch; manual reconciliation required");
  }
}

/** Rate-limit responses received before a page write have not changed the
 * remote page. Keep their Retry-After deadline durable across API restarts. */
function retryAfterAt(error: unknown, at: string): string | undefined {
  const response = error && typeof error === "object" ? error : null;
  const status = response && "status" in response ? Number(response.status) : NaN;
  if (status !== 429 && status !== 529) return undefined;
  const headers = response && "headers" in response ? response.headers : null;
  const raw = headers && typeof headers === "object" && "get" in headers && typeof headers.get === "function"
    ? String(headers.get("retry-after") ?? "").trim() : "";
  const now = Date.parse(at);
  const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const parsed = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(raw);
  const deadline = Number.isFinite(parsed) && parsed > now && parsed <= 8_640_000_000_000_000
    ? parsed : now + 5000;
  return new Date(deadline).toISOString();
}

function sameFields(left: NotionTaskFields, right: NotionTaskFields) {
  const a = notionTaskFieldsSchema.parse(left);
  const b = notionTaskFieldsSchema.parse(right);
  return a.title === b.title && a.completed === b.completed &&
    (a.date === null || b.date === null
      ? a.date === b.date
      : a.date[0] === b.date[0] && a.date[1] === b.date[1]);
}
