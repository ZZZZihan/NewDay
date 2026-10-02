import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import development from "../fixtures/development-v1.json";
import heldout from "../fixtures/heldout-v2.json";
import { prepareEvaluationScenario } from "../evaluation/prepare-snapshot";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const clarificationScenario = heldout.scenarios.find(({ id }) => id === "H-P05")!;

describe("evaluation snapshot identity across trial commands", () => {
  it("reconstructs all 52 complete snapshots byte for byte without changing the frozen inputs", async () => {
    for (const scenario of [...development.scenarios, ...heldout.scenarios]) {
      const original = JSON.stringify(scenario);
      const first = JSON.stringify((await prepareEvaluationScenario(scenario)).snapshot);
      const second = JSON.stringify((await prepareEvaluationScenario(scenario)).snapshot);
      expect(second, scenario.id).toBe(first);
      expect(sha256(second), scenario.id).toBe(sha256(first));
      expect(JSON.stringify(scenario), scenario.id).toBe(original);
    }
  });

  it("reconstructs H-P05 in a fresh process for a later clarification command", async () => {
    const first = JSON.stringify((await prepareEvaluationScenario(clarificationScenario)).snapshot);
    const helperUrl = pathToFileURL(resolve("tests/agent/evaluation/prepare-snapshot.ts")).href;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import { readFileSync } from "node:fs";
      const { prepareEvaluationScenario } = await import(${JSON.stringify(helperUrl)});
      const prepared = await prepareEvaluationScenario(JSON.parse(readFileSync(0, "utf8")));
      process.stdout.write(JSON.stringify(prepared.snapshot));
    // A cold TypeScript/SQLite process on the target host can exceed Vitest's
    // default 5s. Bound the child separately; this is an identity check, not a
    // provider latency assertion.
    `], { input: JSON.stringify(clarificationScenario), encoding: "utf8", timeout: 20_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(first);
    expect(sha256(child.stdout)).toBe(sha256(first));
  }, 30_000);

  it("separates fixture identities by scenario and input, without sending expected answers", async () => {
    const original = (await prepareEvaluationScenario(clarificationScenario)).snapshot;
    const renamed = (await prepareEvaluationScenario({ ...clarificationScenario, id: "H-P05-copy" })).snapshot;
    const changedInput = (await prepareEvaluationScenario({
      ...clarificationScenario,
      input: { ...clarificationScenario.input, context: { ...clarificationScenario.input.context, goal: "不同的合成目标" } },
    })).snapshot;
    const changedExpected = (await prepareEvaluationScenario({ ...clarificationScenario, expected: { acceptanceOnly: true } })).snapshot;
    for (const changed of [renamed, changedInput]) {
      expect(changed.id).not.toBe(original.id);
      expect(changed.version.datasetEpoch).not.toBe(original.version.datasetEpoch);
    }
    expect(changedExpected).toEqual(original);
  });
});
