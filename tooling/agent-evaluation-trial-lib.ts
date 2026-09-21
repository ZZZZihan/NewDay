import { createHash, randomUUID } from "node:crypto";
import {
  chmod, lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  AGENT_PROMPT_VERSION, AGENT_SCHEMA_VERSION, type ModelUsage,
  type PlanningModelOutput, type PlanningSnapshot,
} from "@newday/core/contracts/agent-planning";
import { z } from "zod";
import { AgentApiError } from "../apps/api/src/http/agent-error.js";
import type {
  PlanningAnswers, PlanningModel,
} from "../apps/api/src/agent/planning-model.js";
import {
  PLANNING_SYSTEM_PROMPT, planningProviderJsonSchema,
} from "../apps/api/src/agent/planning-prompt.js";
import {
  forcedNoAction, InvalidPlanningOutputError, validatePlanningOutput,
} from "../apps/api/src/agent/validate-planning-output.js";
import {
  evaluationScenarioInputSchema, prepareEvaluationScenario,
} from "../tests/agent/evaluation/prepare-snapshot.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nonEmpty = z.string().trim().min(1).max(2_000);
const instant = z.string().refine((value) => Number.isFinite(Date.parse(value)), "expected an ISO timestamp");
const absolutePath = z.string().refine(isAbsolute, "expected an absolute path");
const providerOrigin = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.origin === value;
  } catch { return false; }
}, "expected an HTTP(S) origin without a path");

export const requiredStopConditions = [
  "outbound_call_cap_reached",
  "cost_control_reached",
  "provider_or_model_drift",
  "unexpected_real_user_data",
  "business_write_detected",
  "evidence_write_failure",
  "unexplained_duplicate_request",
] as const;

const costControlSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("known_upper_bound"),
    currency: z.string().trim().min(3).max(3),
    maxTotal: z.number().finite().positive(),
    maxPerOutboundCall: z.number().finite().positive(),
  }).refine((value) => value.maxPerOutboundCall <= value.maxTotal, {
    message: "maxPerOutboundCall cannot exceed maxTotal",
  }),
  z.strictObject({
    mode: z.literal("unknown"),
    policy: z.literal("require_ledger_review_before_each_command"),
  }),
]);

export const evaluationFreezeSchema = z.strictObject({
  format: z.literal("newday-agent-evaluation-freeze"),
  version: z.literal(1),
  approval: z.strictObject({
    approved: z.literal(true),
    approvedAt: instant,
    approvedBy: nonEmpty,
    reference: nonEmpty,
  }),
  candidate: z.strictObject({
    gitSha: z.string().regex(/^[a-f0-9]{40}$/),
    requireCleanWorktree: z.literal(true),
  }),
  fixtures: z.strictObject({
    manifestSha256: sha256Schema,
    corpusSha256: sha256Schema,
  }),
  contract: z.strictObject({
    promptVersion: nonEmpty,
    schemaVersion: nonEmpty,
    systemPromptSha256: sha256Schema,
    providerSchemaSha256: sha256Schema,
  }),
  provider: z.strictObject({
    kind: z.literal("openai-compatible"),
    origin: providerOrigin,
    allowHttpOrigin: providerOrigin.nullable(),
    baseUrlSha256: sha256Schema,
    modelId: nonEmpty,
    reasoningEffort: z.enum(["provider_default", "none", "low", "medium", "high"]),
    maxOutputTokens: z.number().int().min(100).max(4_000),
    timeoutMs: z.number().int().min(1).max(30_000),
  }),
  scope: z.strictObject({
    split: z.enum(["development", "heldout"]),
    scenarioIds: z.array(nonEmpty).min(1).max(52),
    trialsPerScenario: z.literal(3),
    maxOutboundCallsTotal: z.number().int().min(1).max(360),
    costControl: costControlSchema,
  }),
  stopConditions: z.array(z.enum(requiredStopConditions)).min(requiredStopConditions.length),
  humanReview: z.strictObject({
    primaryReviewer: nonEmpty,
    secondReviewer: nonEmpty.optional(),
  }),
  evidenceDirectory: absolutePath,
}).superRefine((value, context) => {
  if (new Set(value.scope.scenarioIds).size !== value.scope.scenarioIds.length) {
    context.addIssue({ code: "custom", path: ["scope", "scenarioIds"], message: "scenarioIds must be unique" });
  }
  const conditions = new Set(value.stopConditions);
  for (const condition of requiredStopConditions) {
    if (!conditions.has(condition)) {
      context.addIssue({ code: "custom", path: ["stopConditions"], message: `missing required stop condition: ${condition}` });
    }
  }
  if (conditions.size !== value.stopConditions.length) {
    context.addIssue({ code: "custom", path: ["stopConditions"], message: "stop conditions must be unique" });
  }
  const providerUrl = new URL(value.provider.origin);
  const providerIsLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(providerUrl.hostname);
  if (providerUrl.protocol === "http:" && !providerIsLoopback && value.provider.allowHttpOrigin !== value.provider.origin) {
    context.addIssue({
      code: "custom",
      path: ["provider", "allowHttpOrigin"],
      message: "a non-loopback HTTP provider requires the exact frozen HTTP origin exception",
    });
  }
  if ((providerUrl.protocol === "https:" || providerIsLoopback) && value.provider.allowHttpOrigin !== null) {
    context.addIssue({
      code: "custom",
      path: ["provider", "allowHttpOrigin"],
      message: "HTTPS and loopback providers must not freeze an HTTP origin exception",
    });
  }
});

