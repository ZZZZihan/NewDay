import type { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";
import { ApiError } from "../http/api-error.js";
import { NotionOutboxDispatcher } from "./notion-outbox-dispatcher.js";

/** A local API process drains durable intents. Unknown results require an
 * explicit read-only reconciliation; no timer retries a possibly sent write. */
export class NotionSyncService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: SQLitePlannerStore,
    private readonly dispatcher: NotionOutboxDispatcher) {}

  async status(workspaceId: string) {
    const connection = await this.store.getNotionConnection(workspaceId);
    if (!connection) throw new ApiError(404, "Notion 工作区不存在");
    const operations = (await this.store.listNotionOutboxOperations()).filter((item) => item.workspaceId === workspaceId);
    const conflicts = (await this.store.listNotionConflicts()).filter((item) => item.workspaceId === workspaceId);
    return { workspaceId, connectionStatus: connection.status,
      operations: operations.map(({ operationId, localTaskId, status, attemptCount, createdAt, lastAttemptAt }) =>
        ({ operationId, localTaskId, status, attemptCount, createdAt, lastAttemptAt })),
      conflicts };
  }

  drain(workspaceId: string) {
    return this.run(async () => {
      const connection = await this.store.getNotionConnection(workspaceId);
      if (!connection || connection.status !== "active" || !connection.dataSources.tasks) {
        throw new ApiError(409, "Notion 写回已暂停或结构尚未准备好");
      }
      for (const operation of await this.store.listNotionOutboxOperations()) {
        if (operation.workspaceId !== workspaceId || operation.status !== "pending") continue;
        try {
          const result = await this.dispatcher.dispatch(operation.operationId);
          if (result === "unknown" || result === "quarantined" || result === "paused") break;
        } catch {
          throw new ApiError(409, "待发送操作暂时无法安全发送；请刷新状态并核对连接");
        }
      }
      return this.status(workspaceId);
    });
  }

  reconcile(workspaceId: string, operationId: string) {
    return this.run(async () => {
      const operation = await this.store.getNotionOutboxOperation(operationId);
      if (!operation || operation.workspaceId !== workspaceId || operation.status !== "unknown") {
        throw new ApiError(409, "此操作不在待核对状态");
      }
      await this.dispatcher.reconcileUnknown(operationId);
      return this.status(workspaceId);
    });
  }

  resume(workspaceId: string) {
    return this.run(async () => {
      const connection = await this.store.getNotionConnection(workspaceId);
      if (!connection || !["paused", "paused_unknown"].includes(connection.status)) throw new ApiError(409, "工作区无需恢复发送");
      const operations = await this.store.listNotionOutboxOperations();
      if (connection.status === "paused" &&
        !operations.some((item) => item.workspaceId === workspaceId && item.status === "pending" && item.attemptCount > 0)) {
        throw new ApiError(409, "此暂停状态不是待发送预读失败，不能由写回入口恢复");
      }
      if (operations.some((item) => item.workspaceId === workspaceId &&
        ["sending", "unknown", "quarantined"].includes(item.status)) ||
        (await this.store.listNotionRestoreQuarantine()).some((item) => item.operation.workspaceId === workspaceId)) {
        throw new ApiError(409, "仍有待核对或隔离的 Notion 操作");
      }
      await this.store.putNotionConnection({ ...connection, status: "active", updatedAt: new Date().toISOString() });
      return this.status(workspaceId);
    });
  }

  startPolling(intervalMs = 30_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.drainAll().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
    void this.drainAll().catch(() => undefined);
  }

  close() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private async drainAll() {
    const connections = await this.store.listNotionConnections();
    for (const connection of connections) {
      if (connection.status !== "active") continue;
      try { await this.drain(connection.workspaceId); } catch { /* status remains readable */ }
    }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
