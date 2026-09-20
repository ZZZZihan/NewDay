import { z } from "zod";
import {
  AGENT_NAMESPACES, dateInTimeZone, planningSnapshotSchema,
  timeZoneSchema, type ExplicitConstraint, type PlanningFeedback,
} from "@newday/core/contracts/agent-planning";
import { instantSchema, localDateSchema, taskSchema } from "@newday/core/domain/planner-model";
import { PlannerContextService } from "../../../apps/api/src/services/planner-context-service.js";
import { PlannerPreferencesService } from "../../../apps/api/src/services/planner-preferences-service.js";
import { MemoryAgentStore } from "../../../apps/api/src/storage/sqlite-planner-store.js";

const fixtureFactSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["blocked", "maximum_focus_count", "requires_task", "unavailable_resource", "energy"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
  taskId: z.string().nullable(),
  source: z.literal("explicit_user_input"),
});
const fixtureHistorySchema = z.union([
  z.strictObject({ kind: z.literal("preference_deleted"), text: z.string(), source: z.literal("explicit_user_action") }),
  z.strictObject({ kind: z.literal("rejected"), reason: z.string().nullable(), source: z.literal("user_feedback"), date: localDateSchema }),
]);
export const evaluationScenarioInputSchema = z.strictObject({
  id: z.string().min(1),
  category: z.string().min(1), family: z.string().min(1), title: z.string().min(1), expected: z.unknown(),
  clarificationAnswers: z.record(z.string(), z.string()).optional(),
  input: z.strictObject({
    date: localDateSchema, timeZone: timeZoneSchema, sampledAt: instantSchema,
    tasks: z.array(taskSchema), currentFocusTaskIds: z.array(z.string().min(1)),
    context: z.strictObject({
      goal: z.string().min(1), energy: z.enum(["low", "normal", "high"]).nullable(),
      capacity: z.number().int().min(1).max(3).nullable(), facts: z.array(fixtureFactSchema),
    }),
    preferences: z.array(z.strictObject({
      id: z.string().min(1), text: z.string().min(1), source: z.literal("explicit_user_input"), strength: z.literal("soft"),
    })),
    priorHistory: z.array(fixtureHistorySchema),
  }),
});

export type PreparedEvaluationScenario = {
  id: string;
  snapshot: z.infer<typeof planningSnapshotSchema>;
  gaps: string[];
  adaptations: string[];
};

/** Build the exact snapshot shape through the production context service.
 * The frozen corpus is a specification, not an API request. Unsupported
 * source facts are reported as gaps instead of being silently discarded. */
