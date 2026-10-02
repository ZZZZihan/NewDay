import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginTrial,
  createLedger,
  evaluationFreezeSchema,
  evaluationLedgerSchema,
  readLedger,
  requiredStopConditions,
  reserveOutboundCall,
  settleOutboundCall,
  writeLedger,
  type EvaluationFreeze,
} from "../../../tooling/agent-evaluation-trial-lib";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function freeze(costOverrides: Record<string, unknown> = {}): EvaluationFreeze {
  return evaluationFreezeSchema.parse({
    format: "newday-agent-evaluation-freeze",
    version: 3,
    approval: { approved: true, approvedAt: "2026-09-22T00:00:00.000Z", approvedBy: "reviewer", reference: "offline-test-only" },
    candidate: { gitSha: "a".repeat(40), requireCleanWorktree: true },
    fixtures: { manifestSha256: "b".repeat(64), corpusSha256: "c".repeat(64) },
    contract: { promptVersion: "test", schemaVersion: "test", systemPromptSha256: "d".repeat(64), providerSchemaSha256: "e".repeat(64) },
    provider: {
      kind: "openai-compatible", origin: "https://provider.example", allowHttpOrigin: null,
      baseUrlSha256: "f".repeat(64), modelId: "frozen-test-model", requestProfile: "deepseek-json",
      reasoningEffort: "none", maxOutputTokens: 1200, timeoutMs: 30_000,
    },
    scope: {
      split: "development", scenarioIds: ["offline-test"], trialsPerScenario: 3, maxOutboundCallsTotal: 360,
      costControl: {
        mode: "metered_upper_bound", currency: "CNY", maxTotal: 5, maxPerOutboundCall: 2.11,
        inputPerMillion: 2, outputPerMillion: 8, inputTokenUpperBound: 1_048_576,
        pricingSource: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
        checkedAt: "2026-09-22T00:00:00.000Z", ...costOverrides,
      },
    },
    stopConditions: [...requiredStopConditions],
    humanReview: { primaryReviewer: "reviewer" }, evidenceDirectory: "/tmp/newday-evaluation-offline-budget",
  });
}

function running(approved = freeze()) {
  const ledger = createLedger(approved, "a".repeat(64));
  beginTrial(ledger, "test:1", "/tmp/test-report.json");
  return { approved, ledger };
}

const boundUsage = { kind: "known", inputTokens: 1_048_576, outputTokens: 1200 };
const smallUsage = { kind: "known", inputTokens: 1000, outputTokens: 100 };

