import { vi } from "vitest";
import type { AgentApi } from "../api/agent-api";
import type { AgentSession, SessionStore } from "../hooks/agent-session";
import {
  contextFixture, feedbackFixture, fixtureDate, preferencesFixture,
  receiptFixture, runResponseFixture, versionFixture,
} from "../../../../../../tests/agent/fixtures/contracts";
export * from "../../../../../../tests/agent/fixtures/contracts";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
export function sessionStore(initial: AgentSession | null = null) {
  let value = structuredClone(initial);
  const store: SessionStore = { load: () => structuredClone(value), save: (next) => { value = structuredClone(next); } };
  return store;
}
export function makeApi() {
  return {
    status: vi.fn<AgentApi["status"]>().mockResolvedValue({ configured: true, today: fixtureDate, timeZone: "Asia/Shanghai", modelId: "scripted-fake" }),
    preferences: vi.fn<AgentApi["preferences"]>().mockResolvedValue(structuredClone(preferencesFixture)),
    savePreferences: vi.fn<AgentApi["savePreferences"]>().mockResolvedValue(structuredClone(preferencesFixture)),
    context: vi.fn<AgentApi["context"]>().mockResolvedValue({ context: structuredClone(contextFixture), version: versionFixture }),
    saveContext: vi.fn<AgentApi["saveContext"]>().mockResolvedValue({ context: structuredClone(contextFixture), version: versionFixture }),
    createRun: vi.fn<AgentApi["createRun"]>().mockImplementation(async (request) => ({ ...structuredClone(runResponseFixture), run: { ...runResponseFixture.run, requestId: request.requestId } })),
    run: vi.fn<AgentApi["run"]>().mockResolvedValue(structuredClone(runResponseFixture)),
    answer: vi.fn<AgentApi["answer"]>().mockResolvedValue(structuredClone(runResponseFixture)),
    cancel: vi.fn<AgentApi["cancel"]>().mockResolvedValue({ ...structuredClone(runResponseFixture), run: { ...runResponseFixture.run, status: "cancelled" } }),
    apply: vi.fn<AgentApi["apply"]>().mockImplementation(async (request) => ({ ...structuredClone(receiptFixture), operationId: request.operationId, finalFocusTaskIds: request.taskIds })),
    operation: vi.fn<AgentApi["operation"]>().mockImplementation(async (operationId) => ({ status: "not_found", operationId })),
    revert: vi.fn<AgentApi["revert"]>().mockImplementation(async (target, operationId) => ({ ...structuredClone(receiptFixture), operationId, action: "revert", revertsOperationId: target, canRevert: false })),
    history: vi.fn<AgentApi["history"]>().mockImplementation(async (date) => ({ date, entries: [] })),
    feedback: vi.fn<AgentApi["feedback"]>().mockImplementation(async (request) => ({ ...feedbackFixture, ...request })),
  };
}
