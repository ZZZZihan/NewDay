import { randomUUID } from "node:crypto";

import { reconcileNotionTask } from "@newday/core/application/notion-sync-reconcile";
import {
  notionTaskFieldsSchema,
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
  updatePage(connection: NotionConnection, mapping: NotionTaskMapping, fields: NotionTaskFields): Promise<void>;
}

type DispatchResult = "confirmed" | "unknown" | "quarantined";

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
    const operation = await this.store.markNotionOutboxSending(operationId, this.now());
    const connection = await this.store.getNotionConnection(operation.workspaceId);
    const mapping = await this.store.getNotionTaskMapping(operation.localTaskId);
    if (!connection || !mapping) return this.markUnknownOrQuarantined(operation);

    try {
      const before = await this.readTarget(connection, mapping);
      if (before === "uncertain") return this.markUnknownOrQuarantined(operation);
      if (before && sameFields(before.fields, operation.desired)) {
        return this.confirmOrQuarantine(operation, before);
      }
      if (!this.store.canDispatchNotionOutbox(operation.operationId, operation.datasetEpoch)) {
        return this.markUnknownOrQuarantined(operation);
      }
      if (mapping.remotePageId === null) {
        if (before !== null) return this.markUnknownOrQuarantined(operation);
        await this.transport.createPage(connection, mapping, operation.desired);
      } else {
        if (!before || !mapping.baseline || !sameFields(before.fields, mapping.baseline)) {
          if (before && mapping.baseline) await this.recordConflicts(operation, mapping, before.fields);
          return this.markUnknownOrQuarantined(operation);
        }
        await this.transport.updatePage(connection, mapping, operation.desired);
      }
    } catch {
      // A throw may be a lost response after the remote write. Read back below.
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

  private async recordConflicts(
    operation: NotionOutboxOperation,
    mapping: NotionTaskMapping,
    remote: NotionTaskFields,
  ) {
    if (!mapping.baseline) return;
    const resolution = reconcileNotionTask({ baseline: mapping.baseline, local: operation.desired, remote });
    for (const conflict of resolution.conflicts) {
      await this.store.appendNotionConflict({
        id: randomUUID(), localTaskId: mapping.localTaskId, workspaceId: mapping.workspaceId,
        field: conflict.field, baseline: conflict.baseline, local: conflict.local,
        remote: conflict.remote, recordedAt: this.now(),
      });
    }
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
