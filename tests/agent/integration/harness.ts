import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import {
  agentPreferencesSchema, agentRunResponseSchema, executionReceiptSchema, todayContextResponseSchema,
  type PlanningModelOutput, type PlanningSnapshot,
} from "@newday/core/contracts/agent-planning";
import { createApp } from "../../../apps/api/src/app.js";
import type { PlanningModel } from "../../../apps/api/src/agent/planning-model.js";

export const testDate = "2026-09-08";
export const testNow = "2026-09-08T08:00:00.000Z";
export function ready(snapshot: PlanningSnapshot, ids?: string[]): PlanningModelOutput {
  const candidates = snapshot.candidates.filter((candidate) => candidate.executable && !candidate.blocked);
  const selected = ids ? ids.map((id) => candidates.find((candidate) => candidate.task.id === id)!) : candidates.slice(0, 2);
  assert(selected.every(Boolean), "The scripted test must only name candidates supplied by the real snapshot");
  return {
    kind: "ready", selections: selected.map((candidate) => ({ taskId: candidate.task.id, reason: `推进已有任务：${candidate.task.title}`, factRefs: candidate.factRefs.slice(0, 1) })), assumptions: [],
  };
}
export function fakeModel(generate: (snapshot: PlanningSnapshot) => unknown | Promise<unknown> = ready): PlanningModel & { calls: number } {
  return {
    modelId: "acceptance-scripted-fake", calls: 0,
    async generate(snapshot) {
      this.calls += 1;
      return { output: await generate(snapshot), modelId: this.modelId, usage: { kind: "unknown" } };
    },
  };
}
export async function harness(context: TestContext, options: { model?: PlanningModel | null; now?: string; zone?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "newday-agent-acceptance-"));
  const databasePath = join(directory, "planner.sqlite");
  let currentTime = Date.parse(options.now ?? testNow);
  let app = createApp({ databasePath, clock: () => currentTime, planningModel: options.model === undefined ? fakeModel() : options.model });
  let dropNextApply = false;
  app.addHook("onSend", async (request) => {
    if (dropNextApply && request.url.endsWith("/apply")) {
      dropNextApply = false;
      request.raw.socket.destroy();
    }
  });
  let origin = await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function response(method: string, path: string, body?: unknown) {
    return fetch(`${origin}${path}`, {
      method, headers: { "content-type": "application/json", "x-newday-client": "agent-acceptance" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8_000),
    });
  }
  async function json<T = unknown>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
    const result = await response(method, path, body);
    const text = await result.text();
    assert.equal(result.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text) as T;
  }
  async function preferences(zone = options.zone ?? "Asia/Shanghai") {
    const before = agentPreferencesSchema.parse(await json("GET", "/api/agent/preferences"));
    return agentPreferencesSchema.parse(await json("PUT", "/api/agent/preferences", {
      expectedRevision: before.revision, timeZone: zone, learningEnabled: true, explicitPreferences: [],
    }));
  }
  async function addTask(id: string, title = id, date = testDate) {
    return json("POST", "/api/planner/commands", { commands: [{ type: "createTask", input: { id, title, startDate: date, endDate: date, now: new Date(currentTime).toISOString() } }] });
  }
  async function command(value: unknown) {
    return json("POST", "/api/planner/commands", { commands: [value] });
  }
  async function version() {
    return todayContextResponseSchema.parse(await json("GET", "/api/agent/context/today")).version;
  }
  async function startRun(requestId: string = crypto.randomUUID()) {
    return agentRunResponseSchema.parse(await json("POST", "/api/agent/runs", { requestId }, 202));
  }
  async function waitForRun(runId: string, statuses: string[] = ["ready", "no_action", "failed", "needs_clarification", "cancelled", "interrupted"]) {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const state = agentRunResponseSchema.parse(await json("GET", `/api/agent/runs/${runId}`));
      if (statuses.includes(state.run.status)) return state;
      await delay(10);
    }
    assert.fail(`Run ${runId} did not reach ${statuses.join(", ")} within the bounded test wait`);
  }
  async function proposal() {
    const started = await startRun();
    const state = await waitForRun(started.run.runId);
    assert.equal(state.run.status, "ready");
    assert(state.proposal);
    return state;
  }
  function applyBody(state: Awaited<ReturnType<typeof proposal>>, operationId: string = crypto.randomUUID(), taskIds?: string[]) {
    assert(state.proposal);
    assert.equal(state.proposal.output.kind, "ready");
    if (state.proposal.output.kind !== "ready") assert.fail("No executable proposal");
    return { proposalId: state.proposal.proposalId, operationId, expectedVersion: state.snapshot.version, taskIds: taskIds ?? state.proposal.output.selections.map((selection) => selection.taskId) };
  }
  async function apply(state: Awaited<ReturnType<typeof proposal>>, operationId: string = crypto.randomUUID(), taskIds?: string[]) {
    const body = applyBody(state, operationId, taskIds);
    return executionReceiptSchema.parse(await json("POST", `/api/agent/proposals/${body.proposalId}/apply`, body));
  }
  function databaseRows(table: "tasks" | "focus_records" | "recurrence_series") {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { return database.prepare(`SELECT * FROM ${table} ORDER BY id`).all(); }
    finally { database.close(); }
  }
  async function businessState() {
    return { version: await version(), tasks: databaseRows("tasks"), focus: databaseRows("focus_records"), series: databaseRows("recurrence_series") };
  }
  function executionState() {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return {
        events: database.prepare("SELECT * FROM planner_events ORDER BY id").all(),
        operations: database.prepare("SELECT * FROM execution_ledger ORDER BY operation_id").all(),
      };
    } finally { database.close(); }
  }
  await preferences();
  return {
    json, response, preferences, addTask, command, version, startRun, waitForRun, proposal, applyBody, apply, businessState, executionState, databasePath,
    dropNextApplyResponse: () => { dropNextApply = true; },
    now: () => new Date(currentTime).toISOString(),
    setTime: (instant: string) => { currentTime = Date.parse(instant); },
    async restart(model: PlanningModel | null = options.model ?? fakeModel()) {
      await app.close();
      app = createApp({ databasePath, clock: () => currentTime, planningModel: model });
      origin = await app.listen({ host: "127.0.0.1", port: 0 });
    },
  };
}