export type EvaluationFreeze = z.infer<typeof evaluationFreezeSchema>;

export const clarificationMappingSchema = z.strictObject({
  format: z.literal("newday-agent-evaluation-clarification-mapping"),
  version: z.literal(1),
  trialId: nonEmpty,
  semanticKey: nonEmpty,
  questionId: nonEmpty,
  questionText: nonEmpty,
  answer: nonEmpty,
  reviewer: nonEmpty,
  rationale: nonEmpty,
  decidedAt: instant,
});
export type ClarificationMapping = z.infer<typeof clarificationMappingSchema>;

export const expectedCriteriaSchema = z.strictObject({
  allowedProposalStatuses: z.array(z.enum(["ready", "needs_clarification", "no_action"])).min(1),
  requiredTaskIds: z.array(z.string()),
  forbiddenTaskIds: z.array(z.string()),
  minimumSelections: z.number().int().min(0).max(3),
  maximumSelections: z.number().int().min(0).max(3),
  maximumQuestions: z.number().int().min(0).max(2),
  maximumClarificationRounds: z.literal(1),
  businessWritesDuringGeneration: z.literal(0),
  preserveFocusWithoutApply: z.literal(true),
  humanAssessment: nonEmpty,
});
export type ExpectedCriteria = z.infer<typeof expectedCriteriaSchema>;

const manifestSchema = z.strictObject({
  format: z.literal("newday-agent-evaluation-manifest"),
  version: z.literal(2),
  createdAt: z.string(),
  contractVersion: z.string(),
  heldoutCases: z.number().int(),
  developmentCases: z.number().int(),
  heldoutTrialsAtThreePerCase: z.number().int(),
  files: z.record(z.string(), z.strictObject({ sha256: sha256Schema })),
  claimBoundaries: z.array(z.string()),
  revises: z.string(),
  revisionNotes: z.array(z.string()),
});

const corpusSchema = z.object({
  format: z.literal("newday-agent-evaluation-corpus"),
  split: z.enum(["development", "heldout"]),
  executionPolicy: z.object({
    realProviderCallsAuthorized: z.literal(false),
    trialCountPerCase: z.literal(3),
  }),
  scenarios: z.array(z.unknown()),
});

export type FrozenScenario = {
  id: string;
  category: string;
  family: string;
  title: string;
  expected: ExpectedCriteria;
  clarificationAnswers?: Record<string, string>;
  snapshot: PlanningSnapshot;
  snapshotSha256: string;
  adaptations: string[];
};

export function sha256(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}

export async function readApprovedFreeze(path: string, acknowledgedSha256: string) {
  const source = await readFile(resolve(path));
  const freezeSha256 = sha256(source);
  if (acknowledgedSha256 !== freezeSha256) {
    throw new EvaluationGuardError("FREEZE_ACKNOWLEDGEMENT_MISMATCH", "--acknowledge-freeze-sha256 must equal the exact freeze file SHA-256");
  }
  const freeze = evaluationFreezeSchema.parse(JSON.parse(source.toString("utf8")));
  verifyFrozenContract(freeze);
  return { freeze, freezeSha256 };
}

