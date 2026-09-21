import { describe, expect, it } from "vitest";

import { reconcileNotionTask } from "../../../../packages/core/src/application/notion-sync-reconcile";
import type { NotionTaskFields } from "../../../../packages/core/src/contracts/notion-sync";

const initial: NotionTaskFields = {
  title: "提交材料",
  date: ["2026-09-20", "2026-09-21"],
  completed: false,
};

describe("Notion shared-field reconciliation", () => {
  it("merges independent title and complete-range changes", () => {
    const result = reconcileNotionTask({
      baseline: initial,
      local: { ...initial, date: ["2026-09-22", "2026-09-23"] },
      remote: { ...initial, title: "提交项目材料" },
    });

    expect(result.merged).toEqual({ title: "提交项目材料", date: ["2026-09-22", "2026-09-23"], completed: false });
    expect(result.remotePatch).toEqual({ date: ["2026-09-22", "2026-09-23"] });
    expect(result.conflicts).toEqual([]);
  });

  it("keeps Notion's whole date range when both sides change it", () => {
    const local: NotionTaskFields = { ...initial, date: ["2026-09-21", "2026-09-22"] };
    const remote: NotionTaskFields = { ...initial, date: ["2026-09-19", "2026-09-23"] };
    const result = reconcileNotionTask({ baseline: initial, local, remote });

    expect(result.merged.date).toEqual(remote.date);
    expect(result.remotePatch).toEqual({});
    expect(result.conflicts).toEqual([{
      field: "date", baseline: initial.date, local: local.date, remote: remote.date, winner: "notion",
    }]);
  });

  it("does not call matching changes a conflict", () => {
    const same: NotionTaskFields = { ...initial, completed: true };
    const result = reconcileNotionTask({ baseline: initial, local: same, remote: same });

    expect(result.merged).toEqual(same);
    expect(result.remotePatch).toEqual({});
    expect(result.conflicts).toEqual([]);
  });

  it("handles a cleared date as one nullable field", () => {
    const result = reconcileNotionTask({
      baseline: initial,
      local: { ...initial, title: "本地标题" },
      remote: { ...initial, date: null },
    });

    expect(result.merged).toEqual({ title: "本地标题", date: null, completed: false });
    expect(result.remotePatch).toEqual({ title: "本地标题" });
  });

  it("rejects an invalid remote range instead of combining or normalizing it", () => {
    expect(() => reconcileNotionTask({
      baseline: initial,
      local: initial,
      remote: { ...initial, date: ["2026-09-22", "2026-09-21"] },
    })).toThrow();
  });
});
