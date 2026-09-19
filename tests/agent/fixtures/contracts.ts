import {
  AGENT_PROMPT_VERSION,
  AGENT_SCHEMA_VERSION,
  type AgentBackup,
  type AgentError,
  type AgentPreferences,
  type AgentRun,
  type AgentRunResponse,
  type ApplyProposalRequest,
  type DailyContext,
  type ExecutionReceipt,
  type OperationResult,
  type PlanningFeedback,
  type PlanningHistoryResponse,
  type PlanningModelOutput,
  type PlanningProposal,
  type PlanningSnapshot,
  type PlanningVersion,
} from "@newday/core/contracts/agent-planning";

/** Shared G1 examples. These are synthetic protocol fixtures, not model results.
 * Consumers must clone before modifying to avoid sharing state between tests. */
export const fixtureDate = "2026-09-08";
export const fixtureNow = "2026-09-08T08:00:00.000Z";
export const versionFixture = { datasetEpoch: "dataset-fixture", plannerRevision: 4 } satisfies PlanningVersion;
export const contextFixture = {
  id: "context-fixture", revision: 2, date: fixtureDate, timeZone: "Asia/Shanghai",
  goals: ["完成项目汇报"], energy: null, capacity: 2,
  constraints: [{ id: "constraint-blocked", kind: "blocked_task", taskId: "task-blocked", value: "等待审核", source: "user", sourceText: "合并改动还要等同事审核" }],
  source: "user", updatedAt: fixtureNow,
} satisfies DailyContext;
export const preferencesFixture = {
  revision: 1, timeZone: "Asia/Shanghai", learningEnabled: true,
  explicitPreferences: [{ id: "preference-fixture", text: "同等条件下优先推进已有项目", source: "user", updatedAt: fixtureNow }],
  updatedAt: fixtureNow,
} satisfies AgentPreferences;
const baseTask = {
  notes: "", startDate: fixtureDate, endDate: fixtureDate,
  status: "open" as const, createdAt: fixtureNow, updatedAt: fixtureNow,
  completedAt: null, completedOn: null,
};
export const snapshotFixture = {
  id: "snapshot-fixture", version: versionFixture, date: fixtureDate,
  timeZone: "Asia/Shanghai", sampledAt: fixtureNow,
  context: contextFixture, preferences: preferencesFixture,
  candidates: [
    { task: { ...baseTask, id: "task-report", title: "整理项目汇报" }, executable: true, blocked: false, factRefs: ["fact-report"] },
    { task: { ...baseTask, id: "task-check", title: "核对项目数据" }, executable: true, blocked: false, factRefs: ["fact-check"] },
    { task: { ...baseTask, id: "task-other", title: "整理桌面" }, executable: true, blocked: false, factRefs: ["fact-other"] },
    { task: { ...baseTask, id: "task-blocked", title: "合并待审核改动" }, executable: false, blocked: true, factRefs: ["fact-blocked"] },
  ],
  currentFocusTaskIds: ["task-check", "task-other"],
  facts: [
    { id: "fact-report", source: "task", taskId: "task-report", text: "待办任务：整理项目汇报" },
    { id: "fact-check", source: "task", taskId: "task-check", text: "待办任务：核对项目数据" },
    { id: "fact-other", source: "task", taskId: "task-other", text: "待办任务：整理桌面" },
    { id: "fact-blocked", source: "context", taskId: "task-blocked", constraintId: "constraint-blocked", text: "用户说明改动正在等待审核" },
    { id: "fact-goal", source: "context", text: "当天目标：完成项目汇报" },
  ],
  recentOutcomes: [],
  scope: { description: "包括全部今日可执行任务及明确被阻塞的相关任务；接入前结果历史未知", totalEligibleTasks: 3, includedTasks: 3, complete: true },
} satisfies PlanningSnapshot;
export const readyOutputFixture = {
  kind: "ready", selections: [
    { taskId: "task-report", reason: "直接推进今天的项目汇报目标", factRefs: ["fact-report", "fact-goal"] },
    { taskId: "task-check", reason: "先核对汇报所用数据", factRefs: ["fact-check", "fact-goal"] },
  ], assumptions: ["未提供预计工作时长；按明确的两件可承担量选择"],
} satisfies PlanningModelOutput;
export const clarificationOutputFixture = {
  kind: "needs_clarification", questions: [{ id: "question-priority", question: "今天的汇报优先整理材料还是核对数据？" }], assumptions: [],
} satisfies PlanningModelOutput;
export const noActionOutputFixture = {
  kind: "no_action", reason: "今天已明确休息，保留现有重点", assumptions: [],
} satisfies PlanningModelOutput;
export const readyProposalFixture = {
  proposalId: "proposal-fixture", runId: "run-fixture", snapshotId: snapshotFixture.id,
  createdAt: fixtureNow, lifecycle: "ready", output: readyOutputFixture,
} satisfies PlanningProposal;
export const clarificationProposalFixture = {
  ...readyProposalFixture, proposalId: "proposal-clarification", lifecycle: "not_applicable", output: clarificationOutputFixture,
} satisfies PlanningProposal;
export const noActionProposalFixture = {
  ...readyProposalFixture, proposalId: "proposal-no-action", lifecycle: "not_applicable", output: noActionOutputFixture,
} satisfies PlanningProposal;
export const runFixture = {
  runId: "run-fixture", requestId: "request-fixture", snapshotId: snapshotFixture.id,
  status: "ready", modelId: "scripted-fake", promptVersion: AGENT_PROMPT_VERSION, schemaVersion: AGENT_SCHEMA_VERSION,
  callCount: 1, clarificationRound: 0, latencyMs: 10, usage: { kind: "unknown" },
  createdAt: fixtureNow, updatedAt: fixtureNow, proposalId: readyProposalFixture.proposalId, error: null,
} satisfies AgentRun;
export const runResponseFixture = {
  run: runFixture, snapshot: snapshotFixture, proposal: readyProposalFixture,
} satisfies AgentRunResponse;
export const applyRequestFixture = {
  proposalId: readyProposalFixture.proposalId, operationId: "operation-fixture",
  expectedVersion: versionFixture, taskIds: ["task-report", "task-check"],
} satisfies ApplyProposalRequest;
export const receiptFixture = {
  operationId: applyRequestFixture.operationId, proposalId: readyProposalFixture.proposalId,
  action: "apply", status: "applied", beforeVersion: versionFixture,
  afterVersion: { ...versionFixture, plannerRevision: 5 }, date: fixtureDate, timeZone: "Asia/Shanghai",
  beforeFocusTaskIds: ["task-check", "task-other"], finalFocusTaskIds: ["task-report", "task-check"],
  addedTaskIds: ["task-report"], removedTaskIds: ["task-other"], retainedTaskIds: ["task-check"],
  executedAt: fixtureNow, canRevert: true,
} satisfies ExecutionReceipt;
export const noChangeReceiptFixture = {
  ...receiptFixture, operationId: "operation-no-change", status: "no_change",
  afterVersion: versionFixture, finalFocusTaskIds: receiptFixture.beforeFocusTaskIds,
  addedTaskIds: [], removedTaskIds: [], retainedTaskIds: receiptFixture.beforeFocusTaskIds, canRevert: false,
} satisfies ExecutionReceipt;
export const conflictErrorFixture = {
  code: "VERSION_CONFLICT", status: 409, message: "任务已变化，请重新生成建议", retryable: false, correlationId: "operation-conflict",
} satisfies AgentError;
/** Transport timeout means unconfirmed, not a failed execution. Query the same operationId. */
export const operationUnknownFixture = {
  code: "RESULT_UNKNOWN", status: 504, message: "执行结果待确认，正在查询原操作", retryable: true, correlationId: applyRequestFixture.operationId,
} satisfies AgentError;
export const operationFoundFixture = { status: "found", receipt: receiptFixture } satisfies OperationResult;
export const operationNotFoundFixture = { status: "not_found", operationId: applyRequestFixture.operationId } satisfies OperationResult;
export const operationDetailsDeletedFixture = {
  status: "details_deleted", operationId: applyRequestFixture.operationId,
  proposalId: readyProposalFixture.proposalId, datasetEpoch: versionFixture.datasetEpoch,
  terminalStatus: "applied", detailsDeleted: true,
} satisfies OperationResult;
export const feedbackFixture = {
  feedbackId: "feedback-fixture", proposalId: readyProposalFixture.proposalId,
  operationId: receiptFixture.operationId, decision: "accepted", source: "user", at: fixtureNow,
  datasetEpoch: versionFixture.datasetEpoch,
} satisfies PlanningFeedback;
export const historyFixture = {
  date: fixtureDate,
  entries: [{ id: "history-fixture", date: fixtureDate, datasetEpoch: versionFixture.datasetEpoch, readOnly: false,
    proposal: { ...readyProposalFixture, lifecycle: "applied" }, receipt: receiptFixture, snapshot: snapshotFixture,
    feedback: [feedbackFixture], outcomes: [{ taskId: "task-report", title: "整理项目汇报", status: "unknown", at: null }],
  }],
} satisfies PlanningHistoryResponse;
export const backupFixture = {
  format: "newday-agent", version: 1, exportedAt: fixtureNow, sourceDatasetEpoch: versionFixture.datasetEpoch,
  scope: "agent-history-and-explicit-preferences", preferences: preferencesFixture,
  contexts: [contextFixture], snapshots: [snapshotFixture], runs: [runFixture],
  proposals: [{ ...readyProposalFixture, lifecycle: "applied" }], receipts: [receiptFixture],
  feedback: [feedbackFixture], events: [], importedHistories: [],
} satisfies AgentBackup;