describe("frozen metered evaluation budget", () => {
  it("requires a version 3 freeze and a reservation covering both token bounds", () => {
    const approved = freeze();
    expect(evaluationFreezeSchema.safeParse({ ...approved, version: 2 }).success).toBe(false);
    expect(() => freeze({ maxPerOutboundCall: 2.106751 })).toThrow();
    expect(() => freeze({ maxPerOutboundCall: 2.106752 })).not.toThrow();
    expect(() => freeze({ maxTotal: 5.0000001 })).toThrow();
    expect(() => freeze({ inputPerMillion: -1 })).toThrow();
    expect(() => freeze({ inputPerMillion: 3 })).toThrow();
    expect(() => freeze({ inputPerMillion: 3, maxPerOutboundCall: 3.16, maxTotal: 10 })).not.toThrow();
  });

  it("keeps v2 unknown and known_upper_bound freezes and their v1 ledgers compatible", () => {
    for (const costControl of [
      { mode: "unknown", policy: "require_ledger_review_before_each_command" },
      { mode: "known_upper_bound", currency: "USD", maxTotal: 1, maxPerOutboundCall: 0.25 },
    ]) {
      const current = freeze();
      const approved = evaluationFreezeSchema.parse({ ...current, version: 2, scope: { ...current.scope, costControl } });
      const ledger = createLedger(approved, "a".repeat(64));
      expect(ledger.version).toBe(1);
      expect(evaluationLedgerSchema.parse(JSON.parse(JSON.stringify(ledger)))).toEqual(ledger);
      beginTrial(ledger, "legacy", "/tmp/legacy.json");
      expect(reserveOutboundCall(ledger, approved, "legacy").allowed).toBe(true);
    }
  });

  it("denies before the next outbound call can exceed the frozen monetary cap", () => {
    const { approved, ledger } = running();
    for (let sequence = 1; sequence <= 2; sequence += 1) {
      expect(reserveOutboundCall(ledger, approved, "test:1")).toMatchObject({ allowed: true, sequence, costReservationMicros: 2_110_000 });
      expect(settleOutboundCall(ledger, approved, "test:1", sequence, boundUsage)).toEqual({
        settled: true, costUpperBound: 2.106752, costUpperBoundMicros: 2_106_752,
      });
    }
    expect(reserveOutboundCall(ledger, approved, "test:1")).toEqual({ allowed: false, reason: "cost_control_reached" });
    expect(ledger).toMatchObject({ reservedOutboundCalls: 2, reservedCostUpperBound: 4.213504, reservedCostUpperBoundMicros: 4_213_504, batchStatus: "stopped" });
  });

  it("settles trusted usage at the frozen cache-miss rates and only releases the excess", () => {
    const { approved, ledger } = running();
    reserveOutboundCall(ledger, approved, "test:1");
    expect(ledger.reservedCostUpperBound).toBe(2.11);
    expect(settleOutboundCall(ledger, approved, "test:1", 1, smallUsage)).toEqual({ settled: true, costUpperBound: 0.0028, costUpperBoundMicros: 2800 });
    expect(ledger).toMatchObject({ reservedCostUpperBound: 0.0028, reservedCostUpperBoundMicros: 2800 });
    expect(reserveOutboundCall(ledger, approved, "test:1").allowed).toBe(true);
    expect(ledger.reservedCostUpperBound).toBe(2.1128);
    expect(evaluationLedgerSchema.safeParse(ledger).success).toBe(true);
  });

  it.each([
    null, undefined, { kind: "unknown" }, {},
    { kind: "known", inputTokens: -1, outputTokens: 0 },
    { kind: "known", inputTokens: 1, outputTokens: -1 },
    { kind: "known", inputTokens: 1.5, outputTokens: 0 },
    { kind: "known", inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
    { kind: "known", inputTokens: Number.NaN, outputTokens: 0 },
    { kind: "known", inputTokens: 1, outputTokens: Number.POSITIVE_INFINITY },
  ])("retains the entire reservation and halts for unknown or invalid usage: %j", (usage) => {
    const { approved, ledger } = running();
    reserveOutboundCall(ledger, approved, "test:1");
    expect(settleOutboundCall(ledger, approved, "test:1", 1, usage)).toEqual({ settled: false, reason: "usage_unknown" });
    expect(ledger).toMatchObject({ reservedCostUpperBound: 2.11, reservedCostUpperBoundMicros: 2_110_000, batchStatus: "stopped" });
    expect(reserveOutboundCall(ledger, approved, "test:1")).toEqual({ allowed: false, reason: "usage_unknown" });
    expect(ledger.reservedOutboundCalls).toBe(1);
    expect(evaluationLedgerSchema.safeParse(ledger).success).toBe(true);
  });

  it.each([
    { kind: "known", inputTokens: 1_048_577, outputTokens: 0 },
    { kind: "known", inputTokens: 1, outputTokens: 1201 },
  ])("retains the reservation and records a bound breach without claiming spend is capped", (usage) => {
    const { approved, ledger } = running();
    reserveOutboundCall(ledger, approved, "test:1");
    expect(settleOutboundCall(ledger, approved, "test:1", 1, usage)).toEqual({ settled: false, reason: "usage_out_of_bounds" });
    expect(ledger.reservedCostUpperBound).toBe(2.11);
    expect(ledger.trials["test:1"]).toMatchObject({ costReservations: { "1": { status: "usage_out_of_bounds", usage } } });
    expect(reserveOutboundCall(ledger, approved, "test:1")).toEqual({ allowed: false, reason: "usage_out_of_bounds" });
  });

  it.each([smallUsage, null])("rejects duplicate settlements without releasing or changing any cost", (usage) => {
    const { approved, ledger } = running();
    reserveOutboundCall(ledger, approved, "test:1");
    settleOutboundCall(ledger, approved, "test:1", 1, usage);
    const previous = structuredClone(ledger);
    expect(() => settleOutboundCall(ledger, approved, "test:1", 1, smallUsage))
      .toThrowError(expect.objectContaining({ code: "DUPLICATE_COST_SETTLEMENT" }));
    expect(ledger).toEqual(previous);
    expect(() => settleOutboundCall(ledger, approved, "test:1", 2, smallUsage))
      .toThrowError(expect.objectContaining({ code: "COST_RESERVATION_NOT_FOUND" }));
  });

  it("persists a pre-call reservation across a crash and blocks unreviewed further calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "newday-budget-test-"));
    temporaryDirectories.push(directory);
    const { approved, ledger } = running();
    reserveOutboundCall(ledger, approved, "test:1");
    await writeLedger(join(directory, "ledger.json"), ledger);
    const restored = (await readLedger(directory)).ledger!;
    expect(restored.reservedCostUpperBound).toBe(2.11);
    expect(restored.trials["test:1"]).toMatchObject({ costReservations: { "1": { status: "reserved", costUpperBoundMicros: 2_110_000 } } });
    beginTrial(restored, "test:2", "/tmp/test-report-2.json");
    expect(reserveOutboundCall(restored, approved, "test:2")).toEqual({ allowed: false, reason: "unsettled_cost_reservation" });
    expect(restored.reservedOutboundCalls).toBe(1);
    expect(restored.reservedCostUpperBound).toBe(2.11);
  });

  it("rounds fractional rate charges upward to one micro and avoids cumulative float drift", () => {
    const approved = freeze({ inputPerMillion: 0.0000001, outputPerMillion: 0.0000001 });
    const ledger = createLedger(approved, "a".repeat(64));
    for (let index = 1; index <= 231; index += 1) {
      const id = `test:${index}`;
      beginTrial(ledger, id, `/tmp/test-${index}.json`);
      expect(reserveOutboundCall(ledger, approved, id).allowed).toBe(true);
      expect(settleOutboundCall(ledger, approved, id, 1, { kind: "known", inputTokens: 1, outputTokens: 1 }))
        .toEqual({ settled: true, costUpperBound: 0.000001, costUpperBoundMicros: 1 });
    }
    expect(ledger).toMatchObject({ reservedCostUpperBoundMicros: 231, reservedCostUpperBound: 0.000231, reservedOutboundCalls: 231 });
    expect(evaluationLedgerSchema.safeParse(ledger).success).toBe(true);
  });

  it("rejects missing or inconsistent per-call cost evidence when loading a metered ledger", () => {
    const { approved, ledger } = running();
    reserveOutboundCall(ledger, approved, "test:1");
    if (ledger.version !== 2) throw new Error("expected metered ledger");
    const missing = structuredClone(ledger);
    missing.trials["test:1"].costReservations = {};
    expect(evaluationLedgerSchema.safeParse(missing).success).toBe(false);
    const discounted = structuredClone(ledger);
    discounted.reservedCostUpperBoundMicros = 0;
    discounted.reservedCostUpperBound = 0;
    expect(evaluationLedgerSchema.safeParse(discounted).success).toBe(false);
  });
});
