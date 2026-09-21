import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ZodError } from "zod";
import { shiftDate } from "@newday/core/domain/planner-date";
import { AGENT_NAMESPACES, dateInTimeZone, type AgentPreferences } from "@newday/core/contracts/agent-planning";
import { getDayPlan } from "@newday/core/application/day-plan";
import { createPlannerBackup, parsePlannerBackup, restorePlannerBackup } from "@newday/core/application/planner-backup";
import { executePlannerCommands, previewStopRecurrenceSeries, type PlannerCommand } from "@newday/core/application/planner-command";
import { clearUndoReceipts, undoPlannerCommand, type UndoReceipt } from "@newday/core/application/planner-undo";
import { notionClientKey, notionTaskFieldsSchema, type NotionTaskFields, type NotionTaskMapping } from "@newday/core/contracts/notion-sync";
import {
  recurrenceSeriesSchema,
  taskSchema,
  type RecurrenceSeries,
  type Task,
} from "@newday/core/domain/planner-model";
import { ApiError } from "../http/api-error.js";
import { AgentApiError } from "../http/agent-error.js";
import { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";
import { notionAttributions } from "./notion-read-view.js";
import { ensureLocalRecurrenceOccurrences } from "./local-recurrence-service.js";

export type WireUndoReceipt = { token: string };
type PendingUndo = { receipt: UndoReceipt; token: string; clientId: string; expiresAt: number };
type CommandPreconditions = {
  expectedTask?: Task;
  expectedSeries?: RecurrenceSeries;
};

const TASK_EDIT_COMMANDS = new Set<PlannerCommand["type"]>([
  "updateTask",
  "updateTaskDetails",
  "rescheduleTask",
  "createRecurrenceSeriesFromTask",
]);

/** Serializes whole application operations, including undo publication after
 * transactions, so different HTTP requests cannot interleave on one connection. */
export class PlannerService {
  private queue: Promise<unknown> = Promise.resolve();
  private pendingUndo?: PendingUndo;

  constructor(
    private readonly store: SQLitePlannerStore,
    private readonly clock: () => number = Date.now,
    private readonly undoTtlMs = 10_000,
    private readonly syncDrainTimeoutMs = 5_000,
  ) {}

  day(input: { selectedDate: string; asOfDate: string }) {
    return this.run(async () => {
      const today = await this.configuredToday();
      const asOfDate = today?.date ?? input.asOfDate;
      const at = new Date(this.clock()).toISOString();
      return this.store.withEventContext({ date: asOfDate, at, source: "system" }, async () => {
        await ensureLocalRecurrenceOccurrences(this.store, {
          asOfDate, throughDate: shiftDate(asOfDate, 31), additionallyEnsureDate: input.selectedDate, now: at,
        });
        const plan = await getDayPlan(this.store, { ...input, asOfDate });
        const byTask = await notionAttributions(this.store);
        const annotate = (items: typeof plan.open) => items.map((item) => ({ ...item,
          ...(byTask[item.task.id] ? { notion: byTask[item.task.id] } : {}) }));
        return { ...plan, focus: annotate(plan.focus), overdue: annotate(plan.overdue),
          open: annotate(plan.open), completed: annotate(plan.completed) };
      });
    });
  }

  series(id: string) {
    return this.run(async () => (await this.store.getRecurrenceSeries(id)) ?? null);
  }

  commands(
    commands: readonly PlannerCommand[],
    clientId: string,
    { expectedTask, expectedSeries }: CommandPreconditions = {},
  ) {
    return this.run(async () => {
      const editedTaskIds = new Set(commands.flatMap((command) =>
        TASK_EDIT_COMMANDS.has(command.type) && "taskId" in command.input
          ? [command.input.taskId]
          : []));
      if (editedTaskIds.size > 0) {
        if (!expectedTask) {
          for (const taskId of editedTaskIds) {
            if (await this.store.getTask(taskId)) {
              throw new ApiError(409, "任务编辑基线缺失；请刷新后重试");
            }
          }
        } else {
          if (editedTaskIds.size !== 1 || !editedTaskIds.has(expectedTask.id)) {
            throw new ApiError(409, "任务编辑基线与修改目标不一致；请刷新后重试");
          }
          const current = await this.store.getTask(expectedTask.id);
          if (!current || !isDeepStrictEqual(taskSchema.parse(current), taskSchema.parse(expectedTask))) {
            throw new ApiError(409, "任务已在其他页面或后台同步更新；请关闭编辑窗口后重新打开");
          }
        }
      }
      const editedSeriesIds = new Set(commands.flatMap((command) =>
        command.type === "updateRecurrenceSeries" ? [command.input.seriesId] : []));
      if (editedSeriesIds.size > 0) {
        if (!expectedSeries) {
          throw new ApiError(409, "重复规则编辑基线缺失；请刷新后重试");
        }
        if (editedSeriesIds.size !== 1 || !editedSeriesIds.has(expectedSeries.id)) {
          throw new ApiError(409, "重复规则编辑基线与修改目标不一致；请刷新后重试");
        }
        const current = await this.store.getRecurrenceSeries(expectedSeries.id);
        if (!current || !isDeepStrictEqual(
          recurrenceSeriesSchema.parse(current),
          recurrenceSeriesSchema.parse(expectedSeries),
        )) {
          throw new ApiError(409, "重复规则已在其他页面或后台同步更新；请关闭编辑窗口后重新打开");
        }
      }
      const today = await this.configuredToday();
      const at = new Date(this.clock()).toISOString();
      const normalized = today ? commands.map((command) => {
        if ((command.type === "setTodayFocus" || command.type === "removeTodayFocus") && command.input.date !== today.date) {
          throw new AgentApiError("DATE_EXPIRED", 409, "日期已变化，请刷新今日清单后再设置重点");
        }
        if (command.type === "completeTask") return { ...command, input: { ...command.input, now: at, completedOn: today.date, asOfDate: today.date } };
        return command;
      }) : commands;
      const linked = new Map<string, NotionTaskMapping>();
      const newLinks = new Map<string, { workspaceId: string; dataSourceId: string; installationId: string }>();
      const before = new Map<string, NotionTaskFields>();
      const notionSeries = new Set((await this.store.listNotionRuleMappings())
        .map((mapping) => mapping.logicalSeriesId));
      for (const command of normalized) {
        if (command.type === "updateRecurrenceSeries" || command.type === "stopRecurrenceSeries") {
          const series = await this.store.getRecurrenceSeries(command.input.seriesId);
          if (series && notionSeries.has(series.logicalSeriesId)) {
            throw new ApiError(409, "Notion 重复规则请在 Notion 编辑；这里只能编辑单个实例");
          }
        }
        if (command.type === "createTask" && command.input.notionWorkspaceId) {
          const workspaceId = command.input.notionWorkspaceId;
          const connection = await this.store.getNotionConnection(workspaceId);
          if (!connection || !this.acceptsLinkedLocalChanges(connection) ||
            !connection.dataSources.areas || !connection.dataSources.projects ||
            !connection.dataSources.tasks || !connection.dataSources.rules) {
            throw new ApiError(409, "Notion 工作区尚未准备好，无法创建联动任务");
          }
          const taskSourceId = connection.dataSources.tasks.dataSourceId;
          const scanned = (await this.store.listNotionScanWatermarks()).some((watermark) =>
            watermark.workspaceId === workspaceId && watermark.dataSourceId === taskSourceId &&
            watermark.lastSuccessAt !== null &&
            (watermark.lastError === null || watermark.lastError === undefined ||
              ["network", "remote", "rate_limited", "local"].includes(watermark.lastError)));
          if (!scanned) throw new ApiError(409, "Notion 任务尚未完成首次成功扫描");
          if (newLinks.has(command.input.id) || await this.store.getNotionTaskMapping(command.input.id)) {
            throw new ApiError(409, "联动任务标识已存在");
          }
          newLinks.set(command.input.id, { workspaceId, dataSourceId: taskSourceId,
            installationId: connection.installationId });
        }
        if (command.type === "setTodayFocus" || command.type === "removeTodayFocus" || !("taskId" in command.input)) continue;
        if (newLinks.has(command.input.taskId) &&
          !["updateTask", "updateTaskDetails", "rescheduleTask", "completeTask", "reopenTask"].includes(command.type)) {
          throw new ApiError(409, "新建的 Notion 联动任务只支持一次性任务操作");
        }
        const mapping = await this.store.getNotionTaskMapping(command.input.taskId);
        if (!mapping) continue;
        if (!["updateTask", "updateTaskDetails", "rescheduleTask", "completeTask", "reopenTask"].includes(command.type) ||
          !["active", "pending_create"].includes(mapping.status)) {
          throw new ApiError(409, "此 Notion 任务不能在 NewDay 执行该操作");
        }
        const connection = await this.store.getNotionConnection(mapping.workspaceId);
        if (!connection || !this.acceptsLinkedLocalChanges(connection) &&
          connection.status !== "paused_unknown") {
          throw new ApiError(409, "Notion 联动已暂停；先核对连接状态");
        }
        linked.set(command.input.taskId, mapping);
        if (!before.has(command.input.taskId)) {
          const task = await this.store.getTask(command.input.taskId);
          if (!task) throw new ApiError(409, "联动任务不存在");
          before.set(task.id, sharedFields(task));
        }
      }
      const receipt = today
        ? await this.store.withEventContext({ date: today.date, at, source: "manual" }, () => executePlannerCommands(this.store, normalized))
        : await executePlannerCommands(this.store, normalized);
      for (const [taskId, target] of newLinks) {
        await this.store.putNotionTaskMapping({ localTaskId: taskId, workspaceId: target.workspaceId,
          dataSourceId: target.dataSourceId, remotePageId: null,
          clientKey: notionClientKey(target.installationId, taskId), baseline: null,
          status: "pending_create", updatedAt: at });
      }
      for (const taskId of new Set([...linked.keys(), ...newLinks.keys()])) {
        const task = await this.store.getTask(taskId);
        const mapping = await this.store.getNotionTaskMapping(taskId);
        if (!task || !mapping) throw new ApiError(409, "联动任务在提交期间改变");
        const desired = sharedFields(task);
        if (newLinks.has(taskId) || JSON.stringify(before.get(taskId)) !== JSON.stringify(desired)) {
          await this.enqueueLinkedIntent(mapping, desired, at);
        }
      }
      // Removing a newly linked page is outside the one-off write contract.
      // Do not publish a local-only undo that would orphan a remote create.
      if (newLinks.size) {
        clearUndoReceipts(this.store);
        this.store.afterCommit(() => { this.pendingUndo = undefined; });
        return { receipt: null };
      }
      // The core invalidates the previous receipt after a successful mutation.
      // A no-op does not disturb a pending receipt owned by another request.
      if (receipt) {
        const token = (receipt as unknown as WireUndoReceipt).token;
        this.store.afterCommit(() => { this.pendingUndo = { receipt, token, clientId, expiresAt: this.clock() + this.undoTtlMs }; });
        return { receipt: { token } };
      }
      return { receipt: null };
    });
  }

  undo(receipt: WireUndoReceipt, clientId: string) {
    return this.run(async () => {
      const pending = this.pendingUndo;
      if (!pending || pending.token !== receipt.token || pending.clientId !== clientId) {
        throw new ApiError(409, "撤销操作已失效");
      }
      if (pending.expiresAt <= this.clock()) {
        this.store.afterCommit(() => { this.pendingUndo = undefined; });
        clearUndoReceipts(this.store);
        throw new ApiError(409, "撤销操作已失效");
      }
      const today = await this.configuredToday();
      const linkedBefore = new Map<string, NotionTaskFields>();
      for (const mapping of await this.store.listNotionTaskMappings()) {
        const task = await this.store.getTask(mapping.localTaskId);
        if (task) linkedBefore.set(task.id, sharedFields(task));
      }
      if (today) {
        await this.store.withEventContext({ date: today.date, at: new Date(this.clock()).toISOString(), source: "manual", kind: "undo" }, () => undoPlannerCommand(this.store, pending.receipt));
      } else await undoPlannerCommand(this.store, pending.receipt);
      const at = new Date(this.clock()).toISOString();
      for (const [taskId, old] of linkedBefore) {
        const task = await this.store.getTask(taskId);
        if (!task) throw new ApiError(409, "不能在 NewDay 删除 Notion 联动任务");
        const desired = sharedFields(task);
        if (JSON.stringify(old) !== JSON.stringify(desired)) {
          const mapping = await this.store.getNotionTaskMapping(taskId);
          if (!mapping) throw new ApiError(409, "Notion 映射在撤销期间改变");
          await this.enqueueLinkedIntent(mapping, desired, at);
        }
      }
      this.store.afterCommit(() => { this.pendingUndo = undefined; });
      return { ok: true as const };
    });
  }

  backup() {
    return this.run(() => createPlannerBackup(this.store, new Date(this.clock()).toISOString()));
  }

  restore(source: string) {
    return this.run(async () => {
      this.parseBackup(source);
      // Commit the send fence before replacing the dataset. A failed import
      // stays paused for reconciliation instead of reopening remote writes.
      await this.store.pauseNotionForRestore();
      await this.store.waitForNotionSendingToSettle(this.syncDrainTimeoutMs);
      const today = await this.configuredToday();
      if (today) await this.store.withEventContext({ date: today.date, at: new Date(this.clock()).toISOString(), source: "import" }, () => restorePlannerBackup(this.store, source));
      else await restorePlannerBackup(this.store, source);
      this.store.afterCommit(() => { this.pendingUndo = undefined; });
      return { ok: true as const };
    }, false);
  }

  stopPreview(input: { seriesId: string; endDate: string }) {
    return this.run(async () => {
      const series = await this.store.getRecurrenceSeries(input.seriesId);
      if (series && (await this.store.listNotionRuleMappings()).some((mapping) =>
        mapping.logicalSeriesId === series.logicalSeriesId)) {
        throw new ApiError(409, "Notion 重复规则请在 Notion 编辑");
      }
      return previewStopRecurrenceSeries(this.store, input);
    });
  }

  migrate(source: string) {
    return this.run(async () => {
      const backup = this.parseBackup(source);
      // Exclude exportedAt: serializing the same browser data again is the same import.
      const data = {
        tasks: backup.tasks, recurrenceSeries: backup.recurrenceSeries, focusRecords: backup.focusRecords,
        inboxItems: backup.inboxItems, folders: backup.folders, resources: backup.resources,
        resourceTaskLinks: backup.resourceTaskLinks,
      };
      const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
      const status = await this.store.importBrowserData(data, hash);
      if (status === "imported") {
        this.store.afterCommit(() => { this.pendingUndo = undefined; });
        clearUndoReceipts(this.store);
      }
      return { status };
    });
  }

  private async configuredToday() {
    const preferences = await this.store.getAgentRecord<AgentPreferences>(AGENT_NAMESPACES.preferences, "current");
    if (!preferences?.timeZone) return undefined;
    return { date: dateInTimeZone(this.clock(), preferences.timeZone), timeZone: preferences.timeZone };
  }

  /** A failed preflight read has sent no write. The workspace remains paused
   * for remote traffic, but local edits may continue accumulating in outbox. */
  private acceptsLinkedLocalChanges(connection: { status: string; pauseReason?: string }): boolean {
    return connection.status === "active" ||
      (connection.status === "paused" && connection.pauseReason === "preflight_read");
  }

  private async enqueueLinkedIntent(mapping: NotionTaskMapping, desired: NotionTaskFields, at: string) {
    await this.store.enqueueNotionOutbox({ operationId: randomUUID(), localTaskId: mapping.localTaskId,
      workspaceId: mapping.workspaceId, datasetEpoch: (await this.store.getPlanningVersion()).datasetEpoch,
      desired, baseline: mapping.baseline, status: "pending", attemptCount: 0,
      createdAt: at, lastAttemptAt: null, confirmedAt: null });
  }

  private parseBackup(source: string) {
    try {
      return parsePlannerBackup(source);
    } catch (error) {
      if (error instanceof Error) throw new ApiError(400, error.message);
      throw error;
    }
  }

  private run<T>(operation: () => Promise<T>, transactional = true): Promise<T> {
    const result = this.queue.then(() => transactional ? this.store.transaction(operation) : operation()).catch((error: unknown) => {
      // Core predates HTTP and uses ordinary Error for domain rejections. Only
      // known domain messages are public; SQL and unexpected failures stay private.
      if (error instanceof ZodError) throw new ApiError(400, error.issues[0]?.message ?? "请求数据无效");
      if (error instanceof Error && /^(任务已存在：|任务不存在：|重复系列已存在：|重复系列不存在：|重复任务实例已存在：|重复任务实例 ID 冲突：|只有未完成任务|任务在该日期|今日重点最多|只有单日任务|任务已经属于|重复规则必须|停止重复不能|生效日期不在|重复任务生成结束日期)/.test(error.message)) {
        throw new ApiError(400, error.message);
      }
      if (error instanceof Error && /^(停止范围已变化|撤销操作已失效|重复系列在撤销前已发生变化)/.test(error.message)) {
        throw new ApiError(409, error.message);
      }
      throw error;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function sharedFields(task: Task): NotionTaskFields {
  return notionTaskFieldsSchema.parse({ title: task.title,
    date: task.startDate === null || task.endDate === null ? null : [task.startDate, task.endDate],
    completed: task.status === "completed" });
}