export async function prepareEvaluationScenario(value: unknown): Promise<PreparedEvaluationScenario> {
  const scenario = evaluationScenarioInputSchema.parse(value);
  const { input } = scenario;
  if (dateInTimeZone(new Date(input.sampledAt), input.timeZone) !== input.date)
    throw new Error(`${scenario.id}: sampledAt is outside its stated local date`);
  const taskIds = new Set(input.tasks.map(({ id }) => id));
  const clock = () => Date.parse(input.sampledAt);
  const store = new MemoryAgentStore();
  const gaps: string[] = [];
  const adaptations: string[] = [];
  for (const task of input.tasks) {
    const futureFields = (["createdAt", "updatedAt", "completedAt"] as const).filter((field) => {
      const at = task[field];
      return at !== null && Date.parse(at) > Date.parse(input.sampledAt);
    });
    if (futureFields.length)
      gaps.push(`task ${task.id}: ${futureFields.join(", ")} are later than sampledAt; the snapshot cannot reconstruct this task's earlier state`);
  }
  if (scenario.clarificationAnswers)
    gaps.push("clarificationAnswers: fixture keys do not identify the model's generated question IDs for a second call");
  try {
    await store.transaction(async () => {
      for (const task of input.tasks) await store.putTask(task);
      for (const taskId of input.currentFocusTaskIds) {
        if (!taskIds.has(taskId)) throw new Error(`${scenario.id}: focus names an absent task ${taskId}`);
        await store.putFocusRecord({ id: `fixture-focus:${taskId}`, date: input.date, taskId, focusedAt: input.sampledAt });
      }
    });
    // Fixture setup is not prior user behavior. Prevent its insert events from
    // entering scenarios that intentionally supply a separate history.
    await store.deletePlannerEvents();

    const preferences = new PlannerPreferencesService(store, clock);
    const beforePreferences = await preferences.getPreferences();
    adaptations.push(`learningEnabled: unspecified by fixture -> production default ${beforePreferences.learningEnabled}`);
    for (const preference of input.preferences)
      adaptations.push(`preference ${preference.id}: soft -> production explicit preference fact; no hard-constraint enforcement`);
    await preferences.updatePreferences({
      expectedRevision: beforePreferences.revision, timeZone: input.timeZone,
      learningEnabled: beforePreferences.learningEnabled,
      explicitPreferences: input.preferences.map(({ id, text }) => ({ id, text, source: "user" as const })),
    });

    let energy: "low" | "normal" | "high" | null = input.context.energy;
    let capacity = input.context.capacity;
    const constraints: ExplicitConstraint[] = [];
    for (const fact of input.context.facts) {
      if (fact.taskId && !taskIds.has(fact.taskId)) throw new Error(`${scenario.id}: fact ${fact.id} names an absent task`);
      switch (fact.kind) {
        case "blocked":
          if (fact.value !== true || !fact.taskId) throw new Error(`${scenario.id}: malformed blocked fact ${fact.id}`);
          constraints.push({ id: fact.id, kind: "blocked_task", taskId: fact.taskId,
            value: `评测输入明确标记任务 ${fact.taskId} 当前不可执行`, source: "user", sourceText: `结构化输入：${fact.id}=blocked` });
          adaptations.push(`${fact.id}: blocked -> blocked_task`);
          break;
        case "maximum_focus_count":
          if (!Number.isInteger(fact.value) || typeof fact.value !== "number" || fact.value < 1 || fact.value > 3)
            throw new Error(`${scenario.id}: malformed capacity fact ${fact.id}`);
          if (capacity !== null && capacity !== fact.value) throw new Error(`${scenario.id}: conflicting capacity facts`);
          capacity = fact.value;
          adaptations.push(`${fact.id}: maximum_focus_count -> context.capacity`);
          break;
        case "energy":
          if (fact.value !== "low" && fact.value !== "normal" && fact.value !== "high")
            throw new Error(`${scenario.id}: malformed energy fact ${fact.id}`);
          if (energy !== null && energy !== fact.value) throw new Error(`${scenario.id}: conflicting energy facts`);
          energy = fact.value;
          adaptations.push(`${fact.id}: energy -> context.energy`);
          break;
        case "requires_task":
          if (!fact.taskId || typeof fact.value !== "string" || !taskIds.has(fact.value))
            throw new Error(`${scenario.id}: malformed dependency fact ${fact.id}`);
          constraints.push({ id: fact.id, kind: "other", taskId: fact.taskId,
            value: `任务 ${fact.taskId} 需要先完成任务 ${fact.value}`, source: "user", sourceText: `结构化输入：${fact.id}=requires_task:${fact.value}` });
          adaptations.push(`${fact.id}: requires_task -> free-text other constraint; host does not enforce dependency`);
          break;
        case "unavailable_resource":
          if (!fact.taskId || typeof fact.value !== "string") throw new Error(`${scenario.id}: malformed resource fact ${fact.id}`);
          constraints.push({ id: fact.id, kind: "blocked_task", taskId: fact.taskId,
            value: `任务 ${fact.taskId} 所需资源 ${fact.value} 当前不可用`, source: "user", sourceText: `结构化输入：${fact.id}=unavailable_resource:${fact.value}` });
          adaptations.push(`${fact.id}: unavailable_resource -> blocked_task`);
          break;
      }
    }

    const contexts = new PlannerContextService(store, clock);
    const beforeContext = await contexts.getTodayContext();
    await contexts.updateTodayContext({
      expectedRevision: beforeContext.context.revision, goals: [input.context.goal], energy, capacity, constraints,
    });

    for (const [index, history] of input.priorHistory.entries()) {
      if (history.kind === "preference_deleted") {
        gaps.push(`priorHistory[${index}]: deleted preference has no representation in the production snapshot`);
        continue;
      }
      const at = `${history.date}T08:00:00.000Z`;
      if (at > input.sampledAt) throw new Error(`${scenario.id}: prior feedback is later than sampledAt`);
      const feedback: PlanningFeedback = {
        feedbackId: `fixture-feedback:${scenario.id}:${index}`, proposalId: `fixture-proposal:${scenario.id}:${index}`,
        decision: "rejected", source: "user", at, datasetEpoch: beforeContext.version.datasetEpoch,
        ...(history.reason === null ? {} : { reason: history.reason }),
      };
      await store.putAgentRecord(AGENT_NAMESPACES.feedback, feedback.feedbackId, feedback);
      adaptations.push(`priorHistory[${index}]: rejected on ${history.date} -> recorded user feedback at synthetic ${at}; time of day was not supplied`);
    }

    const snapshot = planningSnapshotSchema.parse(await contexts.createSnapshot());
    if (snapshot.currentFocusTaskIds.length !== input.currentFocusTaskIds.length ||
      input.currentFocusTaskIds.some((taskId) => !snapshot.currentFocusTaskIds.includes(taskId)))
      gaps.push("currentFocusTaskIds: at least one fixture focus is not present in the production snapshot");
    return { id: scenario.id, snapshot, gaps, adaptations };
  } finally {
    store.close();
  }
}
