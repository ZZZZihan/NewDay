import type { PlanningSnapshot } from "@newday/core/contracts/agent-planning";
import { AgentApiError } from "../http/agent-error.js";
import type { ModelGeneration, ModelRepair, PlanningAnswers, PlanningModel } from "./planning-model.js";

export type ScriptedModelCallback = (
  snapshot: PlanningSnapshot, answers: PlanningAnswers, signal: AbortSignal, repair?: ModelRepair,
) => ModelGeneration | Promise<ModelGeneration>;
export type ScriptedModelStep = unknown | ScriptedModelCallback;

/** Explicit scripted results support deterministic fault tests. This class is
 * never selected as an implicit substitute for an unavailable real provider. */
export class ScriptedPlanningModel implements PlanningModel {
  readonly calls: { snapshot: PlanningSnapshot; answers: PlanningAnswers; signal: AbortSignal; repair?: ModelRepair }[] = [];

  constructor(
    private readonly script: readonly ScriptedModelStep[] | ScriptedModelCallback,
    public readonly modelId = "scripted-fake-v1",
  ) {}

  async generate(snapshot: PlanningSnapshot, answers: PlanningAnswers, signal: AbortSignal, repair?: ModelRepair): Promise<ModelGeneration> {
    signal.throwIfAborted();
    const index = this.calls.length;
    this.calls.push({ snapshot: structuredClone(snapshot), answers: structuredClone(answers), signal, repair });
    const step = typeof this.script === "function" ? this.script : this.script[index];
    if (step === undefined) throw new AgentApiError("MODEL_UNAVAILABLE", 503, "测试模型没有更多预设响应");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return (step as ScriptedModelCallback)(snapshot, answers, signal, repair);
    return { output: structuredClone(step), modelId: this.modelId, usage: { kind: "unknown" } };
  }
}
