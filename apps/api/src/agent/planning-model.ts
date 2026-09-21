import type { AnswerRunRequest, ModelUsage, PlanningSnapshot } from "@newday/core/contracts/agent-planning";

export type PlanningAnswers = (AnswerRunRequest["answers"][number] & { question?: string })[];
export type ModelRepair = { issues: string[] };
export type ModelGeneration = { output: unknown; modelId: string; usage: ModelUsage };

/** Providers generate data only. Neither a store nor an application command is
 * passed across this boundary. The fourth argument is a single bounded repair. */
export interface PlanningModel {
  readonly modelId: string;
  generate(snapshot: PlanningSnapshot, answers: PlanningAnswers, signal: AbortSignal, repair?: ModelRepair): Promise<ModelGeneration>;
}
