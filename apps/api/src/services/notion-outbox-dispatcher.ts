import { randomUUID } from "node:crypto";

import { executePlannerCommandsWithoutUndo, type PlannerCommand } from "@newday/core/application/planner-command";
import { reconcileNotionTask } from "@newday/core/application/notion-sync-reconcile";
import { AGENT_NAMESPACES, dateInTimeZone, type AgentPreferences } from "@newday/core/contracts/agent-planning";
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

type DispatchResult = "confirmed" | "unknown" | "quarantined" | "superseded";

/** The product has no transport adapter yet. This coordinates fake-provider
 * fault tests and supplies the send boundary for the later T6 adapter. */
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
    catch { return this.markUnknownOrQuarantined(operation); }
    if (before === "uncertain") return this.markUnknownOrQuarantined(operation);
    if (before && sameFields(before.fields, operation.desired)) return this.confirmOrQuarantine(operation, before);
    try {
      if (await this.store.supersedeNotionUnsentIfNewer(operation.operationId)) return "superseded";
    } catch { return this.markUnknownOrQuarantined(operation); }

    if (mapping.remotePageId === null) {
      if (before !== null || !this.store.canDispatchNotionOutbox(operation.operationId, operation.datasetEpoch)) {
        return this.markUnknownOrQuarantined(operation);
      }
      try { await this.transport.createPage(connection, mapping, operation.desired); }
      catch { /* The write may have committed before its response was lost. */ }
      return this.readBackAndConfirm(operation, connection, mapping);
    }

    if (!before || !mapping.baseline) return this.markUnknownOrQuarantined(operation);
    if (!sameFields(before.fields, mapping.baseline)) {
      const resolution = reconcileNotionTask({
        baseline: mapping.baseline, local: operation.desired, remote: before.fields,
      });
      try {
        operation = await this.applyPreflightMerge(operation, mapping, before.fields,
          resolution.merged, resolution.conflicts);
        mapping = (await this.store.getNotionTaskMapping(operation.localTaskId))!;
      } catch { return this.markUnknownOrQuarantined(operation); }
    }
    if (sameFields(before.fields, operation.desired)) return this.confirmOrQuarantine(operation, before);
    if (!this.store.canDispatchNotionOutbox(operation.operationId, operation.datasetEpoch)) {
      return this.markUnknownOrQuarantined(operation);
    }
    const patch = reconcileNotionTask({
      baseline: before.fields, local: operation.desired, remote: before.fields,
    }).remotePatch;
    if (Object.keys(patch).length === 0) return this.markUnknownOrQuarantined(operation);
    try { await this.transport.updatePage(connection, mapping, patch); }
    catch { /* Read back before treating an error as a failed write. */ }
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
      !page.remotePageId || page.clientKey !== mapping.clientKey) return "uncertain";
    return { ...page, fields: notionTaskFieldsSchema.parse(page.fields) };
  }

  private async applyPreflightMerge(
    operation: NotionOutboxOperation,
    mapping: NotionTaskMapping,
    remote: NotionTaskFields,
    merged: NotionTaskFields,
    conflicts: NotionFieldConflict[],
  ): Promise<NotionOutboxOperation> {
    if (merged.date === null) throw new Error("Undated Notion tasks need the T4 task model");
    const at = this.now();
    return this.store.transaction(async () => {
      if (!this.store.canDispatchNotionOutbox(operation.operationId, operation.datasetEpoch)) {
        throw new Error("Notion send was fenced during preflight");
      }
      const task = await this.store.getTask(operation.localTaskId);
      if (!task || !sameFields({
        title: task.title, date: [task.startDate, task.endDate], completed: task.status === "completed",
      }, operation.desired)) {
        throw new Error("Local task changed during Notion preflight");
      }
      const commands: PlannerCommand[] = [];
      if (task.title !== merged.title) commands.push({
        type: "updateTaskDetails", input: { taskId: task.id, title: merged.title, now: at },
      });
      if (task.startDate !== merged.date![0] || task.endDate !== merged.date![1]) commands.push({
        type: "rescheduleTask", input: { taskId: task.id, startDate: merged.date![0], endDate: merged.date![1], now: at },
      });
      if ((task.status === "completed") !== merged.completed) {
        if (merged.completed) {
          const preferences = await this.store.getAgentRecord<AgentPreferences>(AGENT_NAMESPACES.preferences, "current");
          if (!preferences?.timeZone) throw new Error("Notion completion needs a configured time zone");
          commands.push({ type: "completeTask", input: {
            taskId: task.id, now: at, completedOn: dateInTimeZone(new Date(at), preferences.timeZone),
          } });
        } else commands.push({ type: "reopenTask", input: { taskId: task.id, now: at } });
      }
      await executePlannerCommandsWithoutUndo(this.store, commands);
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

  private async quarantineIfRestored(operation: NotionOutboxOperation): Promise<DispatchResult> {
    const old = (await this.store.listNotionRestoreQuarantine()).some((item) =>
      item.operation.datasetEpoch === operation.datasetEpoch && item.operation.operationId === operation.operationId);
    if (old) return "quarantined";
    throw new Error("Notion operation changed during dispatch; manual reconciliation required");
  }
}

function sameFields(left: NotionTaskFields, right: NotionTaskFields) {
  const a = notionTaskFieldsSchema.parse(left);
  const b = notionTaskFieldsSchema.parse(right);
  return a.title === b.title && a.completed === b.completed &&
    (a.date === null || b.date === null
      ? a.date === b.date
      : a.date[0] === b.date[0] && a.date[1] === b.date[1]);
}
