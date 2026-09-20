import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AGENT_PROMPT_VERSION, AGENT_SCHEMA_VERSION } from "@newday/core/contracts/agent-planning";
import { PLANNING_SYSTEM_PROMPT, planningProviderJsonSchema } from "../apps/api/src/agent/planning-prompt.js";
import { prepareEvaluationScenario } from "../tests/agent/evaluation/prepare-snapshot.js";

// A local conversion audit. This file does not import a provider or fetch.
// It never reads .env and cannot start the 40 x 3 paid evaluation.
const { values } = parseArgs({ options: { output: { type: "string" } } });
const fixtureDirectory = fileURLToPath(new URL("../tests/agent/fixtures/", import.meta.url));
const manifestSource = await readFile(resolve(fixtureDirectory, "manifest-v2.json"));
const manifest = JSON.parse(manifestSource.toString("utf8")) as {
  version: number;
  files: Record<string, { sha256: string }>;
  heldoutCases: number;
  developmentCases: number;
};
if (manifest.version !== 2) throw new Error("manifest-v2.json: expected version 2");
const cases: Array<{ split: string; id: string; candidateCount: number; factCount: number; gaps: string[]; adaptations: string[] }> = [];
const corpusSha256: Record<string, string> = {};
for (const [split, filename, expectedCount] of [
  ["development", "development-v1.json", manifest.developmentCases],
  ["heldout", "heldout-v2.json", manifest.heldoutCases],
] as const) {
  const source = await readFile(resolve(fixtureDirectory, filename));
  const digest = sha256(source);
  if (digest !== manifest.files[filename]?.sha256) throw new Error(`${filename}: frozen corpus digest changed`);
  corpusSha256[filename] = digest;
  const corpus = JSON.parse(source.toString("utf8")) as { split: string; scenarios: unknown[] };
  if (corpus.split !== split || corpus.scenarios.length !== expectedCount)
    throw new Error(`${filename}: split or scenario count changed`);
  for (const value of corpus.scenarios) {
    const prepared = await prepareEvaluationScenario(value);
    cases.push({ split, id: prepared.id, candidateCount: prepared.snapshot.candidates.length,
      factCount: prepared.snapshot.facts.length, gaps: prepared.gaps, adaptations: prepared.adaptations });
  }
}
const blockedCases = cases.filter(({ gaps }) => gaps.length > 0);
const report = {
  format: "newday-agent-evaluation-preflight", version: 1, createdAt: new Date().toISOString(),
  status: blockedCases.length ? "blocked" : "ready_for_review",
  realProviderCalls: 0,
  manifestVersion: manifest.version, manifestSha256: sha256(manifestSource),
  promptVersion: AGENT_PROMPT_VERSION, schemaVersion: AGENT_SCHEMA_VERSION,
  systemPromptSha256: sha256(PLANNING_SYSTEM_PROMPT),
  providerSchemaSha256: sha256(JSON.stringify(planningProviderJsonSchema)),
  corpusSha256, scenarios: cases.length, blockedCases: blockedCases.map(({ split, id, gaps }) => ({ split, id, gaps })),
  cases,
  claimBoundary: "Snapshot conversion only. No model quality, cost, latency, G3 or G4 result is established.",
};
const output = JSON.stringify(report, null, 2) + "\n";
if (values.output) {
  const path = resolve(values.output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, output, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ reportPath: path, status: report.status, scenarios: cases.length, blockedCases: blockedCases.length, realProviderCalls: 0 }));
} else console.log(output);
if (blockedCases.length) process.exitCode = 2;

function sha256(source: Buffer | string) { return createHash("sha256").update(source).digest("hex"); }
