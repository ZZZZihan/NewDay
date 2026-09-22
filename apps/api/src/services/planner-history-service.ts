import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_NAMESPACES, agentBackupSchema, agentPreferencesSchema, dateInTimeZone, feedbackRequestSchema,
  planningFeedbackSchema, planningHistoryResponseSchema,
  type AgentBackup, type AgentPreferences, type AgentRun, type DailyContext, type ExecutionReceipt,
  type FeedbackRequest, type PlannerEvent, type PlanningFeedback, type PlanningHistoryEntry,
  type PlanningHistoryResponse, type PlanningProposal, type PlanningSnapshot,
} from "@newday/core/contracts/agent-planning";
import { localDateSchema } from "@newday/core/domain/planner-model";
import { AgentApiError } from "../http/agent-error.js";
import type { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";
import { invalidateReadyProposals, PlannerPreferencesService } from "./planner-preferences-service.js";

type ImportedHistory = AgentBackup["importedHistories"][number];
type HistoryData = Pick<AgentBackup, "snapshots" | "proposals" | "receipts" | "feedback" | "events">;

export class PlannerHistoryService {
  private readonly preferences: PlannerPreferencesService;
  constructor(private readonly store: SQLitePlannerStore, private readonly clock: () => number = Date.now) {
    this.preferences = new PlannerPreferencesService(store, clock);
  }

  history(date: string): Promise<PlanningHistoryResponse> {
    localDateSchema.parse(date);
    return this.store.transaction(async () => {
      const version = await this.store.getPlanningVersion();
      const generation = await this.store.getAgentGeneration();
      const entries = buildHistoryEntries(await this.readHistoryData(), version.datasetEpoch, generation).filter((entry) => entry.date === date);
      const preferences = await this.preferences.getPreferences();
      for (const entry of entries) {
        if (entry.receipt) entry.receipt = {
          ...entry.receipt,
          canRevert: entry.receipt.canRevert && entry.receipt.action === "apply" && entry.receipt.status === "applied" &&
            (entry.receipt.agentGeneration ?? 0) === generation &&
            entry.receipt.afterVersion.datasetEpoch === version.datasetEpoch && entry.receipt.afterVersion.plannerRevision === version.plannerRevision &&
            preferences.timeZone === entry.receipt.timeZone && dateInTimeZone(this.clock(), entry.receipt.timeZone) === entry.receipt.date,
        };
      }
      for (const imported of await this.store.listAgentRecords<ImportedHistory>(AGENT_NAMESPACES.imported)) {
        entries.push(...imported.entries.filter((entry) => entry.date === date).map((entry) => ({
          ...entry, id: historyId(imported.importId, entry.id), readOnly: true,
          receipt: entry.receipt ? { ...entry.receipt, canRevert: false } : null,
        })));
      }
      entries.sort((a, b) => (b.receipt?.executedAt ?? b.proposal?.createdAt ?? "").localeCompare(a.receipt?.executedAt ?? a.proposal?.createdAt ?? ""));
      return planningHistoryResponseSchema.parse({ date, entries });
    });
  }

  feedback(input: FeedbackRequest): Promise<PlanningFeedback> {
    const parsed = feedbackRequestSchema.parse(input);
    return this.store.transaction(async () => {
      const existing = await this.store.getAgentRecord<PlanningFeedback>(AGENT_NAMESPACES.feedback, parsed.feedbackId);
      if (existing) {
        const original = feedbackRequestSchema.parse({
          feedbackId: existing.feedbackId, proposalId: existing.proposalId, operationId: existing.operationId,
          decision: existing.decision, reason: existing.reason,
        });
        if (JSON.stringify(original) !== JSON.stringify(parsed))
          throw new AgentApiError("IDEMPOTENCY_CONFLICT", 409, "这个反馈标识已经用于不同的反馈");
        return existing;
      }
      const proposal = await this.store.getAgentRecord<PlanningProposal>(AGENT_NAMESPACES.proposal, parsed.proposalId);
      if (!proposal) throw new AgentApiError("NOT_FOUND", 404, "找不到这条建议");
      const snapshot = await this.store.getAgentRecord<PlanningSnapshot>(AGENT_NAMESPACES.snapshot, proposal.snapshotId);
      const version = await this.store.getPlanningVersion();
      if (!snapshot || snapshot.version.datasetEpoch !== version.datasetEpoch ||
        (snapshot.agentGeneration ?? 0) !== await this.store.getAgentGeneration())
        throw new AgentApiError("VERSION_CONFLICT", 409, "这条建议所依据的规划历史已失效，只能查看历史");
      const receipt = parsed.operationId ? (await this.store.listExecutionReceipts()).find((value) => value.operationId === parsed.operationId) : undefined;
      if (parsed.operationId && (!receipt || receipt.proposalId !== proposal.proposalId))
        throw new AgentApiError("INVALID_INPUT", 400, "反馈引用的执行回执与建议不匹配");
      if (parsed.decision === "accepted" || parsed.decision === "modified") {
        if (!receipt || receipt.action !== "apply" || proposal.lifecycle !== "applied")
          throw new AgentApiError("PROPOSAL_NOT_EXECUTABLE", 409, "成功执行后才能记录采纳或修改反馈");
        const originalIds = proposal.output.kind === "ready" ? proposal.output.selections.map(({ taskId }) => taskId) : [];
        const wasModified = !sameSet(originalIds, receipt.finalFocusTaskIds);
        if ((parsed.decision === "modified") !== wasModified)
          throw new AgentApiError("INVALID_INPUT", 400, "反馈类型与实际执行的最终重点不一致");
      }
      if (parsed.decision === "rejected") {
        if (proposal.lifecycle !== "ready" || parsed.operationId)
          throw new AgentApiError("PROPOSAL_NOT_EXECUTABLE", 409, "这条建议当前不能再拒绝");
        await this.store.putAgentRecord(AGENT_NAMESPACES.proposal, proposal.proposalId, { ...proposal, lifecycle: "rejected" });
      }
      const feedback = planningFeedbackSchema.parse({ ...parsed, source: "user", at: new Date(this.clock()).toISOString(), datasetEpoch: version.datasetEpoch });
      await this.store.putAgentRecord(AGENT_NAMESPACES.feedback, feedback.feedbackId, feedback);
      return feedback;
    });
  }

  /** Privacy cleanup deletes display details, never the execution dedupe ledger. */
  clearHistory() {
    return this.store.transaction(async () => {
      for (const namespace of [
        AGENT_NAMESPACES.context, AGENT_NAMESPACES.snapshot, AGENT_NAMESPACES.run,
        AGENT_NAMESPACES.proposal, AGENT_NAMESPACES.feedback, AGENT_NAMESPACES.imported,
        "agent.run-request", "agent.run-answer",
      ]) await this.store.deleteAgentRecords(namespace);
      await this.store.deletePlannerEvents();
      await this.store.clearExecutionDetails();
      return { ok: true as const };
    });
  }

  backup(): Promise<AgentBackup> {
    return this.store.transaction(async () => {
      const version = await this.store.getPlanningVersion();
      return agentBackupSchema.parse({
        format: "newday-agent", version: 1, exportedAt: new Date(this.clock()).toISOString(),
        sourceDatasetEpoch: version.datasetEpoch, scope: "agent-history-and-explicit-preferences",
        preferences: await this.preferences.getPreferences(),
        contexts: await this.store.listAgentRecords<DailyContext>(AGENT_NAMESPACES.context),
        runs: await this.store.listAgentRecords<AgentRun>(AGENT_NAMESPACES.run),
        ...await this.readHistoryData(),
        importedHistories: await this.store.listAgentRecords<ImportedHistory>(AGENT_NAMESPACES.imported),
      });
    });
  }

  importBackup(source: string, importPreferences: boolean) {
    let backup: AgentBackup;
    try { backup = agentBackupSchema.parse(JSON.parse(source)); }
    catch { throw new AgentApiError("INVALID_INPUT", 400, "Agent 备份格式无效"); }
    validateArchiveReferences(backup);
    return this.store.transaction(async () => {
      const importId = randomUUID();
      const importedAt = new Date(this.clock()).toISOString();
      const { contexts, snapshots, runs, proposals, receipts, feedback, events, preferences } = backup;
      const imported: ImportedHistory = {
        importId, importedAt, sourceDatasetEpoch: backup.sourceDatasetEpoch,
        entries: buildHistoryEntries(backup, backup.sourceDatasetEpoch).map((entry) => ({ ...entry, readOnly: true })),
        archive: { contexts, snapshots, runs, proposals, receipts, feedback, events, preferences },
      };
      await this.store.putAgentRecord(AGENT_NAMESPACES.imported, importId, imported);
      // Imported namespaces remain separate even when task/proposal IDs match.
      for (const prior of backup.importedHistories) {
        const nestedId = randomUUID();
        await this.store.putAgentRecord(AGENT_NAMESPACES.imported, nestedId, {
          ...prior, importId: nestedId, entries: prior.entries.map((entry) => ({ ...entry, readOnly: true })),
        });
      }
      if (importPreferences) {
        const current = await this.preferences.getPreferences();
        const next: AgentPreferences = agentPreferencesSchema.parse({ ...preferences, revision: current.revision + 1, updatedAt: importedAt });
        await this.store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", next);
      }
      await invalidateReadyProposals(this.store);
      const agentGeneration = await this.store.advanceAgentGeneration();
      const version = await this.store.getPlanningVersion();
      return { ok: true as const, importId, datasetEpoch: version.datasetEpoch, agentGeneration };
    });
  }

  private async readHistoryData(): Promise<HistoryData> {
    return {
      snapshots: await this.store.listAgentRecords<PlanningSnapshot>(AGENT_NAMESPACES.snapshot),
      proposals: await this.store.listAgentRecords<PlanningProposal>(AGENT_NAMESPACES.proposal),
      receipts: await this.store.listExecutionReceipts(),
      feedback: await this.store.listAgentRecords<PlanningFeedback>(AGENT_NAMESPACES.feedback),
      events: await this.store.listPlannerEvents(),
    };
  }
}

/** Derive only recorded transitions. Current task state is never used to invent
 * an earlier result, and a title-only edit does not erase a recorded outcome. */
export function recordedOutcome(event: PlannerEvent): PlanningHistoryEntry["outcomes"][number]["status"] | undefined {
  // A Notion checkbox has no completion timestamp. Its first observation is
  // not evidence that the user completed the task on the scan day.
  if (event.kind === "notion_observed") return undefined;
  const before = event.taskBefore;
  const after = event.taskAfter;
  // Application events also carry taskBefore as an immutable choice snapshot.
  // Absence of taskAfter alone does not prove the task was deleted.
  if (before && !after && ["deleted", "deleteTask", "undo"].includes(event.kind)) return "deleted";
  if (!before && after && /restore|undo|revert/.test(event.kind)) return "restored";
  if (before && after) {
    if (before.status !== "completed" && after.status === "completed") return "completed";
    if (before.status === "completed" && after.status === "open") return "reopened";
    if (before.startDate !== after.startDate || before.endDate !== after.endDate) return "rescheduled";
  }
  return undefined;
}

function buildHistoryEntries(data: HistoryData, currentEpoch: string, currentGeneration?: number): PlanningHistoryEntry[] {
  const snapshots = new Map(data.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const entries: PlanningHistoryEntry[] = [];
  for (const proposal of data.proposals) {
    const snapshot = snapshots.get(proposal.snapshotId);
    if (!snapshot) continue;
    const receipts: (ExecutionReceipt | null)[] = data.receipts.filter((receipt) => receipt.proposalId === proposal.proposalId);
    if (!receipts.length) receipts.push(null);
    for (const receipt of receipts) {
      const selected = receipt?.finalFocusTaskIds ?? (proposal.output.kind === "ready" ? proposal.output.selections.map(({ taskId }) => taskId) : []);
      const since = receipt?.executedAt ?? proposal.createdAt;
      const outcomes = selected.map((taskId): PlanningHistoryEntry["outcomes"][number] => {
        const recorded = receipt ? [...data.events].reverse().filter((event) =>
          event.datasetEpoch === snapshot.version.datasetEpoch && event.date === snapshot.date &&
          event.taskId === taskId && event.at >= since && event.plannerRevision > receipt.afterVersion.plannerRevision && recordedOutcome(event)
        ).sort((a, b) => b.at.localeCompare(a.at))[0] : undefined;
        return {
          taskId, title: snapshot.candidates.find(({ task }) => task.id === taskId)?.task.title ?? recorded?.taskBefore?.title ?? recorded?.taskAfter?.title ?? "历史任务",
          status: recorded ? recordedOutcome(recorded)! : "unknown", at: recorded?.at ?? null,
        };
      });
      entries.push({
        id: historyId(proposal.proposalId, receipt?.operationId ?? ""), date: snapshot.date,
        datasetEpoch: snapshot.version.datasetEpoch, readOnly: snapshot.version.datasetEpoch !== currentEpoch ||
          (currentGeneration !== undefined && (snapshot.agentGeneration ?? 0) !== currentGeneration),
        proposal, receipt, snapshot,
        feedback: data.feedback.filter((feedback) => feedback.proposalId === proposal.proposalId && feedback.datasetEpoch === snapshot.version.datasetEpoch && (!feedback.operationId || feedback.operationId === receipt?.operationId)),
        outcomes,
      });
    }
  }
  return entries;
}

function sameSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function historyId(owner: string, id: string) {
  return `history:${createHash("sha256").update(`${owner}:${id}`).digest("hex").slice(0, 32)}`;
}

function validateArchiveReferences(backup: AgentBackup) {
  for (const [records, key] of [
    [backup.contexts, "id"], [backup.snapshots, "id"], [backup.runs, "runId"], [backup.proposals, "proposalId"],
    [backup.receipts, "operationId"], [backup.feedback, "feedbackId"], [backup.events, "id"],
  ] as const) {
    const ids = records.map((record) => (record as unknown as Record<string, string>)[key]);
    if (new Set(ids).size !== ids.length) throw new AgentApiError("INVALID_INPUT", 400, "Agent 备份包含重复记录标识");
  }
  const snapshots = new Set(backup.snapshots.map(({ id }) => id));
  const proposals = new Set(backup.proposals.map(({ proposalId }) => proposalId));
  for (const proposal of backup.proposals) {
    if (!snapshots.has(proposal.snapshotId)) throw new AgentApiError("INVALID_INPUT", 400, "Agent 备份缺少建议引用的快照");
  }
  for (const receipt of backup.receipts) {
    if (!proposals.has(receipt.proposalId)) throw new AgentApiError("INVALID_INPUT", 400, "Agent 备份缺少回执引用的建议");
  }
}
