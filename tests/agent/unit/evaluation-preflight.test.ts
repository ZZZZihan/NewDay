import { describe, expect, it } from "vitest";
import development from "../fixtures/development-v1.json";
import heldout from "../fixtures/heldout-v2.json";
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
      expect(entry.snapshot.preferences.learningEnabled, entry.id).toBe(true);
      expect(entry.adaptations, entry.id).toContain("learningEnabled: unspecified by fixture -> production default true");
      expect(entry.snapshot.candidates.every(({ task }) => cases[index].input.tasks.some(({ id }) => id === task.id)), entry.id).toBe(true);
    }
    expect(prepared.filter(({ gaps }) => gaps.length).map(({ id }) => id)).toEqual(["H-P05"]);
    expect(prepared.find(({ id }) => id === "H-C08")?.gaps).toEqual([]);
    expect(prepared.find(({ id }) => id === "H-C08")?.snapshot.candidates.map(({ task }) => task.id)).toEqual(["local"]);
    expect(prepared.find(({ id }) => id === "H-P08")?.adaptations).toContain(
      "priorHistory[0]: rejected on 2026-09-07 -> recorded user feedback at synthetic 2026-09-07T08:00:00.000Z; time of day was not supplied",
    );
    expect(prepared.find(({ id }) => id === "H-P07")?.adaptations).toContain(
      "priorHistory[0]: preference_deleted -> production add/delete setup at synthetic sampledAt 2026-09-08T08:00:00.000Z; deletion time was not supplied and removed text is excluded from the snapshot",
    );
    expect(prepared.find(({ id }) => id === "H-P07")?.snapshot.facts.some(({ text }) => text.includes("过去曾优先阅读"))).toBe(false);
    expect(prepared.find(({ id }) => id === "H-P07")?.snapshot.preferences.explicitPreferences).toEqual([]);
    expect(prepared.find(({ id }) => id === "H-P09")?.adaptations).toContain(
      "preference p1: soft -> production explicit preference fact; no hard-constraint enforcement",
    );
    expect(prepared.find(({ id }) => id === "H-C03")?.adaptations).toContain("f-wait: blocked -> blocked_task");
  });
});
