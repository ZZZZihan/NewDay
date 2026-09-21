import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { planningModelOutputSchema, type PlanningModelOutput } from "@newday/core/contracts/agent-planning";
import { z } from "zod";
import { OpenAICompatiblePlanningModel } from "../apps/api/src/agent/openai-compatible-model.js";
import { loadConfig } from "../apps/api/src/config.js";
import {
  acquireEvidenceLock,
  beginTrial,
  clarificationMappingSchema,
  createLedger,
  errorRecord,
  EvaluationGuardError,
  evaluationLedgerSchema,
  initialHostOutput,
  loadFrozenScenario,
  prepareEvidenceDirectory,
  readApprovedFreeze,
  readLedger,
  replaceReport,
  reserveOutboundCall,
  resumeTrial,
  runModelPhase,
  secureJson,
  setTrialReportHash,
  sha256,
  stopEvaluation,
  trialId,
  updateTrialStatus,
  validateClarificationMapping,
  verifyProviderConfiguration,
  verifyCandidateState,
  verifyReviewedLedger,
  writeLedger,
  writeReportExclusive,
  type EvaluationFreeze,
  type EvaluationLedger,
  type FrozenScenario,
  type TrialCallRecord,
  type TrialErrorRecord,
  type TrialStatus,
} from "./agent-evaluation-trial-lib.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureDirectory = join(repositoryRoot, "tests/agent/fixtures");

const { values } = parseArgs({
  options: {
    freeze: { type: "string" },
    scenario: { type: "string" },
    repetition: { type: "string" },
    evidence: { type: "string" },
    env: { type: "string", default: join(repositoryRoot, ".env") },
    mapping: { type: "string" },
    "acknowledge-freeze-sha256": { type: "string" },
    "reviewed-ledger-sha256": { type: "string" },
    "verify-only": { type: "boolean", default: false },
  },
  strict: true,
});

