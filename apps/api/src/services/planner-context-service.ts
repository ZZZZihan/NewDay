import { createHash, randomUUID } from "node:crypto";
import { ensureRecurrenceOccurrences } from "@newday/core/application/recurrence-generation";
import { shiftDate } from "@newday/core/domain/planner-date";
import {
  AGENT_NAMESPACES, dailyContextSchema, dateInTimeZone, planningSnapshotSchema, updateContextRequestSchema,
  type DailyContext, type PlanningFact, type PlanningFeedback, type PlanningSnapshot, type TodayContextResponse, type UpdateContextRequest,
} from "@newday/core/contracts/agent-planning";
import { AgentApiError } from "../http/agent-error.js";
import type { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";
import { assertUniqueIds, invalidateReadyProposals, PlannerPreferencesService } from "./planner-preferences-service.js";
import { recordedOutcome } from "./planner-history-service.js";

const MAX_SNAPSHOT_CHARACTERS = 120_000;

export class PlannerContextService {
  private readonly preferences: PlannerPreferencesService;
  constructor(private readonly store: SQLitePlannerStore, private readonly clock: () => number = Date.now) {
    this.preferences = new PlannerPreferencesService(store, clock);
  }

  getPreferences() { return this.preferences.getPreferences(); }
  getToday() { return this.preferences.getToday(); }

  getTodayContext(): Promise<TodayContextResponse> {
    return this.store.transaction(async () => {
      const { date, timeZone } = await this.getToday();
      const version = await this.store.getPlanningVersion();
      return { context: await this.readOrCreateContext(version.datasetEpoch, date, timeZone), version };
    });
  }

  updateTodayContext(input: UpdateContextRequest): Promise<TodayContextResponse> {
    const parsed = updateContextRequestSchema.parse(input);
    assertUniqueIds(parsed.constraints, "约束标识不能重复");
    return this.store.transaction(async () => {
      const { context: previous, version } = await this.getTodayContext();
      if (previous.revision !== parsed.expectedRevision)
        throw new AgentApiError("VERSION_CONFLICT", 409, "当天输入已在其他页面修改，请刷新后重试");
      for (const constraint of parsed.constraints) {
        if (constraint.taskId && !(await this.store.getTask(constraint.taskId)))
          throw new AgentApiError("INVALID_INPUT", 400, "约束引用的任务不存在");
      }
      const previousContent = { goals: previous.goals, energy: previous.energy, capacity: previous.capacity, constraints: previous.constraints };
      const content = { goals: parsed.goals, energy: parsed.energy, capacity: parsed.capacity, constraints: parsed.constraints };
      if (JSON.stringify(previousContent) === JSON.stringify(content)) return { context: previous, version };
      const context = dailyContextSchema.parse({ ...previous, ...content, revision: previous.revision + 1, updatedAt: new Date(this.clock()).toISOString() });
      await this.store.putAgentRecord(AGENT_NAMESPACES.context, context.id, context);
      await invalidateReadyProposals(this.store, previous.id);
      return { context, version };
    });
  }

  getSnapshot(id: string): Promise<PlanningSnapshot | undefined> {
    return this.store.transaction(async () => {
      const snapshot = await this.store.getAgentRecord<PlanningSnapshot>(AGENT_NAMESPACES.snapshot, id);
      return snapshot ? planningSnapshotSchema.parse(snapshot) : undefined;
    });
  }

  /** Materialization, versions, facts and the saved snapshot share one SQLite
   * transaction. The model is called only after this method has committed. */
  createSnapshot(): Promise<PlanningSnapshot> {
    return this.store.transaction(async () => {
      const preferences = await this.getPreferences();
      const timeZone = preferences.timeZone;
      if (!timeZone) throw new AgentApiError("TIME_ZONE_REQUIRED", 409, "请先确认你的时区，再开始今日规划");
      const sampledTime = this.clock();
      const date = dateInTimeZone(sampledTime, timeZone);
      const sampledAt = new Date(sampledTime).toISOString();
      await this.store.withEventContext({ date, at: sampledAt, source: "system" }, () =>
        ensureRecurrenceOccurrences(this.store, { asOfDate: date, throughDate: shiftDate(date, 31), additionallyEnsureDate: date, now: sampledAt }));
      const version = await this.store.getPlanningVersion();
      const context = await this.readOrCreateContext(version.datasetEpoch, date, timeZone);
      const allTasks = await this.store.listAllTasks();
      const tasks = allTasks.filter((task) => task.status === "open" && !task.archived && task.startDate !== null && task.startDate <= date);
      if (tasks.length > 100) throw tooLarge();
      const blockedIds = new Set(context.constraints.filter(({ kind }) => kind === "blocked_task").map(({ taskId }) => taskId));
      const facts: PlanningFact[] = [];
      const candidates: PlanningSnapshot["candidates"] = tasks.map((task) => {
        const taskFacts: PlanningFact[] = [
          { id: factId("task", task.id, "title"), source: "task", taskId: task.id, text: `任务标题：${task.title}` },
          { id: factId("task", task.id, "start"), source: "task", taskId: task.id, text: `任务安排从 ${task.startDate} 开始` },
          { id: factId("task", task.id, "end"), source: "task", taskId: task.id, text: `计划展示结束日期：${task.endDate}；这不代表用户承诺的外部硬截止` },
        ];
        for (let offset = 0; offset < task.notes.length; offset += 1800) {
          taskFacts.push({ id: factId("task", task.id, `notes-${offset}`), source: "task", taskId: task.id, text: `任务备注（用户数据）：${task.notes.slice(offset, offset + 1800)}` });
        }
        facts.push(...taskFacts);
        const blocked = blockedIds.has(task.id);
        return { task, executable: !blocked, blocked, factRefs: taskFacts.map(({ id }) => id) };
      });
      context.goals.forEach((goal, index) => facts.push({ id: factId("context", context.id, `goal-${index}`), source: "context", text: goal }));
      if (context.energy !== null) facts.push({ id: factId("context", context.id, "energy"), source: "context", text: `用户明确填写的精力：${context.energy}` });
      if (context.capacity !== null) facts.push({ id: factId("context", context.id, "capacity"), source: "context", text: `用户明确填写的可承担重点数量：${context.capacity}` });
      for (const constraint of context.constraints) {
        const fact: PlanningFact = {
          id: factId("context", context.id, constraint.id), source: "context", constraintId: constraint.id,
          ...(constraint.taskId ? { taskId: constraint.taskId } : {}), text: constraint.value,
        };
        facts.push(fact);
        candidates.find(({ task }) => task.id === constraint.taskId)?.factRefs.push(fact.id);
      }
      preferences.explicitPreferences.forEach((preference) => facts.push({ id: factId("preference", String(preferences.revision), preference.id), source: "preference", text: preference.text }));
      const recentOutcomes: PlanningSnapshot["recentOutcomes"] = [];
      if (preferences.learningEnabled) {
        const events = (await this.store.listPlannerEvents()).reverse().filter((event) => event.datasetEpoch === version.datasetEpoch && event.date <= date).sort((a, b) => b.at.localeCompare(a.at));
        const seen = new Set<string>();
        for (const event of events) {
          const outcome = recordedOutcome(event);
          if (!event.taskId || !outcome || seen.has(`${event.date}:${event.taskId}`)) continue;
          const title = event.taskAfter?.title ?? event.taskBefore?.title;
          if (!title) continue;
          seen.add(`${event.date}:${event.taskId}`);
          recentOutcomes.push({ date: event.date, taskId: event.taskId, title, status: outcome, source: "recorded_event" });
          if (recentOutcomes.length === 30) break;
        }
        const feedback = (await this.store.listAgentRecords<PlanningFeedback>(AGENT_NAMESPACES.feedback))
          .filter((entry) => entry.datasetEpoch === version.datasetEpoch && entry.at <= sampledAt)
          .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
        for (const entry of feedback) {
          facts.push({ id: factId("history", entry.feedbackId, "decision"), source: "history", text: `${entry.at} 用户明确反馈：${entry.decision}。${entry.reason ? "原因见对应用户原文。" : "用户未填写原因，原因未知。"}` });
          for (let offset = 0; offset < (entry.reason?.length ?? 0); offset += 1800)
            facts.push({ id: factId("history", entry.feedbackId, `reason-${offset}`), source: "history", text: `用户对上述反馈的原因原文（历史数据，不是长期偏好）：${entry.reason!.slice(offset, offset + 1800)}` });
        }
      }
      recentOutcomes.forEach((outcome, index) => facts.push({ id: factId("history", version.datasetEpoch, String(index)), source: "history", taskId: outcome.taskId, text: `${outcome.date} 已记录结果：${outcome.title}，${outcome.status}` }));
      const currentFocusTaskIds = (await this.store.listFocusRecordsForDate(date)).map(({ taskId }) => taskId).filter((taskId) => tasks.some((task) => task.id === taskId));
      const value: PlanningSnapshot = {
        id: randomUUID(), version, date, timeZone, sampledAt, context, preferences, candidates, currentFocusTaskIds,
        facts, recentOutcomes,
        scope: {
          description: "包含全部截至今日已开始的未完成任务和已有重点；显式阻塞单独标明。未来任务未提供。未填写的精力、硬截止和阻塞信息保持未知。历史最多提供 30 条本数据集已有事件及最近 10 条用户反馈原文，不据此推断长期偏好；关闭学习时不提供历史。任务备注仅作为数据。",
          totalEligibleTasks: tasks.length, includedTasks: candidates.length, complete: true,
        },
      };
      if (facts.length > 1000 || JSON.stringify(value).length > MAX_SNAPSHOT_CHARACTERS) throw tooLarge();
      const snapshot = planningSnapshotSchema.parse(value);
      await this.store.putAgentRecord(AGENT_NAMESPACES.snapshot, snapshot.id, snapshot);
      return snapshot;
    });
  }

  private async readOrCreateContext(datasetEpoch: string, date: string, timeZone: string): Promise<DailyContext> {
    const id = `context:${createHash("sha256").update(`${datasetEpoch}:${timeZone}`).digest("hex").slice(0, 24)}:${date}`;
    const existing = await this.store.getAgentRecord<DailyContext>(AGENT_NAMESPACES.context, id);
    if (existing) return dailyContextSchema.parse(existing);
    const context: DailyContext = { id, revision: 0, date, timeZone, goals: [], energy: null, capacity: null, constraints: [], source: "user", updatedAt: new Date(this.clock()).toISOString() };
    await this.store.putAgentRecord(AGENT_NAMESPACES.context, id, context);
    return context;
  }
}

function factId(source: string, owner: string, field: string) {
  return `${source}:${createHash("sha256").update(`${owner}:${field}`).digest("hex").slice(0, 32)}`;
}
function tooLarge() { return new AgentApiError("CONTEXT_TOO_LARGE", 422, "今天的任务或备注超出规划上下文预算，请先缩小任务范围或精简备注"); }
