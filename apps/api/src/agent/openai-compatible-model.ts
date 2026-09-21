import { z } from "zod";
import type { ModelUsage, PlanningSnapshot } from "@newday/core/contracts/agent-planning";
import { AgentApiError } from "../http/agent-error.js";
import type { ModelGeneration, ModelRepair, PlanningAnswers, PlanningModel } from "./planning-model.js";
import { planningMessages, planningProviderJsonSchema } from "./planning-prompt.js";

const completionSchema = z.object({
  model: z.string().min(1).max(200),
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional(), tool_calls: z.array(z.unknown()).nullish(), function_call: z.unknown().optional() }),
  })).length(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).nullish(),
});

export type OpenAICompatibleModelOptions = {
  apiKey: string; modelId: string; baseUrl?: string; maxOutputTokens?: number; fetch?: typeof globalThis.fetch;
  requestProfile?: "openai-structured" | "deepseek-json";
  allowHttpOrigin?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high";
};

function parseProviderUrl(source: string, label: string): URL {
  const authority = /^https?:\/\/([^/]+)/i.exec(source)?.[1];
  // URL parsing otherwise removes some controls and normalizes backslashes.
  if (!authority || authority.includes("@") || /[\\?#*]/.test(source) || [...source].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || (code >= 127 && code <= 159);
  })) throw new Error(`Invalid planning provider ${label}`);
  let parsed: URL;
  try { parsed = new URL(source); }
  catch { throw new Error(`Invalid planning provider ${label}`); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hostname.includes("*"))
    throw new Error(`Invalid planning provider ${label}`);
  return parsed;
}

async function readBoundedResponse(response: Response, signal: AbortSignal) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let source = "";
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 200_000) {
        await reader.cancel();
        throw new Error("Oversized model response");
      }
      source += decoder.decode(value, { stream: true });
    }
    return source + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** A narrow Chat Completions adapter; no SDK, tools, automatic retries, or
 * provider secrets enter a persisted record or a browser response.
 * https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create */
export class OpenAICompatiblePlanningModel implements PlanningModel {
  readonly modelId: string;
  private readonly endpoint: string;
  private readonly maxCompletionTokens: number;
  private readonly requestProfile: NonNullable<OpenAICompatibleModelOptions["requestProfile"]>;
  private readonly reasoningEffort: OpenAICompatibleModelOptions["reasoningEffort"];
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: OpenAICompatibleModelOptions) {
    this.modelId = options.modelId.trim();
    if (!this.modelId || !options.apiKey.trim()) throw new Error("Planning provider requires a model and API key");
    const base = parseProviderUrl(options.baseUrl ?? "https://api.openai.com/v1/", "base URL");
    let allowedHttpOrigin: string | undefined;
    if (options.allowHttpOrigin !== undefined) {
      const allowed = parseProviderUrl(options.allowHttpOrigin, "allowed HTTP origin");
      if (allowed.protocol !== "http:" || !/^http:\/\/[^/]+\/?$/i.test(options.allowHttpOrigin))
        throw new Error("Invalid planning provider allowed HTTP origin");
      // URL.origin compares scheme, canonical hostname, and effective port.
      if (allowed.origin !== base.origin) throw new Error("Planning provider allowed HTTP origin must match the base URL origin");
      allowedHttpOrigin = allowed.origin;
    }
    if (base.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) && base.origin !== allowedHttpOrigin)
      throw new Error("Planning provider requires HTTPS except on loopback");
    this.endpoint = `${base.href.replace(/\/$/, "")}/chat/completions`;
    this.maxCompletionTokens = options.maxOutputTokens ?? 2000;
    if (!Number.isInteger(this.maxCompletionTokens) || this.maxCompletionTokens < 1 || this.maxCompletionTokens > 16_000)
      throw new Error("Invalid planning provider output token limit");
    if (options.reasoningEffort !== undefined && !["none", "low", "medium", "high"].includes(options.reasoningEffort))
      throw new Error("Invalid planning provider reasoning effort");
    if (options.requestProfile !== undefined && !["openai-structured", "deepseek-json"].includes(options.requestProfile))
      throw new Error("Invalid planning provider request profile");
    this.requestProfile = options.requestProfile ?? "openai-structured";
    this.reasoningEffort = options.reasoningEffort;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async generate(snapshot: PlanningSnapshot, answers: PlanningAnswers, signal: AbortSignal, repair?: ModelRepair): Promise<ModelGeneration> {
    let response: Response;
    try {
      const common = {
        model: this.modelId,
        messages: planningMessages(snapshot, answers, repair),
        ...(this.reasoningEffort === undefined ? {} : { reasoning_effort: this.reasoningEffort }),
      };
      const body = this.requestProfile === "deepseek-json"
        ? { ...common, response_format: { type: "json_object" }, max_tokens: this.maxCompletionTokens }
        : {
            ...common,
            response_format: { type: "json_schema", json_schema: { name: "newday_planning_v1", strict: true, schema: planningProviderJsonSchema } },
            max_completion_tokens: this.maxCompletionTokens, n: 1, store: false,
          };
      response = await this.fetch(this.endpoint, {
        method: "POST", signal, redirect: "error",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      signal.throwIfAborted();
      throw new AgentApiError("MODEL_UNAVAILABLE", 503, "模型服务暂时无法连接", true);
    }
    if (!response.ok) {
      // Upstream bodies can contain credentials or raw user context. Do not
      // include them in errors, logs, or persisted run metadata.
      await response.body?.cancel();
      if (response.status === 429) throw new AgentApiError("MODEL_RATE_LIMITED", 429, "模型服务请求过于频繁，请稍后重试", true);
      throw new AgentApiError("MODEL_UNAVAILABLE", 503, "模型服务暂时不可用，请检查服务配置", response.status >= 500);
    }
    let body: z.infer<typeof completionSchema>;
    try {
      const source = await readBoundedResponse(response, signal);
      body = completionSchema.parse(JSON.parse(source));
    } catch {
      signal.throwIfAborted();
      throw new AgentApiError("MODEL_INVALID_OUTPUT", 502, "模型返回了无法解析的响应");
    }
    const choice = body.choices[0];
    const message = choice.message;
    if (message.refusal) throw new AgentApiError("MODEL_UNAVAILABLE", 503, "模型没有提供本次规划建议");
    if (choice.finish_reason !== "stop" || !message.content || message.tool_calls?.length || message.function_call)
      throw new AgentApiError("MODEL_INVALID_OUTPUT", 502, "模型返回了不完整或越权的响应");
    let output: unknown;
    try { output = z.strictObject({ output: z.unknown() }).parse(JSON.parse(message.content)).output; }
    catch { throw new AgentApiError("MODEL_INVALID_OUTPUT", 502, "模型返回了不符合格式的建议"); }
    const usage: ModelUsage = body.usage ? { kind: "known", inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens } : { kind: "unknown" };
    return { output, modelId: body.model, usage };
  }
}
