import { createHash, randomUUID } from "node:crypto";
import { AGENT_NAMESPACES, applyProposalRequestSchema, dateInTimeZone, executionReceiptSchema, type AgentPreferences, type ApplyProposalRequest, type ApplyProposalResponse, type DailyContext, type ExecutionReceipt, type OperationResult, type PlanningFeedback, type PlanningProposal, type PlanningSnapshot, type PlanningVersion } from "@newday/core/contracts/agent-planning";
import { clearUndoReceipts } from "@newday/core/application/planner-undo";
import { AgentApiError } from "../http/agent-error.js";
import { SQLitePlannerStore, type ExecutionLedgerRecord } from "../storage/sqlite-planner-store.js";

export class AgentExecutionService {
  constructor(private readonly store: SQLitePlannerStore, private readonly clock: () => number = Date.now) {}

  apply(input: ApplyProposalRequest): Promise<ApplyProposalResponse> {
    const request = applyProposalRequestSchema.parse(input);
    const digest = requestDigest({ action: "apply", ...request, taskIds: sorted(request.taskIds) });
    return this.store.transaction(async () => {
      const existing = await this.store.getExecutionLedger(request.operationId);
      if (existing) return this.replay(existing, digest);
      const proposal = await this.store.getAgentRecord<PlanningProposal>(AGENT_NAMESPACES.proposal, request.proposalId);
      if (!proposal) throw new AgentApiError("NOT_FOUND", 404, "找不到这份建议，请重新生成");
      if (proposal.lifecycle !== "ready" || proposal.output.kind !== "ready") throw new AgentApiError("PROPOSAL_NOT_EXECUTABLE", 409, "这份建议已处理或不能采纳，请重新生成");
      const snapshot = await this.store.getAgentRecord<PlanningSnapshot>(AGENT_NAMESPACES.snapshot, proposal.snapshotId);
      if (!snapshot) throw new AgentApiError("PROPOSAL_NOT_EXECUTABLE", 409, "建议所依据的上下文已清理，请重新生成");
      const today = await this.today();
      if (snapshot.date !== today.date || snapshot.timeZone !== today.timeZone) throw new AgentApiError("DATE_EXPIRED", 409, "日期或时区已变化，请重新生成今日建议");
      const beforeVersion = await this.store.getPlanningVersion();
      if (!sameVersion(beforeVersion, request.expectedVersion) || !sameVersion(beforeVersion, snapshot.version)) throw new AgentApiError("VERSION_CONFLICT", 409, "任务清单已变化，请重新生成建议");
      const context = await this.store.getAgentRecord<DailyContext>(AGENT_NAMESPACES.context, snapshot.context.id);
      if (!context || context.revision !== snapshot.context.revision || context.date !== today.date || context.timeZone !== today.timeZone || today.preferences.revision !== snapshot.preferences.revision) throw new AgentApiError("VERSION_CONFLICT", 409, "当天输入或偏好已变化，请重新生成建议");
      await this.validateFinalSelection(snapshot, request.taskIds);
      // Bind the final date check, receipt and events to one execution instant.
      // Validation may have started immediately before local midnight.
      const executionInstant = new Date(this.clock());
      const executedAt = executionInstant.toISOString();
      if (dateInTimeZone(executionInstant, today.timeZone) !== snapshot.date) throw new AgentApiError("DATE_EXPIRED", 409, "日期已变化，请重新生成今日建议");
      return this.store.withEventContext({ date: today.date, at: executedAt, source: "agent", operationId: request.operationId, proposalId: proposal.proposalId }, async () => {
        const receipt = await this.replaceFocus({ operationId: request.operationId, proposalId: proposal.proposalId, date: today.date, timeZone: today.timeZone, beforeVersion, taskIds: request.taskIds, executedAt, action: "apply" });
        await this.store.putAgentRecord(AGENT_NAMESPACES.proposal, proposal.proposalId, { ...proposal, lifecycle: "applied" });
        const feedback: PlanningFeedback = { feedbackId: `adoption:${requestDigest(request.operationId)}`, proposalId: proposal.proposalId, operationId: request.operationId,
          decision: sameSet(request.taskIds, proposal.output.kind === "ready" ? proposal.output.selections.map((selection) => selection.taskId) : []) ? "accepted" : "modified", source: "user", at: executedAt, datasetEpoch: beforeVersion.datasetEpoch };
        await this.store.putAgentRecord(AGENT_NAMESPACES.feedback, feedback.feedbackId, feedback);
        for (const taskId of receipt.finalFocusTaskIds) {
          const task = await this.store.getTask(taskId);
          await this.store.appendPlannerEvent({ id: randomUUID(), ...receipt.afterVersion, date: today.date, at: executedAt, source: "agent", kind: "proposal_applied", taskId, taskBefore: task, taskAfter: task, operationId: request.operationId, proposalId: proposal.proposalId });
        }
        await this.store.putExecutionReceipt(digest, receipt);
        if (receipt.status === "applied") clearUndoReceipts(this.store);
        return receipt;
      });
    });
  }