let releaseLock: (() => Promise<void>) | undefined;
let secret = "";
let activeLedger: EvaluationLedger | undefined;
let activeLedgerPath: string | undefined;
let activeTrialId: string | undefined;
let retainEvidenceLock = false;
try {
  const freezePath = required(values.freeze, "--freeze");
  const scenarioId = required(values.scenario, "--scenario");
  const evidenceArgument = required(values.evidence, "--evidence");
  const acknowledgedFreeze = required(values["acknowledge-freeze-sha256"], "--acknowledge-freeze-sha256");
  const reviewedLedger = required(values["reviewed-ledger-sha256"], "--reviewed-ledger-sha256");
  const repetition = Number(required(values.repetition, "--repetition"));
  const { freeze, freezeSha256 } = await readApprovedFreeze(freezePath, acknowledgedFreeze);
  if (resolve(evidenceArgument) !== resolve(freeze.evidenceDirectory)) {
    throw new EvaluationGuardError("EVIDENCE_PATH_MISMATCH", "--evidence must equal the absolute evidenceDirectory in the approved freeze");
  }
  const id = trialId(freeze.scope.split, scenarioId, repetition);
  const scenario = await loadFrozenScenario({ fixtureDirectory, freeze, scenarioId });
  await verifyCandidate(freeze);

  if (existsSync(values.env)) process.loadEnvFile(values.env);
  const config = loadConfig();
  verifyProviderConfiguration(freeze, config.agent);
  secret = config.agent.apiKey!;

  if (values["verify-only"]) {
    console.log(JSON.stringify({
      status: "verified_without_provider_call",
      trialId: id,
      freezeSha256,
      candidateSha: freeze.candidate.gitSha,
      snapshotSha256: scenario.snapshotSha256,
      realProviderCalls: 0,
      claimBoundary: "Configuration verification only. No trial, cost, model-quality result or G3 result is established.",
    }, null, 2));
    process.exit(0);
  }

  const evidenceDirectory = await prepareEvidenceDirectory(evidenceArgument, repositoryRoot);
  releaseLock = await acquireEvidenceLock(evidenceDirectory);
  const ledgerState = await readLedger(evidenceDirectory);
  verifyReviewedLedger(ledgerState.source, reviewedLedger);
  const ledger = ledgerState.ledger ?? createLedger(freeze, freezeSha256);
  verifyLedgerMatchesFreeze(ledger, freeze, freezeSha256);
  const reportPath = join(evidenceDirectory, "trials", `${id.replaceAll(":", "_")}.json`);
  activeLedger = ledger;
  activeLedgerPath = ledgerState.path;
  activeTrialId = id;

  let report: TrialReport;
  let answers: Array<{ questionId: string; question?: string; answer: string }> = [];
  let clarificationRound: 0 | 1 = 0;
  if (values.mapping) {
    report = await readResumableReport(reportPath, id, freezeSha256, scenario.snapshotSha256, ledger);
    const mappingSource = await readMappingSource(values.mapping);
    const firstRound = planningModelOutputSchema.parse(report.firstRoundOutput);
    if (firstRound.kind !== "needs_clarification") {
      throw new EvaluationGuardError("MISSING_FIRST_ROUND_QUESTIONS", "paused report has no first-round clarification questions");
    }
    const validated = validateClarificationMapping({
      source: mappingSource,
      expectedTrialId: id,
      questions: firstRound.questions,
      clarificationAnswers: scenario.clarificationAnswers,
      reviewer: freeze.humanReview.primaryReviewer,
    });
    answers = validated.answers;
    clarificationRound = 1;
    resumeTrial(ledger, id);
    report.status = "running";
    report.updatedAt = new Date().toISOString();
    report.clarificationMapping = validated.mapping;
    report.operatorAction = null;
    report.phases.push({ kind: "clarification_resume", startedAt: report.updatedAt, status: "running" });
    await persistReportAndLedger(reportPath, report, ledgerState.path, ledger, id, [secret]);
  } else {
    beginTrial(ledger, id, reportPath);
    report = newReport({ freeze, freezeSha256, id, scenario, repetition });
    await writeLedger(ledgerState.path, ledger, [secret]);
    await writeReportExclusive(reportPath, report, [secret]);
    await linkReportHashAndWriteLedger(reportPath, ledgerState.path, ledger, id, [secret]);
  }

  const forced = clarificationRound === 0 ? initialHostOutput(scenario.snapshot) : undefined;
  if (forced) {
    report.firstRoundOutput = forced;
    report.finalOutput = forced;
    report.status = "completed";
    report.phases[report.phases.length - 1] = {
      kind: "initial",
      startedAt: report.phases[0].startedAt,
      endedAt: new Date().toISOString(),
      status: "host_forced_no_action",
    };
    updateTrialStatus(ledger, id, "completed");
  } else {
    const model = new OpenAICompatiblePlanningModel({
      baseUrl: config.agent.baseUrl,
      apiKey: secret,
      modelId: config.agent.modelId!,
      allowHttpOrigin: config.agent.allowHttpOrigin,
      reasoningEffort: config.agent.reasoningEffort,
      maxOutputTokens: config.agent.maxOutputTokens,
    });
    const phase = await runModelPhase({
      model,
      expectedModelId: freeze.provider.modelId,
      snapshot: scenario.snapshot,
      answers,
      clarificationRound,
      callsAlreadyUsed: report.calls.length,
      timeoutMs: freeze.provider.timeoutMs,
      secrets: [secret],
      beforeCall: async (call) => {
        const reserved = reserveOutboundCall(ledger, freeze, id);
        if (!reserved.allowed) {
          report.status = "stopped";
          report.runnerError = { name: "EvaluationGuardError", code: reserved.reason, message: "approved evaluation limit reached before another provider request" };
          await writeLedger(ledgerState.path, ledger, [secret]);
          await persistReportAndLedger(reportPath, report, ledgerState.path, ledger, id, [secret]);
          throw new EvaluationGuardError(reserved.reason, "approved evaluation limit reached before another provider request");
        }
        upsertCall(report, call);
        report.updatedAt = new Date().toISOString();
        await writeLedger(ledgerState.path, ledger, [secret]);
        await persistReportAndLedger(reportPath, report, ledgerState.path, ledger, id, [secret]);
      },
      afterCall: async (call) => {
        upsertCall(report, call);
        report.updatedAt = new Date().toISOString();
        await persistReportAndLedger(reportPath, report, ledgerState.path, ledger, id, [secret]);
      },
    });
    applyPhaseResult({ report, ledger, id, scenario, phase, clarificationRound });
  }

  report.updatedAt = new Date().toISOString();
  report.cost = costRecord(freeze, ledger, ledger.trials[id].callsReserved);
  report.claimBoundary = "One guarded synthetic trial only. Human scores remain pending. This runner never applies a proposal and cannot establish G3 until the complete frozen batch and human review are present.";
  await persistReportAndLedger(reportPath, report, ledgerState.path, ledger, id, [secret]);
  const finalLedger = await readFile(ledgerState.path);
  console.log(JSON.stringify({
    reportPath,
    trialId: id,
    status: report.status,
    trialCallsReserved: ledger.trials[id].callsReserved,
    batchCallsReserved: ledger.reservedOutboundCalls,
    ledgerSha256: sha256(finalLedger),
    humanReview: "pending",
    G3: "not established",
  }, null, 2));
  if (report.status !== "completed" && report.status !== "operator_action_required") process.exitCode = 2;
} catch (error) {
  if (releaseLock && shouldStopAfterUnexpectedFailure(error)) {
    if (activeLedger && activeLedgerPath && activeTrialId) {
      stopEvaluation(activeLedger, "evidence_write_failure");
      if (activeLedger.trials[activeTrialId]) updateTrialStatus(activeLedger, activeTrialId, "stopped");
      try { await writeLedger(activeLedgerPath, activeLedger, [secret]); }
      catch { retainEvidenceLock = true; }
    } else {
      retainEvidenceLock = true;
    }
  }
  const record = errorRecord(error, [secret]);
  console.error(secureJson({
    status: "refused_or_failed",
    error: record,
    evidenceLockRetained: retainEvidenceLock,
    G3: "not established",
  }, [secret]).trimEnd());
  process.exitCode = 1;
} finally {
  if (releaseLock && !retainEvidenceLock) await releaseLock();
}

