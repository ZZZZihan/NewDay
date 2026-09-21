import { z } from "zod";
import { instantSchema, localDateSchema, taskSchema } from "../domain/planner-model";

/** Frozen wire contract. Model output never contains commands, timestamps or IDs
 * for runs/proposals/operations; those identities belong to the host. */
export const AGENT_SCHEMA_VERSION = "newday-agent-v1";
export const AGENT_PROMPT_VERSION = "daily-focus-v1";
const id = z.string().min(1).max(200);
const text = z.string().trim().min(1).max(2000);
export const timeZoneSchema = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; }
  catch { return false; }
}, "请选择有效的 IANA 时区");
export function dateInTimeZone(now: number | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export const planningVersionSchema = z.strictObject({
  datasetEpoch: id, plannerRevision: z.number().int().nonnegative(),
});
export type PlanningVersion = z.infer<typeof planningVersionSchema>;
export const explicitConstraintSchema = z.strictObject({
  id, kind: z.enum(["blocked_task", "must_include", "hard_deadline", "rest", "other"]),
  taskId: id.optional(), value: text, source: z.literal("user"), sourceText: text,
}).superRefine((value, ctx) => {
  if (["blocked_task", "must_include", "hard_deadline"].includes(value.kind) && !value.taskId)
    ctx.addIssue({ code: "custom", message: "任务约束需要任务标识", path: ["taskId"] });
});
export type ExplicitConstraint = z.infer<typeof explicitConstraintSchema>;
const contextFields = {
  goals: z.array(text).max(10), energy: z.enum(["low", "normal", "high"]).nullable(),
  capacity: z.number().int().min(1).max(3).nullable(), constraints: z.array(explicitConstraintSchema).max(30),
};
export const dailyContextSchema = z.strictObject({
  id, revision: z.number().int().nonnegative(), date: localDateSchema, timeZone: timeZoneSchema,
  ...contextFields, source: z.literal("user"), updatedAt: instantSchema,
});
export type DailyContext = z.infer<typeof dailyContextSchema>;
export const updateContextRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(), ...contextFields,
});
export type UpdateContextRequest = z.infer<typeof updateContextRequestSchema>;
export const explicitPreferenceSchema = z.strictObject({ id, text, source: z.literal("user"), updatedAt: instantSchema });
export const agentPreferencesSchema = z.strictObject({
  revision: z.number().int().nonnegative(), timeZone: timeZoneSchema.nullable(),
  learningEnabled: z.boolean(), explicitPreferences: z.array(explicitPreferenceSchema).max(30), updatedAt: instantSchema,
});
export type AgentPreferences = z.infer<typeof agentPreferencesSchema>;
export const updatePreferencesRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(), timeZone: timeZoneSchema,
  learningEnabled: z.boolean(), explicitPreferences: z.array(z.strictObject({ id, text, source: z.literal("user") })).max(30),
});
export type UpdatePreferencesRequest = z.infer<typeof updatePreferencesRequestSchema>;
export const planningFactSchema = z.strictObject({
  id, source: z.enum(["task", "context", "preference", "history"]), text,
  taskId: id.optional(), constraintId: id.optional(),
});
export type PlanningFact = z.infer<typeof planningFactSchema>;
export const snapshotTaskSchema = z.strictObject({ task: taskSchema, executable: z.boolean(), blocked: z.boolean(), factRefs: z.array(id) });
export const planningSnapshotSchema = z.strictObject({
  id, version: planningVersionSchema, date: localDateSchema, timeZone: timeZoneSchema, sampledAt: instantSchema,
  context: dailyContextSchema, preferences: agentPreferencesSchema,
  candidates: z.array(snapshotTaskSchema).max(100), currentFocusTaskIds: z.array(id).max(3),
  facts: z.array(planningFactSchema).max(1000),
  recentOutcomes: z.array(z.strictObject({ date: localDateSchema, taskId: id, title: text, status: text, source: z.literal("recorded_event") })).max(30),
  scope: z.strictObject({ description: text, totalEligibleTasks: z.number().int().nonnegative(), includedTasks: z.number().int().nonnegative(), complete: z.boolean() }),
});
export type PlanningSnapshot = z.infer<typeof planningSnapshotSchema>;
export const proposalSelectionSchema = z.strictObject({ taskId: id, reason: text, factRefs: z.array(id).min(1).max(20) });
export const clarificationQuestionSchema = z.strictObject({ id, question: text });
export const planningModelOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready"), selections: z.array(proposalSelectionSchema).min(1).max(3), assumptions: z.array(text).max(10) }),
  z.strictObject({ kind: z.literal("needs_clarification"), questions: z.array(clarificationQuestionSchema).min(1).max(2), assumptions: z.array(text).max(10) }),
  z.strictObject({ kind: z.literal("no_action"), reason: text, assumptions: z.array(text).max(10) }),
]);
export type PlanningModelOutput = z.infer<typeof planningModelOutputSchema>;
export const proposalLifecycleSchema = z.enum(["ready", "applied", "rejected", "superseded", "expired", "not_applicable"]);
export const planningProposalSchema = z.strictObject({
  proposalId: id, runId: id, snapshotId: id, createdAt: instantSchema,
  lifecycle: proposalLifecycleSchema, output: planningModelOutputSchema,
});
export type PlanningProposal = z.infer<typeof planningProposalSchema>;
export const agentErrorCodeSchema = z.enum([
  "INVALID_INPUT", "NOT_FOUND", "VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "DATE_EXPIRED", "TIME_ZONE_REQUIRED",
  "PROPOSAL_NOT_EXECUTABLE", "MODEL_UNAVAILABLE", "MODEL_INVALID_OUTPUT", "MODEL_TIMEOUT", "MODEL_RATE_LIMITED",
  "RUN_ACTIVE", "RUN_NOT_ACTIVE", "CLARIFICATION_LIMIT", "CONTEXT_TOO_LARGE", "RESULT_UNKNOWN", "RESTORE_CONFLICT", "INTERNAL_ERROR",
]);
export type AgentErrorCode = z.infer<typeof agentErrorCodeSchema>;
export const agentErrorSchema = z.strictObject({ code: agentErrorCodeSchema, status: z.number().int(), message: text, retryable: z.boolean(), correlationId: id.optional() });
export type AgentError = z.infer<typeof agentErrorSchema>;
export const modelUsageSchema = z.union([
  z.strictObject({ kind: z.literal("known"), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("unknown") }),
]);
export type ModelUsage = z.infer<typeof modelUsageSchema>;
export const agentRunSchema = z.strictObject({
  runId: id, requestId: id, snapshotId: id,
  status: z.enum(["running", "needs_clarification", "ready", "no_action", "failed", "cancelled", "interrupted"]),
  modelId: id, promptVersion: id, schemaVersion: id,
  callCount: z.number().int().min(0).max(3), clarificationRound: z.number().int().min(0).max(1),
  latencyMs: z.number().nonnegative(), usage: modelUsageSchema,
  createdAt: instantSchema, updatedAt: instantSchema, proposalId: id.nullable(), error: agentErrorSchema.nullable(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;
export const createRunRequestSchema = z.strictObject({ requestId: id });
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;
export const answerRunRequestSchema = z.strictObject({ requestId: id, answers: z.array(z.strictObject({ questionId: id, answer: text })).min(1).max(2) });
export type AnswerRunRequest = z.infer<typeof answerRunRequestSchema>;
export const agentRunResponseSchema = z.strictObject({ run: agentRunSchema, snapshot: planningSnapshotSchema, proposal: planningProposalSchema.nullable() });
export type AgentRunResponse = z.infer<typeof agentRunResponseSchema>;
const finalTaskIds = z.array(id).min(1).max(3).refine((ids) => new Set(ids).size === ids.length, "重点任务不能重复");
export const applyProposalRequestSchema = z.strictObject({
  proposalId: id, operationId: id, expectedVersion: planningVersionSchema, taskIds: finalTaskIds,
});
export type ApplyProposalRequest = z.infer<typeof applyProposalRequestSchema>;
export const executionReceiptSchema = z.strictObject({
  operationId: id, proposalId: id, action: z.enum(["apply", "revert"]),
  status: z.enum(["applied", "no_change"]), beforeVersion: planningVersionSchema, afterVersion: planningVersionSchema,
  date: localDateSchema, timeZone: timeZoneSchema, beforeFocusTaskIds: z.array(id).max(3), finalFocusTaskIds: z.array(id).max(3),
  addedTaskIds: z.array(id).max(3), removedTaskIds: z.array(id).max(3), retainedTaskIds: z.array(id).max(3),
  executedAt: instantSchema, canRevert: z.boolean(), revertsOperationId: id.optional(),
});
export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;
export const operationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("found"), receipt: executionReceiptSchema }),
  z.strictObject({ status: z.literal("not_found"), operationId: id }),
  z.strictObject({ status: z.literal("details_deleted"), operationId: id, proposalId: id, datasetEpoch: id, terminalStatus: z.enum(["applied", "no_change"]), detailsDeleted: z.literal(true) }),
]);
export type OperationResult = z.infer<typeof operationResultSchema>;
export const applyProposalResponseSchema = z.union([executionReceiptSchema, operationResultSchema.options[2]]);
export type ApplyProposalResponse = z.infer<typeof applyProposalResponseSchema>;
export const revertOperationRequestSchema = z.strictObject({ operationId: id });
export const feedbackRequestSchema = z.strictObject({
  feedbackId: id, proposalId: id, operationId: id.optional(), decision: z.enum(["accepted", "modified", "rejected", "reviewed"]), reason: z.string().trim().max(2000).optional(),
});
export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;
export const planningFeedbackSchema = feedbackRequestSchema.extend({ source: z.literal("user"), at: instantSchema, datasetEpoch: id });
export type PlanningFeedback = z.infer<typeof planningFeedbackSchema>;
export const plannerEventSchema = z.strictObject({
  id, datasetEpoch: id, plannerRevision: z.number().int().nonnegative(), date: localDateSchema, at: instantSchema,
  source: z.enum(["manual", "agent", "system", "import"]), kind: text,
  taskId: id.optional(), taskBefore: taskSchema.optional(), taskAfter: taskSchema.optional(),
  operationId: id.optional(), proposalId: id.optional(),
});
export type PlannerEvent = z.infer<typeof plannerEventSchema>;
export const planningHistoryEntrySchema = z.strictObject({
  id, date: localDateSchema, datasetEpoch: id, readOnly: z.boolean(),
  proposal: planningProposalSchema.nullable(), receipt: executionReceiptSchema.nullable(), snapshot: planningSnapshotSchema.nullable(),
  feedback: z.array(planningFeedbackSchema),
  outcomes: z.array(z.strictObject({ taskId: id, title: text, status: z.enum(["completed", "reopened", "rescheduled", "deleted", "restored", "unknown"]), at: instantSchema.nullable() })),
});
export type PlanningHistoryEntry = z.infer<typeof planningHistoryEntrySchema>;
export const planningHistoryResponseSchema = z.strictObject({ date: localDateSchema, entries: z.array(planningHistoryEntrySchema) });
export type PlanningHistoryResponse = z.infer<typeof planningHistoryResponseSchema>;
export const agentStatusSchema = z.strictObject({ configured: z.boolean(), modelId: z.string().nullable(), today: localDateSchema.nullable(), timeZone: timeZoneSchema.nullable() });
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export const todayContextResponseSchema = z.strictObject({ context: dailyContextSchema, version: planningVersionSchema });
export type TodayContextResponse = z.infer<typeof todayContextResponseSchema>;
export const importedAgentArchiveSchema = z.strictObject({
  preferences: agentPreferencesSchema, contexts: z.array(dailyContextSchema), snapshots: z.array(planningSnapshotSchema),
  runs: z.array(agentRunSchema), proposals: z.array(planningProposalSchema), receipts: z.array(executionReceiptSchema),
  feedback: z.array(planningFeedbackSchema), events: z.array(plannerEventSchema),
});
export const agentBackupSchema = z.strictObject({
  format: z.literal("newday-agent"), version: z.literal(1), exportedAt: instantSchema, sourceDatasetEpoch: id,
  scope: z.literal("agent-history-and-explicit-preferences"), preferences: agentPreferencesSchema,
  contexts: z.array(dailyContextSchema), snapshots: z.array(planningSnapshotSchema), runs: z.array(agentRunSchema),
  proposals: z.array(planningProposalSchema), receipts: z.array(executionReceiptSchema), feedback: z.array(planningFeedbackSchema), events: z.array(plannerEventSchema),
  importedHistories: z.array(z.strictObject({ importId: id, importedAt: instantSchema, sourceDatasetEpoch: id, entries: z.array(planningHistoryEntrySchema), archive: importedAgentArchiveSchema.optional() })),
});
export type AgentBackup = z.infer<typeof agentBackupSchema>;
export const importAgentBackupRequestSchema = z.strictObject({ source: z.string().min(1).max(10_000_000), importPreferences: z.boolean() });
export const AGENT_NAMESPACES = {
  preferences: "agent.preferences", context: "agent.context", snapshot: "agent.snapshot", run: "agent.run",
  proposal: "agent.proposal", feedback: "agent.feedback", imported: "agent.import",
} as const;