  operation(operationId: string): Promise<OperationResult> {
    return this.store.transaction(async () => {
      const result = await this.store.getOperationResult(operationId);
      if (result.status === "found") return { ...result, receipt: { ...result.receipt, canRevert: await this.canRevert(result.receipt) } };
      return result;
    });
  }

  revert(targetOperationId: string, input: { operationId: string }): Promise<ApplyProposalResponse> {
    const digest = requestDigest({ action: "revert", targetOperationId, operationId: input.operationId });
    return this.store.transaction(async () => {
      const existing = await this.store.getExecutionLedger(input.operationId);
      if (existing) return this.replay(existing, digest);
      const target = await this.store.getExecutionLedger(targetOperationId);
      if (!target) throw new AgentApiError("NOT_FOUND", 404, "找不到这次执行记录");
      if (!target.receipt || !await this.canRevert(target.receipt)) throw new AgentApiError("RESTORE_CONFLICT", 409, "当前状态已变化，无法恢复这次建议之前的重点");
      const original = target.receipt;
      const executionInstant = new Date(this.clock());
      const executedAt = executionInstant.toISOString();
      if (dateInTimeZone(executionInstant, original.timeZone) !== original.date) throw new AgentApiError("RESTORE_CONFLICT", 409, "日期已变化，无法恢复之前的重点");
      return this.store.withEventContext({ date: original.date, at: executedAt, source: "agent", operationId: input.operationId, proposalId: original.proposalId }, async () => {
        const receipt = await this.replaceFocus({ operationId: input.operationId, proposalId: original.proposalId, date: original.date, timeZone: original.timeZone,
          beforeVersion: await this.store.getPlanningVersion(), taskIds: original.beforeFocusTaskIds, executedAt, action: "revert", revertsOperationId: targetOperationId });
        await this.store.appendPlannerEvent({ id: randomUUID(), ...receipt.afterVersion, date: original.date, at: executedAt, source: "agent", kind: "focus_reverted", operationId: input.operationId, proposalId: original.proposalId });
        await this.store.putExecutionReceipt(digest, receipt);
        if (receipt.status === "applied") clearUndoReceipts(this.store);
        return receipt;
      });
    });
  }

  private async replay(record: ExecutionLedgerRecord, digest: string): Promise<ApplyProposalResponse> {
    if (record.requestDigest !== digest) throw new AgentApiError("IDEMPOTENCY_CONFLICT", 409, "这个操作标识已用于不同请求，请查询原操作结果", false, record.operationId);
    if (record.receipt) return record.receipt;
    return { status: "details_deleted", operationId: record.operationId, proposalId: record.proposalId, datasetEpoch: record.datasetEpoch, terminalStatus: record.terminalStatus, detailsDeleted: true };
  }

  private async today() {
    const preferences = await this.store.getAgentRecord<AgentPreferences>(AGENT_NAMESPACES.preferences, "current");
    if (!preferences?.timeZone) throw new AgentApiError("TIME_ZONE_REQUIRED", 409, "请先设置你的时区");
    return { date: dateInTimeZone(this.clock(), preferences.timeZone), timeZone: preferences.timeZone, preferences };
  }

