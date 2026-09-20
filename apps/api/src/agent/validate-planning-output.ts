import { planningModelOutputSchema } from "@newday/core/contracts/agent-planning";
import type { PlanningModelOutput, PlanningSnapshot } from "@newday/core/contracts/agent-planning";
import { AgentApiError } from "../http/agent-error.js";

export class InvalidPlanningOutputError extends AgentApiError {
  constructor(message: string, public readonly repairable: boolean, public readonly issues: string[] = []) {
    super("MODEL_INVALID_OUTPUT", 502, message);
  }
}

export function executableCandidates(snapshot: PlanningSnapshot) {
  const blocked = new Set(snapshot.context.constraints.filter((value) => value.kind === "blocked_task").map((value) => value.taskId));
  return snapshot.candidates.filter((candidate) => candidate.executable && !candidate.blocked &&
    candidate.task.status === "open" && !candidate.task.archived && candidate.task.startDate !== null && candidate.task.startDate <= snapshot.date && !blocked.has(candidate.task.id));
}

/** Host-determined no-action cases avoid sending needless model requests. */
export function forcedNoAction(snapshot: PlanningSnapshot): PlanningModelOutput | undefined {
  if (snapshot.context.constraints.some((value) => value.kind === "rest"))
    return { kind: "no_action", reason: "你已明确今天休息，现有重点保持不变。", assumptions: [] };
  const eligible = new Set(executableCandidates(snapshot).map((candidate) => candidate.task.id));
  if (!eligible.size) return { kind: "no_action", reason: "今天没有可直接执行的未完成任务，现有重点保持不变。", assumptions: [] };
  const required = new Set(snapshot.context.constraints.filter((value) => value.kind === "must_include").map((value) => value.taskId));
  if (required.size > (snapshot.context.capacity ?? 3) || [...required].some((id) => !id || !eligible.has(id)))
    return { kind: "no_action", reason: "当前候选任务无法同时满足你明确的必选任务与可承担量，请调整约束后重新规划。", assumptions: [] };
}

/** Deterministic checks establish identity/provenance and explicit constraints.
 * Free-text entailment remains a separately evaluated model-quality question. */
export function validatePlanningOutput(raw: unknown, snapshot: PlanningSnapshot, clarificationRound: number): PlanningModelOutput {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); }
    catch { throw new InvalidPlanningOutputError("模型返回的建议不是有效 JSON", true, ["Return one valid JSON output object."]); }
  }
  const parsed = planningModelOutputSchema.safeParse(value);
  if (!parsed.success) throw new InvalidPlanningOutputError("模型返回的建议不符合约定格式", true,
    parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join(".")}: ${issue.code}`));
  const output = parsed.data;
  if (output.kind === "needs_clarification") {
    if (clarificationRound > 0) throw new AgentApiError("CLARIFICATION_LIMIT", 422, "本轮已完成一次澄清，模型未能给出最终建议");
    if (new Set(output.questions.map((question) => question.id)).size !== output.questions.length)
      throw new InvalidPlanningOutputError("模型返回了重复的澄清问题标识", false);
    return output;
  }
  if (output.kind !== "ready") return output;
  const noAction = forcedNoAction(snapshot);
  if (noAction) throw new InvalidPlanningOutputError("模型建议违反了明确的休息或任务约束", false);
  const selected = new Set(output.selections.map((selection) => selection.taskId));
  if (selected.size !== output.selections.length) throw new InvalidPlanningOutputError("模型重复选择了同一任务", false);
  if (selected.size > (snapshot.context.capacity ?? 3)) throw new InvalidPlanningOutputError("模型选择的任务超过了明确的可承担量", false);
  const required = snapshot.context.constraints.filter((value) => value.kind === "must_include");
  if (required.some((value) => !value.taskId || !selected.has(value.taskId)))
    throw new InvalidPlanningOutputError("模型遗漏了明确要求纳入的任务", false);
  const candidates = new Map(executableCandidates(snapshot).map((candidate) => [candidate.task.id, candidate]));
  const facts = new Map(snapshot.facts.map((fact) => [fact.id, fact]));
  for (const selection of output.selections) {
    const candidate = candidates.get(selection.taskId);
    if (!candidate) throw new InvalidPlanningOutputError("模型选择了未知、已完成、未来或受阻的任务", false);
    if (new Set(selection.factRefs).size !== selection.factRefs.length || selection.factRefs.some((ref) => !facts.has(ref)))
      throw new InvalidPlanningOutputError("模型引用了不存在或重复的事实来源", false);
    if (!selection.factRefs.some((ref) => candidate.factRefs.includes(ref) && facts.get(ref)?.taskId === selection.taskId))
      throw new InvalidPlanningOutputError("模型理由没有引用所选任务的事实来源", false);
    const hasDeadlineClaim = /硬(?:性)?截止|(?:必须|务必|最迟).{0,12}(?:今天|今日|今晚)|(?:今天|今日|今晚).{0,12}(?:必须|截止|到期)|deadline|must.{0,24}today/i.test(selection.reason);
    if (hasDeadlineClaim) {
      const deadlineIds = new Set(snapshot.context.constraints.filter((constraint) =>
        constraint.kind === "hard_deadline" && constraint.taskId === selection.taskId && constraint.source === "user").map((constraint) => constraint.id));
      if (!selection.factRefs.some((ref) => { const fact = facts.get(ref)!;
        return fact.source === "context" && fact.taskId === selection.taskId && fact.constraintId && deadlineIds.has(fact.constraintId);
      })) throw new InvalidPlanningOutputError("模型把排程日期解释成了未经明确提供的硬截止", false);
    }
  }
  return output;
}