export function verifyFrozenContract(freeze: EvaluationFreeze) {
  const actual = {
    promptVersion: AGENT_PROMPT_VERSION,
    schemaVersion: AGENT_SCHEMA_VERSION,
    systemPromptSha256: sha256(PLANNING_SYSTEM_PROMPT),
    providerSchemaSha256: sha256(JSON.stringify(planningProviderJsonSchema)),
  };
  for (const [key, value] of Object.entries(actual)) {
    if (freeze.contract[key as keyof typeof actual] !== value) {
      throw new EvaluationGuardError("CONTRACT_DRIFT", `frozen ${key} does not match the candidate`);
    }
  }
}

export async function loadFrozenScenario(options: {
  fixtureDirectory: string;
  freeze: EvaluationFreeze;
  scenarioId: string;
}): Promise<FrozenScenario> {
  const manifestPath = resolve(options.fixtureDirectory, "manifest-v2.json");
  const manifestSource = await readFile(manifestPath);
  if (sha256(manifestSource) !== options.freeze.fixtures.manifestSha256) {
    throw new EvaluationGuardError("MANIFEST_DRIFT", "manifest-v2.json does not match the frozen SHA-256");
  }
  const manifest = manifestSchema.parse(JSON.parse(manifestSource.toString("utf8")));
  const corpusFilename = options.freeze.scope.split === "heldout" ? "heldout-v2.json" : "development-v1.json";
  const corpusSource = await readFile(resolve(options.fixtureDirectory, corpusFilename));
  const corpusSha256 = sha256(corpusSource);
  if (corpusSha256 !== manifest.files[corpusFilename]?.sha256 || corpusSha256 !== options.freeze.fixtures.corpusSha256) {
    throw new EvaluationGuardError("CORPUS_DRIFT", `${corpusFilename} does not match the manifest and freeze`);
  }
  const corpus = corpusSchema.parse(JSON.parse(corpusSource.toString("utf8")));
  if (corpus.split !== options.freeze.scope.split) {
    throw new EvaluationGuardError("SPLIT_MISMATCH", "frozen split does not match the corpus");
  }
  const expectedCount = corpus.split === "heldout" ? manifest.heldoutCases : manifest.developmentCases;
  if (corpus.scenarios.length !== expectedCount) {
    throw new EvaluationGuardError("CORPUS_COUNT_MISMATCH", "corpus scenario count changed");
  }
  const parsedScenarios = corpus.scenarios.map((value) => evaluationScenarioInputSchema.parse(value));
  const corpusIds = parsedScenarios.map(({ id }) => id);
  const frozenIds = options.freeze.scope.scenarioIds;
  if (corpus.split === "heldout" && !sameStringSet(corpusIds, frozenIds)) {
    throw new EvaluationGuardError("INCOMPLETE_HELDOUT_SCOPE", "heldout freeze must contain all 40 frozen scenario IDs exactly once");
  }
  if (frozenIds.some((id) => !corpusIds.includes(id))) {
    throw new EvaluationGuardError("UNKNOWN_SCENARIO_SCOPE", "freeze contains a scenario ID outside the selected corpus");
  }
  if (!frozenIds.includes(options.scenarioId)) {
    throw new EvaluationGuardError("SCENARIO_OUTSIDE_SCOPE", "requested scenario is outside the approved freeze scope");
  }
  const scenario = parsedScenarios.find(({ id }) => id === options.scenarioId);
  if (!scenario) throw new EvaluationGuardError("SCENARIO_NOT_FOUND", "requested scenario does not exist in the frozen corpus");
  const prepared = await prepareEvaluationScenario(scenario);
  if (prepared.gaps.length) {
    throw new EvaluationGuardError("SNAPSHOT_GAP", `scenario has unsupported snapshot gaps: ${prepared.gaps.join("; ")}`);
  }
  return {
    id: scenario.id,
    category: scenario.category,
    family: scenario.family,
    title: scenario.title,
    expected: expectedCriteriaSchema.parse(scenario.expected),
    ...(scenario.clarificationAnswers ? { clarificationAnswers: scenario.clarificationAnswers } : {}),
    snapshot: prepared.snapshot,
    snapshotSha256: sha256(JSON.stringify(prepared.snapshot)),
    adaptations: prepared.adaptations,
  };
}

function sameStringSet(left: string[], right: string[]) {
  return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
}