function required(value: string | undefined, name: string) {
  if (!value) throw new EvaluationGuardError("MISSING_ARGUMENT", `${name} is required`);
  return value;
}

async function verifyCandidate(freeze: EvaluationFreeze) {
  const [head, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: repositoryRoot }),
  ]);
  verifyCandidateState(freeze, head.stdout, status.stdout);
}

function verifyLedgerMatchesFreeze(ledger: EvaluationLedger, freeze: EvaluationFreeze, freezeSha256: string) {
  evaluationLedgerSchema.parse(ledger);
  if (ledger.freezeSha256 !== freezeSha256 || ledger.maxOutboundCallsTotal !== freeze.scope.maxOutboundCallsTotal) {
    throw new EvaluationGuardError("LEDGER_FREEZE_MISMATCH", "existing ledger belongs to another evaluation freeze");
  }
  const expectedCurrency = freeze.scope.costControl.mode === "known_upper_bound" ? freeze.scope.costControl.currency : null;
  if (ledger.currency !== expectedCurrency) throw new EvaluationGuardError("LEDGER_COST_MISMATCH", "ledger cost control differs from the freeze");
}

const persistedReportSchema = z.object({
  format: z.literal("newday-agent-evaluation-trial"),
  version: z.literal(1),
  trialId: z.string(),
  freezeSha256: z.string(),
  snapshotSha256: z.string(),
  status: z.literal("operator_action_required"),
  firstRoundOutput: z.unknown(),
  calls: z.array(z.object({
    sequence: z.number().int().min(1).max(3),
    endedAt: z.string().nullable(),
    outcome: z.enum(["reserved", "generation_returned", "validated", "generation_error", "validation_error", "model_drift"]),
  }).passthrough()),
  phases: z.array(z.object({ kind: z.enum(["initial", "clarification_resume"]), status: z.string() }).passthrough()).min(1),
}).passthrough();

async function readResumableReport(
  path: string,
  expectedId: string,
  freezeSha256: string,
  snapshotSha256: string,
  ledger: EvaluationLedger,
) {
  const source = await readFile(path);
  const report = persistedReportSchema.parse(JSON.parse(source.toString("utf8"))) as unknown as TrialReport;
  if (report.trialId !== expectedId || report.freezeSha256 !== freezeSha256 || report.snapshotSha256 !== snapshotSha256) {
    throw new EvaluationGuardError("REPORT_PROVENANCE_MISMATCH", "paused report does not match the exact trial, freeze and snapshot");
  }
  const entry = ledger.trials[expectedId];
  if (!entry || entry.reportFile !== path || entry.reportSha256 !== sha256(source) ||
    entry.callsReserved !== report.calls.length || report.calls.some(({ endedAt, outcome }) => !endedAt || outcome === "reserved")) {
    throw new EvaluationGuardError("REPORT_LEDGER_MISMATCH", "paused report does not match the reviewed ledger state");
  }
  const sequences = report.calls.map(({ sequence }) => sequence);
  if (sequences.some((sequence, index) => sequence !== index + 1)) {
    throw new EvaluationGuardError("REPORT_CALL_SEQUENCE_MISMATCH", "paused report call sequence is incomplete or reordered");
  }
  return report;
}

