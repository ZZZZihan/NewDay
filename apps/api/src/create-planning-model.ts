import type { ApiConfig } from "./config.js";
import type { PlanningModel } from "./agent/planning-model.js";
import { OpenAICompatiblePlanningModel } from "./agent/openai-compatible-model.js";
import { ScriptedPlanningModel } from "./agent/scripted-planning-model.js";

export function createPlanningModel(config: ApiConfig["agent"]): PlanningModel | undefined {
  if (config.provider === "disabled") return undefined;
  if (config.provider === "openai-compatible") return new OpenAICompatiblePlanningModel({
    baseUrl: config.baseUrl, modelId: config.modelId!, apiKey: config.apiKey!, maxOutputTokens: config.maxOutputTokens,
    allowHttpOrigin: config.allowHttpOrigin, reasoningEffort: config.reasoningEffort,
  });
  // loadConfig permits this mode only with NEWDAY_TEST_RUN and an isolated
  // newday-e2e-* database. It is a transport/UI test double, not AI planning.
  return new ScriptedPlanningModel((snapshot, answers) => {
    if (snapshot.context.goals.includes("[e2e:clarify]") && answers.length === 0) return {
      output: { kind: "needs_clarification", questions: [{ id: "priority", question: "今天更希望先推进哪一项？" }], assumptions: [] },
      modelId: "scripted-e2e-v1", usage: { kind: "unknown" },
    };
    const required = new Set(snapshot.context.constraints.filter((constraint) => constraint.kind === "must_include").map((constraint) => constraint.taskId));
    const candidates = snapshot.candidates.filter((candidate) => candidate.executable && !candidate.blocked)
      .sort((a, b) => Number(required.has(b.task.id)) - Number(required.has(a.task.id)))
      .slice(0, snapshot.context.capacity ?? 3);
    return {
      output: candidates.length ? {
        kind: "ready", selections: candidates.map((candidate) => ({ taskId: candidate.task.id, reason: "该任务位于本次可执行任务快照中", factRefs: candidate.factRefs.slice(0, 1) })),
        assumptions: ["这是隔离测试使用的固定建议，不代表模型质量。"],
      } : { kind: "no_action", reason: "当前没有可执行任务", assumptions: [] },
      modelId: "scripted-e2e-v1", usage: { kind: "unknown" },
    };
  }, "scripted-e2e-v1");
}
