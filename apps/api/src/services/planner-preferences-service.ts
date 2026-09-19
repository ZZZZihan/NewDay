import {
  AGENT_NAMESPACES, agentPreferencesSchema, dateInTimeZone, updatePreferencesRequestSchema,
  type AgentPreferences, type PlanningProposal, type PlanningSnapshot, type UpdatePreferencesRequest,
} from "@newday/core/contracts/agent-planning";
import { AgentApiError } from "../http/agent-error.js";
import type { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";

/** Explicit preferences are independent of planner revision and daily input. */
export class PlannerPreferencesService {
  constructor(private readonly store: SQLitePlannerStore, private readonly clock: () => number = Date.now) {}

  getPreferences(): Promise<AgentPreferences> {
    return this.store.transaction(async () => {
      const existing = await this.store.getAgentRecord<AgentPreferences>(AGENT_NAMESPACES.preferences, "current");
      if (existing) return agentPreferencesSchema.parse(existing);
      const preferences: AgentPreferences = {
        revision: 0, timeZone: null, learningEnabled: true, explicitPreferences: [],
        updatedAt: new Date(this.clock()).toISOString(),
      };
      await this.store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", preferences);
      return preferences;
    });
  }

  async getToday(): Promise<{ date: string; timeZone: string }> {
    const { timeZone } = await this.getPreferences();
    if (!timeZone) throw new AgentApiError("TIME_ZONE_REQUIRED", 409, "请先确认你的时区，再开始今日规划");
    return { date: dateInTimeZone(this.clock(), timeZone), timeZone };
  }

  updatePreferences(input: UpdatePreferencesRequest): Promise<AgentPreferences> {
    const parsed = updatePreferencesRequestSchema.parse(input);
    assertUniqueIds(parsed.explicitPreferences, "偏好标识不能重复");
    return this.store.transaction(async () => {
      const previous = await this.getPreferences();
      if (previous.revision !== parsed.expectedRevision)
        throw new AgentApiError("VERSION_CONFLICT", 409, "偏好已在其他页面修改，请刷新后重试");
      const previousContent = {
        timeZone: previous.timeZone, learningEnabled: previous.learningEnabled,
        explicitPreferences: previous.explicitPreferences.map(({ id, text, source }) => ({ id, text, source })),
      };
      const nextContent = { timeZone: parsed.timeZone, learningEnabled: parsed.learningEnabled, explicitPreferences: parsed.explicitPreferences };
      if (JSON.stringify(previousContent) === JSON.stringify(nextContent)) return previous;
      const now = new Date(this.clock()).toISOString();
      const preferences = agentPreferencesSchema.parse({
        ...nextContent, revision: previous.revision + 1, updatedAt: now,
        explicitPreferences: parsed.explicitPreferences.map((preference) => {
          const old = previous.explicitPreferences.find(({ id, text }) => id === preference.id && text === preference.text);
          return { ...preference, updatedAt: old?.updatedAt ?? now };
        }),
      });
      await this.store.putAgentRecord(AGENT_NAMESPACES.preferences, "current", preferences);
      await invalidateReadyProposals(this.store);
      return preferences;
    });
  }
}

export function assertUniqueIds(values: readonly { id: string }[], message: string) {
  if (new Set(values.map(({ id }) => id)).size !== values.length)
    throw new AgentApiError("INVALID_INPUT", 400, message);
}

/** Called inside the transaction which changed the referenced input. */
export async function invalidateReadyProposals(store: SQLitePlannerStore, contextId?: string) {
  const proposals = await store.listAgentRecords<PlanningProposal>(AGENT_NAMESPACES.proposal);
  for (const proposal of proposals) {
    if (proposal.lifecycle !== "ready") continue;
    if (contextId !== undefined) {
      const snapshot = await store.getAgentRecord<PlanningSnapshot>(AGENT_NAMESPACES.snapshot, proposal.snapshotId);
      if (snapshot?.context.id !== contextId) continue;
    }
    await store.putAgentRecord(AGENT_NAMESPACES.proposal, proposal.proposalId, { ...proposal, lifecycle: "superseded" });
  }
}