async function persistReportAndLedger(
  reportPath: string,
  report: TrialReport,
  ledgerPath: string,
  ledger: EvaluationLedger,
  id: string,
  secrets: string[],
) {
  await replaceReport(reportPath, report, secrets);
  await linkReportHashAndWriteLedger(reportPath, ledgerPath, ledger, id, secrets);
}

async function linkReportHashAndWriteLedger(
  reportPath: string,
  ledgerPath: string,
  ledger: EvaluationLedger,
  id: string,
  secrets: string[],
) {
  setTrialReportHash(ledger, id, sha256(await readFile(reportPath)));
  await writeLedger(ledgerPath, ledger, secrets);
}

function shouldStopAfterUnexpectedFailure(error: unknown) {
  if (!(error instanceof EvaluationGuardError)) return true;
  return !new Set([
    "DUPLICATE_TRIAL",
    "MAPPING_TRIAL_MISMATCH",
    "MAPPING_REVIEWER_MISMATCH",
    "MAPPING_CONTENT_MISMATCH",
    "CLARIFICATION_NOT_UNIQUE",
    "TRIAL_NOT_RESUMABLE",
    "INVALID_MAPPING_FILE",
    "outbound_call_cap_reached",
    "cost_control_reached",
    "trial_call_cap_reached",
    "BATCH_STOPPED",
  ]).has(error.code);
}

async function readMappingSource(path: string) {
  let source: unknown;
  try { source = JSON.parse(await readFile(resolve(path), "utf8")); }
  catch { throw new EvaluationGuardError("INVALID_MAPPING_FILE", "clarification mapping must be readable JSON"); }
  const parsed = clarificationMappingSchema.safeParse(source);
  if (!parsed.success) throw new EvaluationGuardError("INVALID_MAPPING_FILE", "clarification mapping does not match the required schema");
  return parsed.data;
}

type TrialPhase = {
  kind: "initial" | "clarification_resume";
  startedAt: string;
  endedAt?: string;
  status: string;
  error?: TrialErrorRecord;
};

type TrialReport = {
  format: "newday-agent-evaluation-trial";
  version: 1;
  trialId: string;
  createdAt: string;
  updatedAt: string;
  status: TrialStatus;
  freezeSha256: string;
  candidateSha: string;
  split: "development" | "heldout";
  scenarioId: string;
  repetition: number;
  scenario: Pick<FrozenScenario, "category" | "family" | "title" | "expected" | "adaptations">;
  snapshotSha256: string;
  snapshot: FrozenScenario["snapshot"];
  dataBoundary: {
    source: "frozen_synthetic_fixture";
    businessStorePassedToModel: false;
    proposalApplyPathAvailable: false;
    realUserDataExpected: false;
  };
  calls: TrialCallRecord[];
  phases: TrialPhase[];
  firstRoundOutput: PlanningModelOutput | null;
  finalOutput: PlanningModelOutput | null;
  clarificationMapping: z.infer<typeof clarificationMappingSchema> | null;
  operatorAction: Record<string, unknown> | null;
  runnerError: TrialErrorRecord | null;
  cost: Record<string, unknown>;
  humanReview: {
    status: "pending";
    assignedReviewer: string;
    structuralValidity: null;
    hardConstraintCompliance: null;
    grounding: null;
    goalAlignment: null;
    burden: null;
    safetyBoundary: null;
    notes: null;
  };
  claimBoundary: string;
};

