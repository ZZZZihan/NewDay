import { captureModelOutputSchema, type CaptureModelInput, type CaptureModelOutput } from "@newday/core/contracts/task-capture";
import { localDateSchema } from "@newday/core/domain/planner-model";
import type { ApiConfig } from "../config.js";
import { OpenAICompatibleTaskCaptureModel, type TaskCaptureModel } from "./task-capture-model.js";

const scriptedModelId = "scripted-e2e-capture-v1";
const repeatedWarning = "暂不支持创建重复规则，请确认单次日期";
const relativeDate = /(今天|明天|后天)/;
const calendarDate = /\d{4}-\d{2}-\d{2}/g;
const excluded = /不要|不用|不需要|不再|取消|已经|已完成|假如|如果|假设|例如|比如|也许|可能|考虑|建议|要不要|是否|[？?]|没有(?:待办|任务|安排)|无(?:待办|任务|安排)/;

export function createTaskCaptureModel(config: ApiConfig["agent"]): TaskCaptureModel | undefined {
  if (config.provider === "disabled") return undefined;
  if (config.provider === "openai-compatible") return new OpenAICompatibleTaskCaptureModel({
    baseUrl: config.baseUrl, modelId: config.modelId!, apiKey: config.apiKey!, maxOutputTokens: config.maxOutputTokens,
    requestProfile: config.requestProfile, allowHttpOrigin: config.allowHttpOrigin, reasoningEffort: config.reasoningEffort,
  });
  if (config.provider !== "scripted") throw new Error("Invalid task capture provider");
  // loadConfig gates this provider to NEWDAY_TEST_RUN and a disposable
  // newday-e2e-* database, exactly like the planning test double. This limited
  // grammar is a deterministic browser fixture, never a fallback for an LLM.
  return {
    modelId: scriptedModelId,
    async generate(input, signal) {
      signal.throwIfAborted();
      return { output: scriptedOutput(input), modelId: scriptedModelId, usage: { kind: "unknown" } };
    },
  };
}

function scriptedOutput(input: CaptureModelInput): CaptureModelOutput {
  const drafts: CaptureModelOutput["drafts"] = [];
  for (const line of input.text.split(/\n/)) {
    const speaker = /^\s*([^：:]{1,30})[：:]/.exec(line);
    if (input.mode === "transcript" && (!speaker || !/^(我|用户|本人|user)$/i.test(speaker[1].trim()))) continue;
    const content = input.mode === "transcript" && speaker ? line.slice(speaker[0].length) : line;
    for (const segment of content.split(/[；;。]/)) {
      const sourceText = segment.trim();
      if (!sourceText) continue;
      const title = normalizeTitle(sourceText);
      if (/取消|不再|不用/.test(sourceText)) {
        // Small fixture grammar for a later explicit cancellation. Real
        // transcript attribution and revisions are evaluated on the provider.
        for (let index = drafts.length - 1; index >= 0; index--) {
          if (sourceText.includes(drafts[index].title)) drafts.splice(index, 1);
        }
      }
      if (!title || excluded.test(sourceText)) continue;
      const repeated = /每天|每周|每月|每年|每个|重复/.test(sourceText);
      const dates = sourceText.match(calendarDate) ?? [];
      const relative = relativeDate.exec(sourceText)?.[1];
      const explicitDate = dates.length ? dates[0] : relative ? shiftedDate(input.today, relative === "今天" ? 0 : relative === "明天" ? 1 : 2) : null;
      const parsedStart = localDateSchema.safeParse(explicitDate);
      const startDate = parsedStart.success ? parsedStart.data : null;
      const finalDate = dates[1] ?? startDate;
      const parsedEnd = localDateSchema.safeParse(finalDate);
      const endDate = parsedEnd.success && startDate && parsedEnd.data >= startDate ? parsedEnd.data : null;
      drafts.push({
        title, notes: `${sourceText}${repeated ? `\n${repeatedWarning}` : ""}`, startDate, endDate, sourceText,
        needsReview: !startDate || !endDate || repeated,
      });
    }
  }
  const output = drafts.length > 20
    ? { drafts: [], message: "事项超过 20 条，请拆成多次提交。这是隔离测试的固定提取结果。" }
    : { drafts, message: drafts.length
      ? `这是隔离测试的固定提取结果，不代表真实模型质量。${drafts.some((draft) => /每天|每周|每月|每年|每个|重复/.test(draft.sourceText)) ? repeatedWarning : ""}`
      : "没有识别到需要加入的本人待办。这是隔离测试的固定提取结果。" };
  return captureModelOutputSchema.parse(output);
}

function shiftedDate(today: string, days: number) {
  const date = new Date(`${today}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeTitle(source: string) {
  return source.replace(/^\s*(?:[-*]|\d+[.、)])\s*/, "")
    .replace(/^(?:请)?(?:帮我|给我)?(?:添加待办[：:]?|加入待办[：:]?)?/, "")
    .replace(/^\d{4}-\d{2}-\d{2}(?:\s*(?:至|到|~|—)\s*\d{4}-\d{2}-\d{2})?\s*/, "")
    .replace(/^(?:今天|明天|后天)\s*/, "").trim().slice(0, 200);
}
