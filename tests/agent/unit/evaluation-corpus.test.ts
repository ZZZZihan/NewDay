import { describe, expect, it } from "vitest";
import { dateInTimeZone, timeZoneSchema } from "@newday/core/contracts/agent-planning";
import { taskSchema } from "@newday/core/domain/planner-model";
import development from "../fixtures/development-v1.json";
import heldout from "../fixtures/heldout-v1.json";
import manifest from "../fixtures/manifest-v1.json";

describe("frozen evaluation input specifications (not model quality)", () => {
  it("reserves forty cases across four categories and keeps development families separate", () => {
    expect(heldout.scenarios).toHaveLength(40);
    expect(development.scenarios).toHaveLength(12);
    for (const category of ["normal", "constraints", "interaction", "robustness"]) {
      expect(heldout.scenarios.filter((scenario) => scenario.category === category)).toHaveLength(10);
    }
    const heldoutFamilies = new Set(heldout.scenarios.map((scenario) => scenario.family));
    expect(development.scenarios.filter((scenario) => heldoutFamilies.has(scenario.family))).toEqual([]);
    expect(manifest.heldoutTrialsAtThreePerCase).toBe(120);
    expect(heldout.executionPolicy.realProviderCallsAuthorized).toBe(false);
    expect(heldout.splitPolicy.mayTuneAgainst).toBe(false);
    expect(development.splitPolicy.mayTuneAgainst).toBe(true);
  });
  it("gives every input a unique identity, valid task data, and the correct local date", () => {
    const scenarios = [...development.scenarios, ...heldout.scenarios];
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
    for (const scenario of scenarios) {
      expect(timeZoneSchema.safeParse(scenario.input.timeZone).success, scenario.id).toBe(true);
      expect(dateInTimeZone(new Date(scenario.input.sampledAt), scenario.input.timeZone), scenario.id).toBe(scenario.input.date);
      const taskIds = new Set(scenario.input.tasks.map((task) => task.id));
      expect(taskIds.size, scenario.id).toBe(scenario.input.tasks.length);
      for (const task of scenario.input.tasks) {
        expect(taskSchema.safeParse(task).success, `${scenario.id}/${task.id}`).toBe(true);
      }
    }
  });
  it("does not invent expectation IDs or silently grant permission for generation writes", () => {
    for (const scenario of [...development.scenarios, ...heldout.scenarios]) {
      const ids = scenario.input.tasks.map((task) => task.id);
      for (const id of [...scenario.expected.requiredTaskIds, ...scenario.expected.forbiddenTaskIds, ...scenario.input.currentFocusTaskIds]) {
        expect(ids, scenario.id).toContain(id);
      }
      expect(scenario.expected.requiredTaskIds.filter((id) => new Set<string>(scenario.expected.forbiddenTaskIds).has(id)), scenario.id).toEqual([]);
      expect(scenario.expected.maximumSelections, scenario.id).toBeLessThanOrEqual(3);
      expect(scenario.expected.maximumQuestions, scenario.id).toBeLessThanOrEqual(2);
      expect(scenario.expected.maximumClarificationRounds, scenario.id).toBe(1);
      expect(scenario.expected.businessWritesDuringGeneration, scenario.id).toBe(0);
      expect(scenario.expected.preserveFocusWithoutApply, scenario.id).toBe(true);
      expect(scenario.expected.humanAssessment.length, scenario.id).toBeGreaterThan(0);
    }
  });
});
