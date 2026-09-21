import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelUsage, PlanningSnapshot } from "@newday/core/contracts/agent-planning";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelGeneration, PlanningModel } from "../../../apps/api/src/agent/planning-model";
import { OpenAICompatiblePlanningModel } from "../../../apps/api/src/agent/openai-compatible-model";
import { PLANNING_SYSTEM_PROMPT, planningProviderJsonSchema } from "../../../apps/api/src/agent/planning-prompt";
import { snapshotFixture } from "../fixtures/contracts";
import heldout from "../fixtures/heldout-v2.json";
import {
  acquireEvidenceLock,
  beginTrial,
  createLedger,
  evaluationFreezeSchema,
  EvaluationGuardError,
  loadFrozenScenario,
  prepareEvidenceDirectory,
  readApprovedFreeze,
  reserveOutboundCall,
  runModelPhase,
  secureJson,
  sha256,
  trialId,
  validateClarificationMapping,
  verifyCandidateState,
  verifyProviderConfiguration,
  verifyReviewedLedger,
  writeReportExclusive,
  type EvaluationFreeze,
  type TrialCallRecord,
} from "../../../tooling/agent-evaluation-trial-lib";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function freeze(overrides: Record<string, unknown> = {}): EvaluationFreeze {
  const base = {
    format: "newday-agent-evaluation-freeze",
    version: 2,
    approval: {
      approved: true,
      approvedAt: "2026-09-21T00:00:00.000Z",
      approvedBy: "reviewer",
      reference: "explicit-test-authorization",
    },
    candidate: { gitSha: "a".repeat(40), requireCleanWorktree: true },
    fixtures: { manifestSha256: "b".repeat(64), corpusSha256: "c".repeat(64) },
    contract: {
      promptVersion: "daily-focus-v1",
      schemaVersion: "newday-agent-v1",
      systemPromptSha256: sha256(PLANNING_SYSTEM_PROMPT),
      providerSchemaSha256: sha256(JSON.stringify(planningProviderJsonSchema)),
    },
    provider: {
      kind: "openai-compatible",
      origin: "https://provider.example",
      allowHttpOrigin: null,
      baseUrlSha256: sha256("https://provider.example/v1"),
      modelId: "frozen-model",
      requestProfile: "openai-structured",
      reasoningEffort: "none",
      maxOutputTokens: 1200,
      timeoutMs: 30_000,
    },
    scope: {
      split: "heldout",
      scenarioIds: heldout.scenarios.map(({ id }) => id),
      trialsPerScenario: 3,
      maxOutboundCallsTotal: 360,
      costControl: { mode: "unknown", policy: "require_ledger_review_before_each_command" },
    },
    stopConditions: [
      "outbound_call_cap_reached",
      "cost_control_reached",
      "provider_or_model_drift",
      "unexpected_real_user_data",
      "business_write_detected",
      "evidence_write_failure",
      "unexplained_duplicate_request",
    ],
    humanReview: { primaryReviewer: "reviewer" },
    evidenceDirectory: "/tmp/newday-evaluation-evidence",
  };
  return evaluationFreezeSchema.parse(deepMerge(base, overrides));
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = current && value && typeof current === "object" && typeof value === "object" &&
      !Array.isArray(current) && !Array.isArray(value)
      ? deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return result;
}