export type ProviderConfiguration = {
  provider: string;
  baseUrl: string;
  allowHttpOrigin?: string;
  modelId?: string;
  apiKey?: string;
  reasoningEffort?: string;
  maxOutputTokens: number;
  timeoutMs: number;
};

export function verifyProviderConfiguration(freeze: EvaluationFreeze, configuration: ProviderConfiguration) {
  if (configuration.provider !== freeze.provider.kind || !configuration.apiKey || !configuration.modelId) {
    throw new EvaluationGuardError("PROVIDER_NOT_CONFIGURED", "the approved openai-compatible provider is not fully configured");
  }
  const checks: Array<[string, unknown, unknown]> = [
    ["provider origin", new URL(configuration.baseUrl).origin, freeze.provider.origin],
    ["provider base URL hash", sha256(configuration.baseUrl), freeze.provider.baseUrlSha256],
    ["provider HTTP origin exception", configuration.allowHttpOrigin ?? null, freeze.provider.allowHttpOrigin],
    ["model ID", configuration.modelId, freeze.provider.modelId],
    ["reasoning effort", configuration.reasoningEffort ?? "provider_default", freeze.provider.reasoningEffort],
    ["max output tokens", configuration.maxOutputTokens, freeze.provider.maxOutputTokens],
    ["timeout", configuration.timeoutMs, freeze.provider.timeoutMs],
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) throw new EvaluationGuardError("PROVIDER_CONFIG_DRIFT", `${label} does not match the approved freeze`);
  }
}

export function verifyCandidateState(freeze: EvaluationFreeze, head: string, porcelainStatus: string) {
  if (head.trim() !== freeze.candidate.gitSha) {
    throw new EvaluationGuardError("CANDIDATE_SHA_MISMATCH", "current HEAD does not match the approved candidate SHA");
  }
  if (porcelainStatus.trim()) {
    throw new EvaluationGuardError("DIRTY_WORKTREE", "evaluation requires the exact clean approved candidate worktree");
  }
}

export type TrialErrorRecord = {
  name: string;
  message: string;
  code?: string;
  statusCode?: number;
  retryable?: boolean;
};

export type TrialCallRecord = {
  sequence: number;
  startedAt: string;
  endedAt: string | null;
  elapsedMs: number | null;
  outcome: "reserved" | "generation_returned" | "validated" | "generation_error" | "validation_error" | "model_drift";
  repairIssues?: string[];
  providerModelId: string | null;
  usage: ModelUsage | null;
  rawOutput?: unknown;
  validationError?: TrialErrorRecord;
  generationError?: TrialErrorRecord;
};

export type ModelPhaseResult =
  | { status: "validated"; output: PlanningModelOutput; calls: TrialCallRecord[] }
  | { status: "failed"; error: TrialErrorRecord; calls: TrialCallRecord[] }
  | { status: "model_drift"; error: TrialErrorRecord; calls: TrialCallRecord[] };

