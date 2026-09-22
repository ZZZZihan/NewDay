import assert from "node:assert/strict";
import test from "node:test";
import { readyOutputFixture, snapshotFixture } from "../../../tests/agent/fixtures/contracts.js";
import {
  OpenAICompatiblePlanningModel, PlanningProviderAuditError, type PlanningProviderAuditEvent,
} from "../src/agent/openai-compatible-model.js";
import { AgentApiError } from "../src/http/agent-error.js";

const completion = (extra: Record<string, unknown> = {}) => ({
  model: "audited-model", system_fingerprint: "revision-a",
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ output: readyOutputFixture }) } }],
  usage: {
    prompt_tokens: 25, completion_tokens: 50, total_tokens: 75,
    prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 15,
    prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 4 },
  },
  ...extra,
});

test("private audit preserves the exact request and response before parsing, including provider token details", async () => {
  const events: PlanningProviderAuditEvent[] = [];
  const source = JSON.stringify(completion());
  let requestBody = "";
  const model = new OpenAICompatiblePlanningModel({
    apiKey: "fake-private-key", modelId: "audited-model", requestProfile: "deepseek-json",
    audit: async (event) => { events.push(event); },
    fetch: async (_url, init) => {
      assert.equal(events.length, 1, "request evidence must complete before the outbound request");
      requestBody = String(init?.body);
      return new Response(source, { status: 200 });
    },
  });
  const result = await model.generate(snapshotFixture, [], new AbortController().signal);
  assert.deepEqual(result.output, readyOutputFixture);
  assert.deepEqual(events, [
    { kind: "request", body: requestBody, redacted: false },
    {
      kind: "response", statusCode: 200, bodyState: "complete", rawBody: source,
      receivedBytes: Buffer.byteLength(source), providerModelId: "audited-model",
      systemFingerprint: "revision-a", usage: completion().usage, redacted: false,
    },
  ]);
  assert.equal(JSON.stringify(events).includes("fake-private-key"), false);
  assert.equal(Object.hasOwn(events[0], "headers"), false);
});

for (const [name, source] of [
  ["invalid outer JSON", "{broken response"],
  ["invalid completion envelope", JSON.stringify({ model: "audited-model", usage: { prompt_tokens: 1 }, choices: [] })],
  ["invalid output envelope", JSON.stringify(completion({ choices: [{ finish_reason: "stop", message: { content: "{broken content" } }] }))],
  ["truncated model completion", JSON.stringify(completion({ choices: [{ finish_reason: "length", message: { content: "unfinished" } }] }))],
] as const) {
  test(`private audit retains ${name} before the adapter rejects it`, async () => {
    const events: PlanningProviderAuditEvent[] = [];
    const model = new OpenAICompatiblePlanningModel({
      apiKey: "fake-private-key", modelId: "audited-model",
      audit: async (event) => { events.push(event); }, fetch: async () => new Response(source),
    });
    await assert.rejects(model.generate(snapshotFixture, [], new AbortController().signal),
      (error: unknown) => error instanceof AgentApiError && error.code === "MODEL_INVALID_OUTPUT");
    assert.equal(events.length, 2);
    assert.equal(events[1].kind, "response");
    if (events[1].kind !== "response") assert.fail("response evidence missing");
    assert.equal(events[1].rawBody, source);
    assert.equal(events[1].bodyState, "complete");
    assert.equal(events[1].statusCode, 200);
  });
}

test("HTTP error audit records the status and explicit omission without retaining the provider error body", async () => {
  const events: PlanningProviderAuditEvent[] = [];
  const model = new OpenAICompatiblePlanningModel({
    apiKey: "fake-private-key", modelId: "audited-model",
    audit: async (event) => { events.push(event); },
    fetch: async () => new Response("fake-private-key and private provider diagnostics", { status: 429 }),
  });
  await assert.rejects(model.generate(snapshotFixture, [], new AbortController().signal),
    (error: unknown) => error instanceof AgentApiError && error.code === "MODEL_RATE_LIMITED");
  assert.deepEqual(events[1], {
    kind: "response", statusCode: 429, bodyState: "omitted_http_error", rawBody: null,
    receivedBytes: null, providerModelId: null, systemFingerprint: null, usage: null, redacted: false,
  });
  assert.equal(JSON.stringify(events).includes("private provider diagnostics"), false);
});

test("a private audit redacts key and bearer values without changing the request or generation", async () => {
  const events: PlanningProviderAuditEvent[] = [];
  const snapshot = structuredClone(snapshotFixture);
  snapshot.candidates[0].task.notes = "fake-private-key Bearer another-private-value";
  const output = { kind: "no_action", reason: "fake-private-key Bearer another-private-value", assumptions: [] };
  const model = new OpenAICompatiblePlanningModel({
    apiKey: "fake-private-key", modelId: "audited-model",
    audit: async (event) => { events.push(event); },
    fetch: async (_url, init) => {
      assert.ok(String(init?.body).includes("fake-private-key"), "audit redaction must not alter the model input");
      return Response.json(completion({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ output }) } }] }));
    },
  });
  const result = await model.generate(snapshot, [], new AbortController().signal);
  assert.deepEqual(result.output, output);
  assert.equal(events.every((event) => event.redacted), true);
  assert.equal(JSON.stringify(events).includes("fake-private-key"), false);
  assert.equal(JSON.stringify(events).includes("another-private-value"), false);
  assert.ok(JSON.stringify(events).includes("[REDACTED]"));
});