function scriptedModel(steps: Array<ModelGeneration | Error>, calls = vi.fn()): PlanningModel {
  return {
    modelId: "frozen-model",
    async generate(...args) {
      calls(...args);
      const step = steps.shift();
      if (!step) throw new Error("unexpected fake model call");
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

const usage: ModelUsage = { kind: "known", inputTokens: 10, outputTokens: 5 };
const noAction = { kind: "no_action" as const, reason: "当前保持不变。", assumptions: [] };

async function run(model: PlanningModel, options: { callsAlreadyUsed?: number; secrets?: string[] } = {}) {
  const reserved: TrialCallRecord[] = [];
  const completed: TrialCallRecord[] = [];
  return {
    result: await runModelPhase({
      model,
      expectedModelId: "frozen-model",
      snapshot: snapshotFixture as PlanningSnapshot,
      answers: [],
      clarificationRound: 0,
      callsAlreadyUsed: options.callsAlreadyUsed ?? 0,
      timeoutMs: 1_000,
      secrets: options.secrets,
      beforeCall: async (call) => { reserved.push(structuredClone(call)); },
      afterCall: async (call) => { completed.push(structuredClone(call)); },
    }),
    reserved,
    completed,
  };
}

describe("guarded real-provider evaluation trial", () => {
  it("requires an approved, complete freeze and exact candidate state", () => {
    expect(evaluationFreezeSchema.safeParse(deepMerge(freeze() as unknown as Record<string, unknown>, {
      version: 1,
    })).success).toBe(false);
    expect(evaluationFreezeSchema.safeParse(deepMerge(freeze() as unknown as Record<string, unknown>, {
      approval: { approved: false },
    })).success).toBe(false);
    expect(evaluationFreezeSchema.safeParse(deepMerge(freeze() as unknown as Record<string, unknown>, {
      stopConditions: ["outbound_call_cap_reached"],
    })).success).toBe(false);
    expect(() => evaluationFreezeSchema.safeParse(deepMerge(freeze() as unknown as Record<string, unknown>, {
      provider: { origin: "not-a-url" },
    }))).not.toThrow();
    expect(evaluationFreezeSchema.safeParse(deepMerge(freeze() as unknown as Record<string, unknown>, {
      provider: { origin: "not-a-url" },
    })).success).toBe(false);
    expect(() => verifyCandidateState(freeze(), "b".repeat(40), "")).toThrowError(expect.objectContaining({ code: "CANDIDATE_SHA_MISMATCH" }));
    expect(() => verifyCandidateState(freeze(), "a".repeat(40), "?? stray.txt")).toThrowError(expect.objectContaining({ code: "DIRTY_WORKTREE" }));
    expect(() => verifyCandidateState(freeze(), "a".repeat(40), "")).not.toThrow();
  });

  it("binds provider origin, base URL, model and runtime knobs without retaining the API key", () => {
    const configuration = {
      provider: "openai-compatible",
      baseUrl: "https://provider.example/v1",
      modelId: "frozen-model",
      apiKey: "top-secret",
      requestProfile: "openai-structured",
      reasoningEffort: "none",
      maxOutputTokens: 1200,
      timeoutMs: 30_000,
    };
    expect(() => verifyProviderConfiguration(freeze(), configuration)).not.toThrow();
    expect(() => verifyProviderConfiguration(freeze(), { ...configuration, modelId: "drifted-model" }))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_CONFIG_DRIFT" }));
    expect(() => verifyProviderConfiguration(freeze(), { ...configuration, baseUrl: "https://provider.example/other" }))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_CONFIG_DRIFT" }));
    expect(() => verifyProviderConfiguration(freeze(), { ...configuration, requestProfile: "deepseek-json" }))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_CONFIG_DRIFT" }));
  });

  it("freezes an explicit non-loopback HTTP transport exception", () => {
    const origin = "http://192.168.50.8:8788";
    const approved = freeze({
      provider: {
        origin,
        allowHttpOrigin: origin,
        baseUrlSha256: sha256(`${origin}/v1`),
      },
    });
    const configuration = {
      provider: "openai-compatible",
      baseUrl: `${origin}/v1`,
      allowHttpOrigin: origin,
      modelId: "frozen-model",
      apiKey: "top-secret",
      requestProfile: "openai-structured",
      reasoningEffort: "none",
      maxOutputTokens: 1200,
      timeoutMs: 30_000,
    };
    expect(() => verifyProviderConfiguration(approved, configuration)).not.toThrow();
    expect(() => verifyProviderConfiguration(approved, { ...configuration, allowHttpOrigin: undefined }))
      .toThrowError(expect.objectContaining({ code: "PROVIDER_CONFIG_DRIFT" }));
    expect(evaluationFreezeSchema.safeParse(deepMerge(approved as unknown as Record<string, unknown>, {
      provider: { allowHttpOrigin: null },
    })).success).toBe(false);
  });

  it("uses one bounded repair and passes no business store or apply command to the model", async () => {
    const calls = vi.fn();
    const { result, reserved, completed } = await run(scriptedModel([
      { output: { kind: "ready", selections: [], assumptions: [] }, modelId: "frozen-model", usage },
      { output: noAction, modelId: "frozen-model", usage },
    ], calls));
    expect(result.status).toBe("validated");
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1].repairIssues?.length).toBeGreaterThan(0);
    expect(reserved).toHaveLength(2);
    expect(completed.map(({ outcome }) => outcome)).toEqual(["validation_error", "validated"]);
    expect(calls).toHaveBeenCalledTimes(2);
    for (const invocation of calls.mock.calls) {
      expect(invocation).toHaveLength(4);
      expect(invocation[0]).toEqual(snapshotFixture);
      expect(invocation[0]).not.toHaveProperty("transaction");
      expect(invocation[0]).not.toHaveProperty("applyProposal");
    }
  });

  it("never exceeds the three-call trial limit even when a repair would otherwise run", async () => {
    const { result } = await run(scriptedModel([
      { output: { kind: "ready", selections: [], assumptions: [] }, modelId: "frozen-model", usage },
    ]), { callsAlreadyUsed: 2 });
    expect(result.status).toBe("failed");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].outcome).toBe("validation_error");
  });

  it("stops on provider-reported model drift", async () => {
    const { result } = await run(scriptedModel([
      { output: noAction, modelId: "provider-alias-that-drifted", usage },
    ]));
    expect(result.status).toBe("model_drift");
    expect(result.calls[0]).toMatchObject({ outcome: "model_drift", providerModelId: "provider-alias-that-drifted" });
  });

  it("records a fake provider response without persisting its Authorization secret", async () => {
    const apiKey = "fake-provider-secret";
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
      return new Response(JSON.stringify({
        model: "frozen-model",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ output: noAction }), refusal: null } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const model = new OpenAICompatiblePlanningModel({
      apiKey,
      modelId: "frozen-model",
      baseUrl: "https://provider.example/v1",
      requestProfile: "openai-structured",
      reasoningEffort: "none",
      fetch: fakeFetch,
    });
    const { result } = await run(model, { secrets: [apiKey] });
    expect(result.status).toBe("validated");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const evidence = secureJson(result, [apiKey]);
    expect(evidence).not.toContain(apiKey);
    expect(evidence).not.toMatch(/authorization/i);
  });

  it("redacts secrets and bearer values from model failures", async () => {
    const apiKey = "never-persist-this";
    const { result } = await run(scriptedModel([new Error(`transport failed with Bearer ${apiKey} and ${apiKey}`)]), { secrets: [apiKey] });
    const evidence = secureJson(result, [apiKey]);
    expect(evidence).not.toContain(apiKey);
    expect(evidence).toContain("[REDACTED]");
  });

  it("requires an exact human mapping for the single H-P05 semantic answer", () => {
    const questions = [{ id: "question-42", question: "今天先整理文档还是清理资料？" }];
    const source = {
      format: "newday-agent-evaluation-clarification-mapping",
      version: 1,
      trialId: "heldout:H-P05:1",
      semanticKey: "priority",
      questionId: "question-42",
      questionText: questions[0].question,
      answer: "不知道",
      reviewer: "reviewer",
      rationale: "问题明确询问两个整理任务的优先顺序。",
      decidedAt: "2026-09-21T01:00:00.000Z",
    };
    expect(validateClarificationMapping({
      source,
      expectedTrialId: "heldout:H-P05:1",
      questions,
      clarificationAnswers: { priority: "不知道" },
      reviewer: "reviewer",
    }).answers).toEqual([{ questionId: "question-42", question: questions[0].question, answer: "不知道" }]);
    expect(() => validateClarificationMapping({
      source: { ...source, questionId: "guessed-by-position" },
      expectedTrialId: "heldout:H-P05:1",
      questions,
      clarificationAnswers: { priority: "不知道" },
      reviewer: "reviewer",
    })).toThrowError(expect.objectContaining({ code: "MAPPING_CONTENT_MISMATCH" }));
    expect(() => validateClarificationMapping({
      source,
      expectedTrialId: "heldout:H-P05:1",
      questions: [...questions, { id: "question-43", question: "还有多少时间？" }],
      clarificationAnswers: { priority: "不知道" },
      reviewer: "reviewer",
    })).toThrowError(expect.objectContaining({ code: "CLARIFICATION_NOT_UNIQUE" }));
  });

  it("reserves calls before execution, refuses duplicates and stops at the global cap", () => {
    const limited = freeze({ scope: { maxOutboundCallsTotal: 2 } });
    const ledger = createLedger(limited, "d".repeat(64));
    const id = trialId("heldout", "H-N01", 1);
    beginTrial(ledger, id, "/tmp/report.json");
    expect(() => beginTrial(ledger, id, "/tmp/other.json")).toThrowError(expect.objectContaining({ code: "DUPLICATE_TRIAL" }));
    expect(reserveOutboundCall(ledger, limited, id)).toMatchObject({ allowed: true, reservation: 1 });
    expect(reserveOutboundCall(ledger, limited, id)).toMatchObject({ allowed: true, reservation: 2 });
    expect(reserveOutboundCall(ledger, limited, id)).toEqual({ allowed: false, reason: "outbound_call_cap_reached" });
    expect(ledger).toMatchObject({ batchStatus: "stopped", reservedOutboundCalls: 2 });
  });

  it("stops before a call whose conservative price reservation would exceed the frozen spend cap", () => {
    const pricedSource = freeze();
    pricedSource.scope.maxOutboundCallsTotal = 3;
    pricedSource.scope.costControl = { mode: "known_upper_bound", currency: "USD", maxTotal: 0.3, maxPerOutboundCall: 0.2 };
    const priced = evaluationFreezeSchema.parse(pricedSource);
    const ledger = createLedger(priced, "d".repeat(64));
    const id = trialId("heldout", "H-N01", 1);
    beginTrial(ledger, id, "/tmp/report.json");
    expect(reserveOutboundCall(ledger, priced, id)).toMatchObject({ allowed: true });
    expect(reserveOutboundCall(ledger, priced, id)).toEqual({ allowed: false, reason: "cost_control_reached" });
    expect(ledger).toMatchObject({ batchStatus: "stopped", reservedOutboundCalls: 1, reservedCostUpperBound: 0.2 });
  });

  it("makes evidence private, non-overwriting and review-bound by exact ledger hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "newday-trial-test-"));
    temporaryDirectories.push(root);
    const evidence = await prepareEvidenceDirectory(join(root, "evidence"), resolve("."));
    expect((await stat(evidence)).mode & 0o777).toBe(0o700);
    const release = await acquireEvidenceLock(evidence);
    await expect(acquireEvidenceLock(evidence)).rejects.toMatchObject({ code: "EVALUATION_LOCKED" });
    await release();
    const releaseAgain = await acquireEvidenceLock(evidence);
    await releaseAgain();
    const reportPath = join(evidence, "trials", "trial.json");
    await writeReportExclusive(reportPath, { secret: "never-persist-this" }, ["never-persist-this"]);
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(reportPath, "utf8")).not.toContain("never-persist-this");
    await expect(writeReportExclusive(reportPath, { replaced: true })).rejects.toMatchObject({ code: "EEXIST" });
    const ledgerSource = Buffer.from("review this exact state");
    expect(() => verifyReviewedLedger(ledgerSource, sha256(ledgerSource))).not.toThrow();
    expect(() => verifyReviewedLedger(ledgerSource, "e".repeat(64))).toThrowError(expect.objectContaining({ code: "LEDGER_REVIEW_MISMATCH" }));
    expect(() => verifyReviewedLedger(null, "new")).not.toThrow();
  });

  it("rejects evidence and trials directory symlinks before changing or writing through them", async () => {
    const root = await mkdtemp(join(tmpdir(), "newday-trial-symlink-test-"));
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    await mkdir(repository, { mode: 0o755 });
    await chmod(repository, 0o755);

    const evidenceLink = join(root, "evidence-link");
    await symlink(repository, evidenceLink, "dir");
    await expect(prepareEvidenceDirectory(evidenceLink, repository)).rejects.toMatchObject({
      code: "INSECURE_EVIDENCE_DIRECTORY",
    });
    expect((await stat(repository)).mode & 0o777).toBe(0o755);

    const parentLink = join(root, "parent-link");
    await symlink(repository, parentLink, "dir");
    await expect(prepareEvidenceDirectory(join(parentLink, "new-evidence"), repository)).rejects.toMatchObject({
      code: "EVIDENCE_INSIDE_REPOSITORY",
    });
    await expect(stat(join(repository, "new-evidence"))).rejects.toMatchObject({ code: "ENOENT" });

    const evidence = join(root, "evidence");
    await mkdir(evidence, { mode: 0o700 });
    await symlink(repository, join(evidence, "trials"), "dir");
    await expect(prepareEvidenceDirectory(evidence, repository)).rejects.toMatchObject({
      code: "INSECURE_TRIALS_DIRECTORY",
    });
    expect((await stat(repository)).mode & 0o777).toBe(0o755);
    await expect(readFile(join(repository, "trial.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds freeze acknowledgement and the complete heldout corpus hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "newday-freeze-test-"));
    temporaryDirectories.push(root);
    const fixtureDirectory = resolve("tests/agent/fixtures");
    const manifestSource = await readFile(join(fixtureDirectory, "manifest-v2.json"));
    const corpusSource = await readFile(join(fixtureDirectory, "heldout-v2.json"));
    const approved = freeze({
      fixtures: { manifestSha256: sha256(manifestSource), corpusSha256: sha256(corpusSource) },
      evidenceDirectory: join(root, "evidence"),
    });
    const freezePath = join(root, "freeze.json");
    const source = JSON.stringify(approved, null, 2) + "\n";
    await writeFile(freezePath, source, { mode: 0o600 });
    await expect(readApprovedFreeze(freezePath, "f".repeat(64))).rejects.toMatchObject({ code: "FREEZE_ACKNOWLEDGEMENT_MISMATCH" });
    await expect(readApprovedFreeze(freezePath, sha256(source))).resolves.toMatchObject({ freeze: approved });
    const scenario = await loadFrozenScenario({ fixtureDirectory, freeze: approved, scenarioId: "H-P05" });
    expect(scenario).toMatchObject({ id: "H-P05", clarificationAnswers: { priority: "不知道" } });
    await expect(loadFrozenScenario({
      fixtureDirectory,
      freeze: freeze({ fixtures: { manifestSha256: sha256(manifestSource), corpusSha256: "0".repeat(64) } }),
      scenarioId: "H-P05",
    })).rejects.toMatchObject({ code: "CORPUS_DRIFT" });
  });

  it("uses stable trial identities and refuses invalid repetition numbers", () => {
    expect(trialId("heldout", "H-N01", 3)).toBe("heldout:H-N01:3");
    expect(() => trialId("heldout", "H-N01", 4)).toThrowError(EvaluationGuardError);
  });
});