function newReport(options: {
  freeze: EvaluationFreeze;
  freezeSha256: string;
  id: string;
  scenario: FrozenScenario;
  repetition: number;
}): TrialReport {
  const now = new Date().toISOString();
  return {
    format: "newday-agent-evaluation-trial",
    version: 1,
    trialId: options.id,
    createdAt: now,
    updatedAt: now,
    status: "running",
    freezeSha256: options.freezeSha256,
    candidateSha: options.freeze.candidate.gitSha,
    split: options.freeze.scope.split,
    scenarioId: options.scenario.id,
    repetition: options.repetition,
    scenario: {
      category: options.scenario.category,
      family: options.scenario.family,
      title: options.scenario.title,
      expected: options.scenario.expected,
      adaptations: options.scenario.adaptations,
    },
    snapshotSha256: options.scenario.snapshotSha256,
    snapshot: options.scenario.snapshot,
    dataBoundary: {
      source: "frozen_synthetic_fixture",
      businessStorePassedToModel: false,
      proposalApplyPathAvailable: false,
      realUserDataExpected: false,
    },
    calls: [],
    phases: [{ kind: "initial", startedAt: now, status: "running" }],
    firstRoundOutput: null,
    finalOutput: null,
    clarificationMapping: null,
    operatorAction: null,
    runnerError: null,
    cost: { actual: "unknown" },
    humanReview: {
      status: "pending",
      assignedReviewer: options.freeze.humanReview.primaryReviewer,
      structuralValidity: null,
      hardConstraintCompliance: null,
      grounding: null,
      goalAlignment: null,
      burden: null,
      safetyBoundary: null,
      notes: null,
    },
    claimBoundary: "Trial is running; no quality or G3 conclusion exists.",
  };
}

function upsertCall(report: TrialReport, call: TrialCallRecord) {
  const index = report.calls.findIndex(({ sequence }) => sequence === call.sequence);
  const copy = structuredClone(call);
  if (index === -1) report.calls.push(copy);
  else report.calls[index] = copy;
}

function applyPhaseResult(options: {
  report: TrialReport;
  ledger: EvaluationLedger;
  id: string;
  scenario: FrozenScenario;
  phase: Awaited<ReturnType<typeof runModelPhase>>;
  clarificationRound: 0 | 1;
}) {
  const { report, ledger, id, phase, scenario, clarificationRound } = options;
  const phaseRecord = report.phases[report.phases.length - 1];
  phaseRecord.endedAt = new Date().toISOString();
  if (phase.status === "model_drift") {
    report.status = "stopped";
    report.runnerError = phase.error;
    phaseRecord.status = "model_drift";
    phaseRecord.error = phase.error;
    stopEvaluation(ledger, "provider_or_model_drift");
    updateTrialStatus(ledger, id, "stopped");
    return;
  }
  if (phase.status === "failed") {
    report.status = "failed";
    report.runnerError = phase.error;
    phaseRecord.status = "failed";
    phaseRecord.error = phase.error;
    updateTrialStatus(ledger, id, "failed");
    return;
  }
  phaseRecord.status = "validated";
  if (clarificationRound === 0) report.firstRoundOutput = phase.output;
  if (phase.output.kind === "needs_clarification") {
    if (clarificationRound > 0) throw new EvaluationGuardError("SECOND_CLARIFICATION", "validated output unexpectedly requested a second clarification round");
    const frozenAnswers = Object.entries(scenario.clarificationAnswers ?? {});
    if (frozenAnswers.length === 1 && phase.output.questions.length === 1) {
      report.status = "operator_action_required";
      report.operatorAction = {
        reason: "human_semantic_mapping_required",
        semanticKey: frozenAnswers[0][0],
        frozenAnswer: frozenAnswers[0][1],
        questionId: phase.output.questions[0].id,
        questionText: phase.output.questions[0].question,
        instruction: "A human reviewer must attest the exact semantic match in a separate mapping file. The runner does not guess.",
      };
      updateTrialStatus(ledger, id, "operator_action_required");
      return;
    }
    report.status = "failed";
    report.runnerError = {
      name: "EvaluationGuardError",
      code: "NO_UNIQUE_FROZEN_CLARIFICATION_ANSWER",
      message: "first-round questions cannot be uniquely answered from the frozen fixture",
    };
    updateTrialStatus(ledger, id, "failed");
    return;
  }
  report.finalOutput = phase.output;
  report.status = "completed";
  updateTrialStatus(ledger, id, "completed");
}

function costRecord(freeze: EvaluationFreeze, ledger: EvaluationLedger, trialCalls: number) {
  if (freeze.scope.costControl.mode === "unknown") {
    return {
      mode: "unknown",
      actual: "unknown",
      trialOutboundCalls: trialCalls,
      policy: freeze.scope.costControl.policy,
      nextCommandRequiresReviewOfCurrentLedgerSha256: true,
    };
  }
  return {
    mode: "known_upper_bound",
    currency: freeze.scope.costControl.currency,
    trialOutboundCalls: trialCalls,
    reservedBatchUpperBound: ledger.reservedCostUpperBound,
    maxBatchUpperBound: freeze.scope.costControl.maxTotal,
    actual: "provider_did_not_report_money",
  };
}