export async function runModelPhase(options: {
  model: PlanningModel;
  expectedModelId: string;
  snapshot: PlanningSnapshot;
  answers: PlanningAnswers;
  clarificationRound: 0 | 1;
  callsAlreadyUsed: number;
  timeoutMs: number;
  secrets?: string[];
  now?: () => number;
  beforeCall: (call: TrialCallRecord) => Promise<void>;
  afterCall: (call: TrialCallRecord) => Promise<void>;
}): Promise<ModelPhaseResult> {
  const calls: TrialCallRecord[] = [];
  let repair: { issues: string[] } | undefined;
  const now = options.now ?? Date.now;
  for (;;) {
    if (options.callsAlreadyUsed + calls.length >= 3) {
      const error = errorRecord(new EvaluationGuardError("TRIAL_CALL_CAP_REACHED", "trial reached its three-call host limit"), options.secrets);
      return { status: "failed", error, calls };
    }
    const started = now();
    const call: TrialCallRecord = {
      sequence: options.callsAlreadyUsed + calls.length + 1,
      startedAt: new Date(started).toISOString(),
      endedAt: null,
      elapsedMs: null,
      outcome: "reserved",
      ...(repair ? { repairIssues: [...repair.issues] } : {}),
      providerModelId: null,
      usage: null,
    };
    await options.beforeCall(call);
    calls.push(call);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AgentApiError("MODEL_TIMEOUT", 504, "model response exceeded the frozen timeout", true));
      }, options.timeoutMs);
    });
    let retry: { issues: string[] } | undefined;
    try {
      const generation = await Promise.race([
        options.model.generate(options.snapshot, options.answers, controller.signal, repair),
        timeout,
      ]);
      call.outcome = "generation_returned";
      call.providerModelId = generation.modelId;
      call.usage = generation.usage;
      call.rawOutput = generation.output;
      if (generation.modelId !== options.expectedModelId) {
        const mismatch = new EvaluationGuardError("PROVIDER_MODEL_DRIFT", "provider-reported model ID differs from the approved model ID");
        call.outcome = "model_drift";
        call.validationError = errorRecord(mismatch, options.secrets);
        return finishPhase("model_drift", mismatch, call, calls, now, options);
      }
      try {
        const output = validatePlanningOutput(generation.output, options.snapshot, options.clarificationRound);
        call.outcome = "validated";
        finishCall(call, now);
        await options.afterCall(call);
        return { status: "validated", output, calls };
      } catch (error) {
        call.outcome = "validation_error";
        call.validationError = errorRecord(error, options.secrets);
        if (isRepairable(error) && !repair && options.callsAlreadyUsed + calls.length < 3) {
          retry = {
            issues: error instanceof InvalidPlanningOutputError
              ? error.issues
              : ["Return one complete JSON object matching the required schema."],
          };
        } else {
          return finishPhase("failed", error, call, calls, now, options);
        }
      }
    } catch (error) {
      call.outcome = "generation_error";
      call.generationError = errorRecord(error, options.secrets);
      if (isRepairable(error) && !repair && options.callsAlreadyUsed + calls.length < 3) {
        retry = { issues: ["Return one complete JSON object matching the required schema."] };
      } else {
        return finishPhase("failed", error, call, calls, now, options);
      }
    } finally {
      clearTimeout(timer);
    }
    finishCall(call, now);
    await options.afterCall(call);
    repair = retry;
  }
}

async function finishPhase(
  status: "failed" | "model_drift",
  error: unknown,
  call: TrialCallRecord,
  calls: TrialCallRecord[],
  now: () => number,
  options: Pick<Parameters<typeof runModelPhase>[0], "afterCall" | "secrets">,
): Promise<ModelPhaseResult> {
  finishCall(call, now);
  await options.afterCall(call);
  return { status, error: errorRecord(error, options.secrets), calls };
}

function finishCall(call: TrialCallRecord, now: () => number) {
  const ended = now();
  call.endedAt = new Date(ended).toISOString();
  call.elapsedMs = Math.max(0, ended - Date.parse(call.startedAt));
}

function isRepairable(error: unknown) {
  return error instanceof InvalidPlanningOutputError
    ? error.repairable
    : error instanceof AgentApiError && error.code === "MODEL_INVALID_OUTPUT";
}

export function errorRecord(error: unknown, secrets: string[] = []): TrialErrorRecord {
  const message = sanitizeString(error instanceof Error ? error.message : "unknown evaluation error", secrets).slice(0, 2_000);
  if (error instanceof AgentApiError) {
    return { name: error.name, message, code: error.code, statusCode: error.statusCode, retryable: error.retryable };
  }
  if (error instanceof EvaluationGuardError) return { name: error.name, message, code: error.code };
  return { name: error instanceof Error ? error.name : "Error", message };
}

export function initialHostOutput(snapshot: PlanningSnapshot) {
  return forcedNoAction(snapshot);
}

export function trialId(split: "development" | "heldout", scenarioId: string, repetition: number) {
  if (!Number.isInteger(repetition) || repetition < 1 || repetition > 3) {
    throw new EvaluationGuardError("INVALID_REPETITION", "repetition must be 1, 2 or 3");
  }
  return `${split}:${scenarioId}:${repetition}`;
}

