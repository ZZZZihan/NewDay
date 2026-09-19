import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  agentPreferencesSchema, agentRunResponseSchema, dateInTimeZone, todayContextResponseSchema,
} from "@newday/core/contracts/agent-planning";
import { createApp } from "../apps/api/src/app.js";
import { loadConfig, repositoryRoot } from "../apps/api/src/config.js";
import type { PlanningModel } from "../apps/api/src/agent/planning-model.js";
import { OpenAICompatiblePlanningModel } from "../apps/api/src/agent/openai-compatible-model.js";

// Explicit live command only. Never imported by check, unit tests or E2E.
const { values } = parseArgs({ options: {
  env: { type: "string", default: join(repositoryRoot, ".env") },
  output: { type: "string" },
  "max-calls": { type: "string", default: "1" },
  preflight: { type: "boolean", default: false },
} });
if (existsSync(values.env)) process.loadEnvFile(values.env);
const config = loadConfig();
if (config.agent.provider !== "openai-compatible") throw new Error("Live smoke requires an explicitly configured openai-compatible provider");
const maxCalls = Number(values["max-calls"]);
if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 3) throw new Error("--max-calls must be between 1 and 3");
const calls: { startedAt: string; status?: number; headersMs?: number; elapsedMs?: number; outcome?: string; providerError?: Record<string, string>; completion?: Record<string, unknown> }[] = [];
const model = new OpenAICompatiblePlanningModel({
  baseUrl: config.agent.baseUrl, apiKey: config.agent.apiKey!, modelId: config.agent.modelId!,
  allowHttpOrigin: config.agent.allowHttpOrigin, reasoningEffort: config.agent.reasoningEffort,
  maxOutputTokens: config.agent.maxOutputTokens,
  fetch: async (url, options) => {
    if (calls.length >= maxCalls) throw new Error("Live smoke outbound call limit reached");
    const call: typeof calls[number] = { startedAt: new Date().toISOString() };
    calls.push(call);
    const started = performance.now();
    try {
      const response = await fetch(url, options);
      call.status = response.status;
      call.headersMs = Math.round(performance.now() - started);
      call.outcome = "response_received";
      if (!response.ok) call.providerError = await diagnosticError(response.clone(), config.agent.apiKey!);
      else call.completion = await diagnosticCompletion(response.clone(), config.agent.apiKey!);
      return response;
    } catch {
      call.outcome = "transport_error_or_abort";
      throw new Error("Live smoke provider transport failed");
    } finally { call.elapsedMs = Math.round(performance.now() - started); }
  },
});
const generationDiagnostics: { repairIssues?: string[]; error?: string }[] = [];
const planningModel: PlanningModel = {
  modelId: model.modelId,
  async generate(snapshot, answers, signal, repair) {
    const diagnostic: typeof generationDiagnostics[number] = { ...(repair ? { repairIssues: repair.issues } : {}) };
    generationDiagnostics.push(diagnostic);
    try { return await model.generate(snapshot, answers, signal, repair); }
    catch (error) {
      diagnostic.error = error instanceof Error ? error.message.replaceAll(config.agent.apiKey!, "[REDACTED]") : "Unknown generation error";
      throw error;
    }
  },
};
const settings = {
  providerOrigin: new URL(config.agent.baseUrl).origin,
  endpointSha256: hash(config.agent.baseUrl), configuredModel: model.modelId,
  reasoningEffort: config.agent.reasoningEffort ?? "provider_default",
  maxOutputTokens: config.agent.maxOutputTokens, timeoutMs: config.agent.timeoutMs,
  maxOutboundCalls: maxCalls, dataScope: "three synthetic tasks; no development database or heldout cases",
};
if (values.preflight) {
  console.log(JSON.stringify({ preflight: "passed", realProviderCalls: 0, ...settings }, null, 2));
} else {
  const directory = await mkdtemp(join(tmpdir(), "newday-agent-live-"));
  const databasePath = join(directory, "planner.sqlite");
  const output = values.output ? resolve(values.output) : directory;
  await mkdir(output, { recursive: true });
  const app = createApp({ databasePath, planningModel, logger: false, agentTimeoutMs: config.agent.timeoutMs });
  const started = performance.now();
  let report: Record<string, unknown> = { format: "newday-live-smoke-v1", createdAt: new Date().toISOString(), ...settings, databasePath, calls, generationDiagnostics };
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    async function request(method: string, path: string, body?: unknown) {
      const response = await fetch(`${origin}${path}`, {
        method, headers: { "content-type": "application/json", "x-newday-client": "synthetic-live-smoke" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Synthetic local API returned HTTP ${response.status} for ${path}`);
      return response.json() as Promise<unknown>;
    }
    const preferences = agentPreferencesSchema.parse(await request("GET", "/api/agent/preferences"));
    await request("PUT", "/api/agent/preferences", { expectedRevision: preferences.revision, timeZone: "Asia/Shanghai", learningEnabled: false, explicitPreferences: [] });
    const now = new Date().toISOString();
    const date = dateInTimeZone(Date.now(), "Asia/Shanghai");
    const tasks = [
      { id: "smoke-report", title: "整理合成项目汇报" },
      { id: "smoke-check", title: "核对合成样例数据" },
      { id: "smoke-desk", title: "整理测试桌面" },
    ];
    await request("POST", "/api/planner/commands", { commands: [
      ...tasks.map((task) => ({ type: "createTask", input: { ...task, startDate: date, endDate: date, now } })),
      { type: "setTodayFocus", input: { taskId: "smoke-desk", date, now } },
    ] });
    const context = todayContextResponseSchema.parse(await request("GET", "/api/agent/context/today"));
    await request("PUT", "/api/agent/context/today", {
      expectedRevision: context.context.revision, goals: ["今天优先推进合成项目汇报和样例数据核对"], energy: "normal", capacity: 2,
      constraints: tasks.slice(0, 2).map((task) => ({ id: `required-${task.id}`, kind: "must_include", taskId: task.id, source: "user", value: "本次合成测试明确要求纳入", sourceText: `今天必须纳入：${task.title}` })),
    });
    const beforeVersion = todayContextResponseSchema.parse(await request("GET", "/api/agent/context/today")).version;
    const before = businessState(databasePath);
    const created = agentRunResponseSchema.parse(await request("POST", "/api/agent/runs", { requestId: randomUUID() }));
    let result = created;
    const deadline = performance.now() + config.agent.timeoutMs * maxCalls + 5_000;
    while (result.run.status === "running" && performance.now() < deadline) {
      await delay(250);
      result = agentRunResponseSchema.parse(await request("GET", `/api/agent/runs/${created.run.runId}`));
    }
    if (result.run.status === "running") {
      result = agentRunResponseSchema.parse(await request("POST", `/api/agent/runs/${created.run.runId}/cancel`, {}));
    }
    const after = businessState(databasePath);
    const afterVersion = todayContextResponseSchema.parse(await request("GET", "/api/agent/context/today")).version;
    assert.deepEqual(after, before, "Generation must not change tasks, focus, events or execution ledger");
    assert.deepEqual(afterVersion, beforeVersion, "Generation must not change the planning version");
    assert.equal(after.execution_ledger.length, 0);
    assert(calls.length > 0 && calls.length <= maxCalls);
    report = { ...report, run: result.run, snapshot: result.snapshot, proposal: result.proposal,
      snapshotSha256: hash(JSON.stringify(result.snapshot)), businessStateUnchanged: true, beforeVersion, afterVersion,
      executionReceipts: 0, elapsedMs: Math.round(performance.now() - started),
      actualCost: null, costExplanation: "Provider pricing unavailable; token usage is not a monetary amount",
      acceptance: result.run.status === "ready" ? "real_generation_smoke_passed" : "no_ready_proposal",
      G3: "not evaluated; this smoke is not the 120-trial model-quality evaluation" };
    if (result.run.status !== "ready") process.exitCode = 1;
  } catch (error) {
    report = { ...report, acceptance: "smoke_failed", error: error instanceof Error ? error.message.replaceAll(config.agent.apiKey!, "[REDACTED]") : "Unknown smoke failure" };
    process.exitCode = 1;
  } finally {
    await app.close();
    // All persisted inputs are generated above; credentials are never included.
    const reportPath = join(output, "report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    await writeFile(join(output, "report.sha256"), hash(await readFile(reportPath)) + "\n");
    console.log(JSON.stringify({ reportPath, acceptance: report.acceptance, realProviderCalls: calls.length, elapsedMs: report.elapsedMs }, null, 2));
  }
}

function hash(source: string | Buffer) { return createHash("sha256").update(source).digest("hex"); }
async function diagnosticError(response: Response, apiKey: string): Promise<Record<string, string> | undefined> {
  // Only synthetic smoke data reaches this path. Capture a bounded, redacted
  // error description for protocol diagnosis; never save the raw body/headers.
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let source = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) return undefined;
      source += decoder.decode(value, { stream: true });
    }
    const body: unknown = JSON.parse(source + decoder.decode());
    if (!body || typeof body !== "object" || !("error" in body) || !body.error || typeof body.error !== "object") return undefined;
    return Object.fromEntries(["code", "type", "param", "message"].flatMap((key) => {
      const value = (body.error as Record<string, unknown>)[key];
      return typeof value === "string" ? [[key, value.replaceAll(apiKey, "[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 1500)]] : [];
    }));
  } catch { return undefined; }
  finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
async function diagnosticCompletion(response: Response, apiKey: string): Promise<Record<string, unknown> | undefined> {
  // Only this explicit synthetic runner retains response text for offline
  // diagnosis. The production adapter never persists provider bodies.
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let source = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 200_000) return { diagnostic: "response_exceeds_capture_limit" };
      source += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(source + decoder.decode()) as Record<string, unknown>;
    const redact = (value: unknown) => typeof value === "string"
      ? value.replaceAll(apiKey, "[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 32_000) : null;
    return {
      model: redact(body.model),
      choices: Array.isArray(body.choices) ? body.choices.slice(0, 2).map((choice: Record<string, unknown>) => {
        const message = choice.message as Record<string, unknown> | undefined;
        return { finish_reason: redact(choice.finish_reason), message: { content: redact(message?.content), refusal: redact(message?.refusal) },
          messageShape: Object.fromEntries(["content", "refusal", "tool_calls", "function_call"].map((key) => [key,
            message?.[key] === null ? "null" : Array.isArray(message?.[key]) ? `array:${message[key].length}` : typeof message?.[key],
          ])),
        };
      }) : null,
      usage: body.usage && typeof body.usage === "object" ? Object.fromEntries(
        ["prompt_tokens", "completion_tokens", "total_tokens"].flatMap((key) => {
          const value = (body.usage as Record<string, unknown>)[key];
          return typeof value === "number" ? [[key, value]] : [];
        }),
      ) : null,
    };
  } catch { return { diagnostic: "unparseable_response" }; }
  finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function businessState(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      tasks: database.prepare("SELECT * FROM tasks ORDER BY id").all(),
      focus_records: database.prepare("SELECT * FROM focus_records ORDER BY id").all(),
      recurrence_series: database.prepare("SELECT * FROM recurrence_series ORDER BY id").all(),
      planner_events: database.prepare("SELECT * FROM planner_events ORDER BY id").all(),
      execution_ledger: database.prepare("SELECT * FROM execution_ledger ORDER BY operation_id").all(),
    };
  } finally { database.close(); }
}
