import { describe, expect, it } from "vitest";
import {
  AGENT_NAMESPACES, agentBackupSchema, agentErrorSchema, agentPreferencesSchema, agentRunResponseSchema, agentRunSchema,
  applyProposalRequestSchema, dailyContextSchema, dateInTimeZone, executionReceiptSchema,
  explicitConstraintSchema, modelUsageSchema, operationResultSchema, planningFeedbackSchema,
  planningHistoryResponseSchema, planningModelOutputSchema, planningProposalSchema, planningSnapshotSchema,
  planningVersionSchema, timeZoneSchema,
} from "@newday/core/contracts/agent-planning";
import {
  applyRequestFixture, backupFixture, clarificationOutputFixture, clarificationProposalFixture,
  conflictErrorFixture, contextFixture, feedbackFixture, historyFixture, noActionOutputFixture,
  noActionProposalFixture, noChangeReceiptFixture, operationDetailsDeletedFixture, operationFoundFixture,
  operationNotFoundFixture, operationUnknownFixture, preferencesFixture, readyOutputFixture,
  readyProposalFixture, receiptFixture, runFixture, runResponseFixture, snapshotFixture, versionFixture,
} from "../fixtures/contracts";

const examples = [
  ["planning version", planningVersionSchema, versionFixture],
  ["daily context", dailyContextSchema, contextFixture],
  ["preferences", agentPreferencesSchema, preferencesFixture],
  ["snapshot", planningSnapshotSchema, snapshotFixture],
  ["ready model output", planningModelOutputSchema, readyOutputFixture],
  ["clarification model output", planningModelOutputSchema, clarificationOutputFixture],
  ["no action model output", planningModelOutputSchema, noActionOutputFixture],
  ["ready proposal", planningProposalSchema, readyProposalFixture],
  ["clarification proposal", planningProposalSchema, clarificationProposalFixture],
  ["no action proposal", planningProposalSchema, noActionProposalFixture],
  ["run", agentRunSchema, runFixture],
  ["run response", agentRunResponseSchema, runResponseFixture],
  ["apply request", applyProposalRequestSchema, applyRequestFixture],
  ["receipt", executionReceiptSchema, receiptFixture],
  ["no change receipt", executionReceiptSchema, noChangeReceiptFixture],
  ["conflict", agentErrorSchema, conflictErrorFixture],
  ["operation unknown", agentErrorSchema, operationUnknownFixture],
  ["operation found", operationResultSchema, operationFoundFixture],
  ["operation not found", operationResultSchema, operationNotFoundFixture],
  ["operation details deleted", operationResultSchema, operationDetailsDeletedFixture],
  ["feedback", planningFeedbackSchema, feedbackFixture],
  ["history", planningHistoryResponseSchema, historyFixture],
  ["agent backup", agentBackupSchema, backupFixture],
] as const;

describe("frozen Agent v1 wire contract", () => {
  it.each(examples)("round trips the shared %s fixture without stripping fields", (_name, schema, value) => {
    expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });
  it("rejects model-supplied host identities and arbitrary commands", () => {
    expect(planningModelOutputSchema.safeParse({ ...readyOutputFixture, proposalId: "forged" }).success).toBe(false);
    expect(planningModelOutputSchema.safeParse({ kind: "ready", selections: readyOutputFixture.selections, assumptions: [], commands: [{ type: "deleteTask", taskId: "task-report" }] }).success).toBe(false);
  });
  it("bounds selection count and clarification questions", () => {
    expect(planningModelOutputSchema.safeParse({ ...readyOutputFixture, selections: [] }).success).toBe(false);
    expect(planningModelOutputSchema.safeParse({ ...readyOutputFixture, selections: Array(4).fill(readyOutputFixture.selections[0]) }).success).toBe(false);
    expect(planningModelOutputSchema.safeParse({ ...clarificationOutputFixture, questions: Array(3).fill(clarificationOutputFixture.questions[0]) }).success).toBe(false);
  });
  it("requires a nonempty unique final selection for ordinary apply", () => {
    for (const taskIds of [[], ["task-report", "task-report"], ["a", "b", "c", "d"]]) {
      expect(applyProposalRequestSchema.safeParse({ ...applyRequestFixture, taskIds }).success).toBe(false);
    }
  });
  it("preserves unknown usage and context instead of silently converting them to zero or facts", () => {
    expect(modelUsageSchema.parse({ kind: "unknown" })).toEqual({ kind: "unknown" });
    expect(modelUsageSchema.safeParse({ kind: "unknown", inputTokens: 0, outputTokens: 0 }).success).toBe(false);
    expect(dailyContextSchema.parse(contextFixture).energy).toBeNull();
    expect(modelUsageSchema.safeParse({ kind: "known", inputTokens: -1, outputTokens: 0 }).success).toBe(false);
  });
  it("requires an explicit user source and task identity for task constraints", () => {
    const constraint = contextFixture.constraints[0];
    expect(explicitConstraintSchema.safeParse({ ...constraint, source: "task_notes" }).success).toBe(false);
    expect(explicitConstraintSchema.safeParse({ ...constraint, taskId: undefined }).success).toBe(false);
  });
  it("bounds run retries and clarification rounds", () => {
    expect(agentRunSchema.safeParse({ ...runFixture, callCount: 4 }).success).toBe(false);
    expect(agentRunSchema.safeParse({ ...runFixture, clarificationRound: 2 }).success).toBe(false);
  });
  it("keeps unconfirmed transport state separate from execution receipts", () => {
    expect(operationUnknownFixture.code).toBe("RESULT_UNKNOWN");
    expect(executionReceiptSchema.safeParse(operationUnknownFixture).success).toBe(false);
    expect(operationResultSchema.safeParse({ ...operationDetailsDeletedFixture, detailsDeleted: false }).success).toBe(false);
  });
  it.each([
    ["2026-09-08T12:30:00.000Z", "Pacific/Kiritimati", "2026-09-09"],
    ["2026-09-08T02:30:00.000Z", "America/Los_Angeles", "2026-09-07"],
    ["2026-11-01T05:30:00.000Z", "America/New_York", "2026-11-01"],
    ["2026-11-01T06:30:00.000Z", "America/New_York", "2026-11-01"],
  ])("resolves %s in %s to the user's actual date", (instant, zone, date) => {
    expect(dateInTimeZone(new Date(instant), zone)).toBe(date);
  });
  it("rejects an invalid zone and keeps repository namespaces unique", () => {
    expect(timeZoneSchema.safeParse("Server/Guess").success).toBe(false);
    expect(new Set(Object.values(AGENT_NAMESPACES)).size).toBe(Object.values(AGENT_NAMESPACES).length);
  });
});