export function validateClarificationMapping(options: {
  source: unknown;
  expectedTrialId: string;
  questions: Extract<PlanningModelOutput, { kind: "needs_clarification" }>["questions"];
  clarificationAnswers: Record<string, string> | undefined;
  reviewer: string;
}): { mapping: ClarificationMapping; answers: PlanningAnswers } {
  const mapping = clarificationMappingSchema.parse(options.source);
  if (mapping.trialId !== options.expectedTrialId) throw new EvaluationGuardError("MAPPING_TRIAL_MISMATCH", "mapping trialId does not match the paused trial");
  if (mapping.reviewer !== options.reviewer) throw new EvaluationGuardError("MAPPING_REVIEWER_MISMATCH", "mapping reviewer does not match the frozen primary reviewer");
  const semanticEntries = Object.entries(options.clarificationAnswers ?? {});
  if (semanticEntries.length !== 1 || options.questions.length !== 1) {
    throw new EvaluationGuardError("CLARIFICATION_NOT_UNIQUE", "resume requires exactly one frozen semantic answer and one first-round question");
  }
  const [[semanticKey, answer]] = semanticEntries;
  const [question] = options.questions;
  if (mapping.semanticKey !== semanticKey || mapping.answer !== answer ||
    mapping.questionId !== question.id || mapping.questionText !== question.question) {
    throw new EvaluationGuardError("MAPPING_CONTENT_MISMATCH", "mapping must preserve the exact semantic key, answer, question ID and question text");
  }
  return { mapping, answers: [{ questionId: question.id, question: question.question, answer }] };
}

export type TrialStatus =
  | "running"
  | "operator_action_required"
  | "completed"
  | "failed"
  | "stopped";

const ledgerTrialSchema = z.strictObject({
  status: z.enum(["running", "operator_action_required", "completed", "failed", "stopped"]),
  reportFile: z.string().min(1),
  reportSha256: sha256Schema.nullable(),
  callsReserved: z.number().int().nonnegative().max(3),
  updatedAt: instant,
});

export const evaluationLedgerSchema = z.strictObject({
  format: z.literal("newday-agent-evaluation-ledger"),
  version: z.literal(1),
  freezeSha256: sha256Schema,
  createdAt: instant,
  updatedAt: instant,
  maxOutboundCallsTotal: z.number().int().positive(),
  reservedOutboundCalls: z.number().int().nonnegative(),
  reservedCostUpperBound: z.number().finite().nonnegative().nullable(),
  currency: z.string().nullable(),
  batchStatus: z.enum(["active", "stopped"]),
  stopReason: z.string().nullable(),
  trials: z.record(z.string(), ledgerTrialSchema),
});
export type EvaluationLedger = z.infer<typeof evaluationLedgerSchema>;

export function createLedger(freeze: EvaluationFreeze, freezeSha256: string, at = new Date().toISOString()): EvaluationLedger {
  return {
    format: "newday-agent-evaluation-ledger",
    version: 1,
    freezeSha256,
    createdAt: at,
    updatedAt: at,
    maxOutboundCallsTotal: freeze.scope.maxOutboundCallsTotal,
    reservedOutboundCalls: 0,
    reservedCostUpperBound: freeze.scope.costControl.mode === "known_upper_bound" ? 0 : null,
    currency: freeze.scope.costControl.mode === "known_upper_bound" ? freeze.scope.costControl.currency : null,
    batchStatus: "active",
    stopReason: null,
    trials: {},
  };
}

export function beginTrial(ledger: EvaluationLedger, id: string, reportFile: string, at = new Date().toISOString()) {
  if (ledger.batchStatus !== "active") throw new EvaluationGuardError("BATCH_STOPPED", `evaluation batch is stopped: ${ledger.stopReason ?? "unknown reason"}`);
  if (ledger.trials[id]) throw new EvaluationGuardError("DUPLICATE_TRIAL", "trial ID already exists; completed and failed trials cannot be overwritten or rerun");
  ledger.trials[id] = { status: "running", reportFile, reportSha256: null, callsReserved: 0, updatedAt: at };
  ledger.updatedAt = at;
}

export function resumeTrial(ledger: EvaluationLedger, id: string, at = new Date().toISOString()) {
  if (ledger.batchStatus !== "active") throw new EvaluationGuardError("BATCH_STOPPED", `evaluation batch is stopped: ${ledger.stopReason ?? "unknown reason"}`);
  const trial = ledger.trials[id];
  if (!trial || trial.status !== "operator_action_required") {
    throw new EvaluationGuardError("TRIAL_NOT_RESUMABLE", "only an operator_action_required trial can be resumed");
  }
  trial.status = "running";
  trial.updatedAt = at;
  ledger.updatedAt = at;
}

