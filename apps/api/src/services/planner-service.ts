import { createHash } from "node:crypto";
import { ZodError } from "zod";
import { shiftDate } from "@newday/core/domain/planner-date";
import { AGENT_NAMESPACES, dateInTimeZone, type AgentPreferences } from "@newday/core/contracts/agent-planning";
import { getDayPlan } from "@newday/core/application/day-plan";
import { createPlannerBackup, parsePlannerBackup, restorePlannerBackup } from "@newday/core/application/planner-backup";
import { executePlannerCommands, previewStopRecurrenceSeries, type PlannerCommand } from "@newday/core/application/planner-command";
import { ensureRecurrenceOccurrences } from "@newday/core/application/recurrence-generation";
import { clearUndoReceipts, undoPlannerCommand, type UndoReceipt } from "@newday/core/application/planner-undo";
import { ApiError } from "../http/api-error.js";
import { AgentApiError } from "../http/agent-error.js";
import { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";

export type WireUndoReceipt = { token: string };
type PendingUndo = { receipt: UndoReceipt; token: string; clientId: string; expiresAt: number };

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
        await ensureRecurrenceOccurrences(this.store, {
          asOfDate, throughDate: shiftDate(asOfDate, 31), additionallyEnsureDate: input.selectedDate, now: at,
        });
        return getDayPlan(this.store, { ...input, asOfDate });
      });
    });
  }

  series(id: string) {
    return this.run(async () => (await this.store.getRecurrenceSeries(id)) ?? null);
  }

  commands(commands: readonly PlannerCommand[], clientId: string) {
    return this.run(async () => {
      const today = await this.configuredToday();
      const at = new Date(this.clock()).toISOString();
      const normalized = today ? commands.map((command) => {
        if ((command.type === "setTodayFocus" || command.type === "removeTodayFocus") && command.input.date !== today.date) {
          throw new AgentApiError("DATE_EXPIRED", 409, "日期已变化，请刷新今日清单后再设置重点");
        }
        if (command.type === "completeTask") return { ...command, input: { ...command.input, now: at, completedOn: today.date, asOfDate: today.date } };
        return command;
      }) : commands;
      const receipt = today
        ? await this.store.withEventContext({ date: today.date, at, source: "manual" }, () => executePlannerCommands(this.store, normalized))
        : await executePlannerCommands(this.store, normalized);
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
      if (today) {
        await this.store.withEventContext({ date: today.date, at: new Date(this.clock()).toISOString(), source: "manual", kind: "undo" }, () => undoPlannerCommand(this.store, pending.receipt));
      } else await undoPlannerCommand(this.store, pending.receipt);
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
    return this.run(() => previewStopRecurrenceSeries(this.store, input));
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