test("private audit redacts an escaped key inside nested completion JSON", async () => {
  const apiKey = 'fake-"quoted"-\\key';
  const events: PlanningProviderAuditEvent[] = [];
  const output = { kind: "no_action", reason: apiKey, assumptions: [] };
  const model = new OpenAICompatiblePlanningModel({
    apiKey, modelId: "audited-model", audit: async (event) => { events.push(event); },
    fetch: async () => Response.json(completion({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ output }) } }] })),
  });
  const result = await model.generate(snapshotFixture, [], new AbortController().signal);
  assert.deepEqual(result.output, output);
  const response = events[1];
  if (response.kind !== "response") assert.fail("response evidence missing");
  assert.equal(response.redacted, true);
  const retainedOutput = JSON.parse(JSON.parse(response.rawBody!).choices[0].message.content).output;
  assert.equal(retainedOutput.reason, "[REDACTED]");
});

test("private audit redacts Unicode-escaped credentials in provider JSON", async () => {
  const apiKey = "fake-private-key";
  const events: PlanningProviderAuditEvent[] = [];
  const source = JSON.stringify(completion({ echo: apiKey })).replace(apiKey, "\\u0066ake-private-key");
  const model = new OpenAICompatiblePlanningModel({
    apiKey, modelId: "audited-model", audit: async (event) => { events.push(event); },
    fetch: async () => new Response(source),
  });
  await model.generate(snapshotFixture, [], new AbortController().signal);
  const response = events[1];
  if (response.kind !== "response") assert.fail("response evidence missing");
  assert.equal(response.redacted, true);
  assert.equal(JSON.parse(response.rawBody!).echo, "[REDACTED]");
});

for (const failureStage of ["request", "response"] as const) {
  test(`a ${failureStage} audit persistence failure escapes as a hard stop without repair or secret leakage`, async () => {
    let calls = 0;
    const model = new OpenAICompatiblePlanningModel({
      apiKey: "fake-private-key", modelId: "audited-model",
      audit: async (event) => { if (event.kind === failureStage) throw new Error("disk failed fake-private-key"); },
      fetch: async () => { calls++; return new Response("invalid JSON that would otherwise be repairable"); },
    });
    await assert.rejects(model.generate(snapshotFixture, [], new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof PlanningProviderAuditError);
      assert.equal(error.code, "PROVIDER_AUDIT_FAILURE");
      assert.equal(error instanceof AgentApiError, false);
      assert.equal(error.message.includes("fake-private-key"), false);
      return true;
    });
    assert.equal(calls, failureStage === "request" ? 0 : 1);
  });
}

test("oversized responses preserve a bounded prefix marked truncated and retain the production size limit", async () => {
  const events: PlanningProviderAuditEvent[] = [];
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(210_000))); },
    cancel() { cancelled = true; },
  });
  const model = new OpenAICompatiblePlanningModel({
    apiKey: "fake-private-key", modelId: "audited-model",
    audit: async (event) => { events.push(event); }, fetch: async () => new Response(stream),
  });
  await assert.rejects(model.generate(snapshotFixture, [], new AbortController().signal),
    (error: unknown) => error instanceof AgentApiError && error.code === "MODEL_INVALID_OUTPUT");
  assert.equal(cancelled, true);
  const response = events[1];
  if (response.kind !== "response") assert.fail("response evidence missing");
  assert.equal(response.bodyState, "truncated");
  assert.equal(response.receivedBytes, 210_000);
  assert.equal(response.rawBody, "x".repeat(200_000));
});

test("interrupted streams retain received output and mark it incomplete", async () => {
  const events: PlanningProviderAuditEvent[] = [];
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode("partial output"));
      else controller.error(new Error("fake-private-key interrupted transport"));
    },
  });
  const model = new OpenAICompatiblePlanningModel({
    apiKey: "fake-private-key", modelId: "audited-model",
    audit: async (event) => { events.push(event); }, fetch: async () => new Response(stream),
  });
  await assert.rejects(model.generate(snapshotFixture, [], new AbortController().signal),
    (error: unknown) => error instanceof AgentApiError && error.code === "MODEL_INVALID_OUTPUT");
  const response = events[1];
  if (response.kind !== "response") assert.fail("response evidence missing");
  assert.equal(response.bodyState, "interrupted");
  assert.equal(response.rawBody, "partial output");
  assert.equal(response.receivedBytes, Buffer.byteLength("partial output"));
});

test("an abort in the same turn as a received chunk does not discard that chunk from audit evidence", async () => {
  const events: PlanningProviderAuditEvent[] = [];
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    pull(streamController) {
      streamController.enqueue(new TextEncoder().encode("received prefix"));
      controller.abort();
    },
  }, { highWaterMark: 0 });
  const model = new OpenAICompatiblePlanningModel({
    apiKey: "fake-private-key", modelId: "audited-model",
    audit: async (event) => { events.push(event); }, fetch: async () => new Response(stream),
  });
  await assert.rejects(model.generate(snapshotFixture, [], controller.signal));
  const response = events[1];
  if (response.kind !== "response") assert.fail("response evidence missing");
  assert.equal(response.bodyState, "interrupted");
  assert.equal(response.rawBody, "received prefix");
  assert.equal(response.receivedBytes, 15);
});
