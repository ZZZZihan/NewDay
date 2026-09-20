import { describe, expect, it } from "vitest";
import development from "../fixtures/development-v1.json";
import heldout from "../fixtures/heldout-v1.json";
import { prepareEvaluationScenario } from "../evaluation/prepare-snapshot";

describe("frozen corpus to production snapshot preflight", () => {
  it("builds all 52 synthetic snapshots and explicitly reports inputs the runtime cannot represent", async () => {
    const cases = [...development.scenarios, ...heldout.scenarios];
    const prepared = await Promise.all(cases.map((scenario) => prepareEvaluationScenario(scenario)));
    expect(prepared).toHaveLength(52);
    for (const [index, entry] of prepared.entries()) {
      expect(entry.snapshot.date, entry.id).toBe(cases[index].input.date);
      expect(entry.snapshot.timeZone, entry.id).toBe(cases[index].input.timeZone);
      expect(entry.snapshot.scope.complete, entry.id).toBe(true);
      expect(entry.snapshot.candidates.every(({ task }) => cases[index].input.tasks.some(({ id }) => id === task.id)), entry.id).toBe(true);
    }
    expect(prepared.filter(({ gaps }) => gaps.length).map(({ id }) => id)).toEqual(["H-P05", "H-P07"]);
  });
});