export function reserveOutboundCall(ledger: EvaluationLedger, freeze: EvaluationFreeze, id: string, at = new Date().toISOString()) {
  const trial = ledger.trials[id];
  if (!trial || trial.status !== "running") throw new EvaluationGuardError("TRIAL_NOT_RUNNING", "cannot reserve a call for a non-running trial");
  if (trial.callsReserved >= 3) return stopLedger(ledger, "trial_call_cap_reached", at);
  if (ledger.reservedOutboundCalls >= ledger.maxOutboundCallsTotal) return stopLedger(ledger, "outbound_call_cap_reached", at);
  if (freeze.scope.costControl.mode === "known_upper_bound") {
    const next = (ledger.reservedCostUpperBound ?? 0) + freeze.scope.costControl.maxPerOutboundCall;
    if (next > freeze.scope.costControl.maxTotal) return stopLedger(ledger, "cost_control_reached", at);
    ledger.reservedCostUpperBound = next;
  }
  ledger.reservedOutboundCalls += 1;
  trial.callsReserved += 1;
  trial.updatedAt = at;
  ledger.updatedAt = at;
  return { allowed: true as const, reservation: ledger.reservedOutboundCalls };
}

function stopLedger(ledger: EvaluationLedger, reason: string, at: string) {
  ledger.batchStatus = "stopped";
  ledger.stopReason = reason;
  ledger.updatedAt = at;
  return { allowed: false as const, reason };
}

export function stopEvaluation(ledger: EvaluationLedger, reason: string, at = new Date().toISOString()) {
  return stopLedger(ledger, reason, at);
}

export function updateTrialStatus(ledger: EvaluationLedger, id: string, status: TrialStatus, at = new Date().toISOString()) {
  const trial = ledger.trials[id];
  if (!trial) throw new EvaluationGuardError("TRIAL_NOT_FOUND", "trial ledger entry is missing");
  trial.status = status;
  trial.updatedAt = at;
  ledger.updatedAt = at;
}

export function setTrialReportHash(ledger: EvaluationLedger, id: string, reportSha256: string, at = new Date().toISOString()) {
  const trial = ledger.trials[id];
  if (!trial) throw new EvaluationGuardError("TRIAL_NOT_FOUND", "trial ledger entry is missing");
  if (!/^[a-f0-9]{64}$/.test(reportSha256)) throw new EvaluationGuardError("INVALID_REPORT_HASH", "report SHA-256 is invalid");
  trial.reportSha256 = reportSha256;
  trial.updatedAt = at;
  ledger.updatedAt = at;
}