  private async validateFinalSelection(snapshot: PlanningSnapshot, taskIds: string[]) {
    if (!snapshot.scope.complete) throw new AgentApiError("PROPOSAL_NOT_EXECUTABLE", 409, "建议没有覆盖完整候选范围，请缩小范围后重新生成");
    const constraints = snapshot.context.constraints;
    if (constraints.some((constraint) => constraint.kind === "rest")) throw new AgentApiError("PROPOSAL_NOT_EXECUTABLE", 409, "已明确今天休息，不能采纳任务建议");
    if (snapshot.context.capacity !== null && taskIds.length > snapshot.context.capacity) throw new AgentApiError("INVALID_INPUT", 400, "最终重点超过今天可承担的数量");
    for (const constraint of constraints) {
      if (constraint.kind === "must_include" && !taskIds.includes(constraint.taskId!)) throw new AgentApiError("INVALID_INPUT", 400, "最终重点遗漏了明确要求包含的任务");
      if (constraint.kind === "blocked_task" && taskIds.includes(constraint.taskId!)) throw new AgentApiError("INVALID_INPUT", 400, "等待他人的任务不能作为当前可执行重点");
    }
    for (const id of taskIds) {
      const candidate = snapshot.candidates.find((entry) => entry.task.id === id);
      const current = await this.store.getTask(id);
      if (!candidate || !candidate.executable || candidate.blocked || !current || current.status !== "open" || current.archived || current.startDate === null || current.startDate > snapshot.date) throw new AgentApiError("PROPOSAL_NOT_EXECUTABLE", 409, "最终选择包含当前不能执行的任务，请重新生成建议");
    }
  }

  private async canRevert(receipt: ExecutionReceipt): Promise<boolean> {
    if (receipt.action !== "apply" || receipt.status !== "applied") return false;
    const preferences = await this.store.getAgentRecord<AgentPreferences>(AGENT_NAMESPACES.preferences, "current");
    if (!preferences?.timeZone || preferences.timeZone !== receipt.timeZone || dateInTimeZone(this.clock(), preferences.timeZone) !== receipt.date) return false;
    if (!sameVersion(await this.store.getPlanningVersion(), receipt.afterVersion)) return false;
    if (!sameSet((await this.store.listFocusRecordsForDate(receipt.date)).map((record) => record.taskId), receipt.finalFocusTaskIds)) return false;
    for (const taskId of receipt.beforeFocusTaskIds) {
      const task = await this.store.getTask(taskId);
      if (!task || task.status !== "open" || task.archived || task.startDate === null || task.startDate > receipt.date) return false;
    }
    return true;
  }

  private async replaceFocus(input: { operationId: string; proposalId: string; date: string; timeZone: string; beforeVersion: PlanningVersion; taskIds: string[]; executedAt: string; action: "apply" | "revert"; revertsOperationId?: string }): Promise<ExecutionReceipt> {
    const records = await this.store.listFocusRecordsForDate(input.date);
    const beforeIds = sorted(records.map((record) => record.taskId));
    const finalIds = sorted(input.taskIds);
    const addedTaskIds = finalIds.filter((id) => !beforeIds.includes(id));
    const removedTaskIds = beforeIds.filter((id) => !finalIds.includes(id));
    for (const record of records) if (!finalIds.includes(record.taskId)) await this.store.deleteFocusRecord(record.id);
    for (const taskId of addedTaskIds) await this.store.putFocusRecord({ id: `focus:${input.date}:${taskId}`, date: input.date, taskId, focusedAt: input.executedAt });
    const changed = addedTaskIds.length > 0 || removedTaskIds.length > 0;
    return executionReceiptSchema.parse({ operationId: input.operationId, proposalId: input.proposalId, action: input.action, status: changed ? "applied" : "no_change",
      beforeVersion: input.beforeVersion, afterVersion: await this.store.getPlanningVersion(), date: input.date, timeZone: input.timeZone,
      beforeFocusTaskIds: beforeIds, finalFocusTaskIds: finalIds, addedTaskIds, removedTaskIds, retainedTaskIds: finalIds.filter((id) => beforeIds.includes(id)),
      executedAt: input.executedAt, canRevert: input.action === "apply" && changed, ...(input.revertsOperationId ? { revertsOperationId: input.revertsOperationId } : {}) });
  }
}

function sorted(values: readonly string[]) { return [...values].sort(); }
function sameSet(left: readonly string[], right: readonly string[]) { return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right)); }
function sameVersion(left: PlanningVersion, right: PlanningVersion) { return left.datasetEpoch === right.datasetEpoch && left.plannerRevision === right.plannerRevision; }
function requestDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
