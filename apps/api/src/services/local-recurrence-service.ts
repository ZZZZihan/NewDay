import { materializeRecurrenceOccurrences, type EnsureRecurrenceOccurrencesInput } from "@newday/core/application/recurrence-generation";

import type { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";

/** Notion-owned rules materialize only after a complete Tasks scan, where the
 * occurrence mapping and outbound intent can be committed together. */
export function ensureLocalRecurrenceOccurrences(store: SQLitePlannerStore,
  input: EnsureRecurrenceOccurrencesInput) {
  return store.transaction(async () => {
    const linked = new Set((await store.listNotionRuleMappings()).map((mapping) => mapping.logicalSeriesId));
    const series = (await store.listAllRecurrenceSeries()).filter((item) => !linked.has(item.logicalSeriesId));
    return materializeRecurrenceOccurrences(store, series, input);
  });
}