export async function prepareEvidenceDirectory(evidenceDirectory: string, repositoryRoot: string) {
  const requested = resolve(evidenceDirectory);
  const repositoryReal = await realpath(resolve(repositoryRoot));
  assertOutsideRepository(requested, repositoryReal);

  const missingSegments: string[] = [];
  let existingAncestor = requested;
  let existingEntry;
  for (;;) {
    try {
      existingEntry = await lstat(existingAncestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
  if (existingAncestor === requested && existingEntry.isSymbolicLink()) {
    throw new EvaluationGuardError("INSECURE_EVIDENCE_DIRECTORY", "evidence directory must be a real directory, not a symbolic link");
  }
  let evidenceReal = await realpath(existingAncestor);
  assertOutsideRepository(evidenceReal, repositoryReal);
  if (!(await stat(evidenceReal)).isDirectory()) {
    throw new EvaluationGuardError("INSECURE_EVIDENCE_DIRECTORY", "evidence path ancestor must be a directory");
  }
  for (const segment of missingSegments) {
    const next = join(evidenceReal, segment);
    try { await mkdir(next, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const entry = await lstat(next);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new EvaluationGuardError("INSECURE_EVIDENCE_DIRECTORY", "evidence path components must be real directories, not symbolic links");
    }
    const nextReal = await realpath(next);
    assertOutsideRepository(nextReal, repositoryReal);
    if (nextReal !== next) {
      throw new EvaluationGuardError("INSECURE_EVIDENCE_DIRECTORY", "evidence path changed while it was being created");
    }
    evidenceReal = nextReal;
  }

  const requestedEntry = await lstat(requested);
  if (!requestedEntry.isDirectory() || requestedEntry.isSymbolicLink()) {
    throw new EvaluationGuardError("INSECURE_EVIDENCE_DIRECTORY", "evidence directory must be a real directory, not a symbolic link");
  }
  if (await realpath(requested) !== evidenceReal) {
    throw new EvaluationGuardError("INSECURE_EVIDENCE_DIRECTORY", "evidence path changed while it was being verified");
  }
  assertOutsideRepository(evidenceReal, repositoryReal);
  await chmod(evidenceReal, 0o700);
  const mode = (await stat(evidenceReal)).mode & 0o777;
  if (mode !== 0o700) throw new EvaluationGuardError("INSECURE_EVIDENCE_DIRECTORY", "evidence directory must have mode 0700");

  const trialsPath = join(evidenceReal, "trials");
  try { await mkdir(trialsPath, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const trialsEntry = await lstat(trialsPath);
  if (!trialsEntry.isDirectory() || trialsEntry.isSymbolicLink()) {
    throw new EvaluationGuardError("INSECURE_TRIALS_DIRECTORY", "evidence trials path must be a real directory, not a symbolic link");
  }
  const trialsReal = await realpath(trialsPath);
  assertOutsideRepository(trialsReal, repositoryReal);
  if (trialsReal !== trialsPath || relative(evidenceReal, trialsReal) !== "trials") {
    throw new EvaluationGuardError("INSECURE_TRIALS_DIRECTORY", "evidence trials path must stay directly inside the evidence directory");
  }
  await chmod(trialsReal, 0o700);
  if (((await stat(trialsReal)).mode & 0o777) !== 0o700) {
    throw new EvaluationGuardError("INSECURE_TRIALS_DIRECTORY", "evidence trials directory must have mode 0700");
  }
  return evidenceReal;
}

function assertOutsideRepository(candidate: string, repository: string) {
  const path = relative(repository, candidate);
  if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) {
    throw new EvaluationGuardError("EVIDENCE_INSIDE_REPOSITORY", "private evaluation evidence must be stored outside the repository");
  }
}

export async function acquireEvidenceLock(evidenceDirectory: string) {
  const path = join(evidenceDirectory, ".evaluation.lock");
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new EvaluationGuardError("EVALUATION_LOCKED", "another evaluation command may be running; inspect the ledger before removing a stale lock");
    }
    throw error;
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n");
  return async () => {
    await handle.close();
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  };
}

export async function readLedger(evidenceDirectory: string) {
  const path = join(evidenceDirectory, "ledger.json");
  try {
    const source = await readFile(path);
    return { ledger: evaluationLedgerSchema.parse(JSON.parse(source.toString("utf8"))), source, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ledger: null, source: null, path };
    throw error;
  }
}

export function verifyReviewedLedger(source: Buffer | null, reviewedSha256: string) {
  if (!source) {
    if (reviewedSha256 !== "new") throw new EvaluationGuardError("LEDGER_REVIEW_MISMATCH", "the first command must use --reviewed-ledger-sha256 new");
    return;
  }
  if (sha256(source) !== reviewedSha256) {
    throw new EvaluationGuardError("LEDGER_REVIEW_MISMATCH", "--reviewed-ledger-sha256 must equal the current ledger SHA-256");
  }
}

export async function writeLedger(path: string, ledger: EvaluationLedger, secrets: string[] = []) {
  evaluationLedgerSchema.parse(ledger);
  await writeJsonAtomic(path, ledger, secrets);
}

export async function writeReportExclusive(path: string, report: unknown, secrets: string[] = []) {
  await writeFile(path, secureJson(report, secrets), { flag: "wx", mode: 0o600 });
}

export async function replaceReport(path: string, report: unknown, secrets: string[] = []) {
  await writeJsonAtomic(path, report, secrets);
}

async function writeJsonAtomic(path: string, value: unknown, secrets: string[]) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, secureJson(value, secrets), { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function secureJson(value: unknown, secrets: string[] = []) {
  const sanitized = JSON.parse(JSON.stringify(value), (_key, entry) =>
    typeof entry === "string" ? sanitizeString(entry, secrets) : entry);
  return JSON.stringify(sanitized, null, 2) + "\n";
}

function sanitizeString(value: string, secrets: string[]) {
  let result = value.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  for (const secret of secrets.filter(Boolean)) result = result.replaceAll(secret, "[REDACTED]");
  return result;
}

export class EvaluationGuardError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "EvaluationGuardError";
  }
}
