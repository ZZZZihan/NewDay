import { randomUUID } from "node:crypto";

import { materializeRecurrenceOccurrences } from "@newday/core/application/recurrence-generation";
import { notionClientKey, notionLogicalSeriesId, notionRuleSourceSchema, notionTaskFieldsSchema,
  type NotionConnection } from "@newday/core/contracts/notion-sync";
import { shiftDate } from "@newday/core/domain/planner-date";
import { recurrenceSeriesSchema, taskSchema, type LocalDate, type RecurrenceSeries } from "@newday/core/domain/planner-model";

import type { SQLitePlannerStore } from "../storage/sqlite-planner-store.js";
import { NotionReadFailure, type RuleRow } from "./notion-read-gateway.js";

/** Rule edits preserve already materialized occurrences as explicit exceptions.
 * This includes completed history and remote pages already created for the
 * future. Only new nominal dates use the revised rule; no page is deleted. */
export async function applyNotionRules(store: SQLitePlannerStore, connection: NotionConnection,
  rows: RuleRow[], archivedIds: string[], at: string): Promise<boolean> {
  const sourceId = connection.dataSources.rules?.dataSourceId;
  if (!sourceId) throw new NotionReadFailure("schema", "Notion Rules source is not initialized");
  const previous = new Map((await store.listNotionRuleMappings(connection.workspaceId)).map((item) => [item.remotePageId, item]));
  let changed = false;
  for (const row of rows) {
    if (row.inTrash) continue;
    const source = notionRuleSourceSchema.parse({ ...row.source,
      excludedDates: [...row.source.excludedDates].sort() });
    const logicalSeriesId = notionLogicalSeriesId(connection.workspaceId, row.id);
    const old = previous.get(row.id);
    if (old && (old.dataSourceId !== sourceId || old.logicalSeriesId !== logicalSeriesId)) {
      throw new NotionReadFailure("schema", `Notion rule ${row.id} changed identity`);
    }
    const before = await store.getRecurrenceSeries(logicalSeriesId);
    if (Boolean(old) !== Boolean(before)) {
      throw new NotionReadFailure("schema", `Notion rule ${row.id} lost its local series`);
    }
    const sourceChanged = !old || old.status !== "active" || JSON.stringify(old.source) !== JSON.stringify(source);
    const next = recurrenceSeriesSchema.parse({
      id: logicalSeriesId, logicalSeriesId, title: source.title,
      notes: before?.notes ?? "", startDate: source.startDate,
      effectiveEndDate: null, pattern: source.pattern,
      end: source.endDate ? { kind: "onDate", date: source.endDate } : { kind: "never" },
      excludedDates: source.excludedDates, disabled: false,
      createdAt: before?.createdAt ?? row.createdAt, updatedAt: sourceChanged ? at : before!.updatedAt,
    });
    if (sourceChanged) {
      // Old pages must not be rewritten by a rule edit. The nominal date in
      // each occurrence key remains stable even when its actual date changes.
      const latestOccurrence = before ? await preserveMaterializedOccurrences(store, logicalSeriesId) : undefined;
      const generationAfter = [old?.generationAfter, latestOccurrence]
        .filter((date): date is LocalDate => date !== undefined).sort().at(-1);
      await store.putRecurrenceSeries(next);
      await store.putNotionRuleMapping({ workspaceId: connection.workspaceId,
        dataSourceId: sourceId, remotePageId: row.id, logicalSeriesId,
        source, ...(generationAfter ? { generationAfter } : {}),
        generationReconcilePending: true, status: "active", updatedAt: at });
      changed = true;
    }
  }
  for (const ruleId of archivedIds) {
    const old = previous.get(ruleId);
    if (!old || old.status === "archived") continue;
    const series = await store.getRecurrenceSeries(old.logicalSeriesId);
    if (!series) throw new NotionReadFailure("schema", `Archived Notion rule ${ruleId} lost its local series`);
    const latestOccurrence = await preserveMaterializedOccurrences(store, old.logicalSeriesId);
    await store.putRecurrenceSeries(recurrenceSeriesSchema.parse({ ...series, disabled: true, updatedAt: at }));
    const generationAfter = [old.generationAfter, latestOccurrence]
      .filter((date): date is LocalDate => date !== undefined).sort().at(-1);
    await store.putNotionRuleMapping({ ...old, ...(generationAfter ? { generationAfter } : {}),
      status: "archived", updatedAt: at });
    changed = true;
  }
  return changed;
}

export async function enqueueNotionRuleInstances(store: SQLitePlannerStore, connection: NotionConnection,
  today: LocalDate, at: string): Promise<number> {
  const taskSourceId = connection.dataSources.tasks?.dataSourceId;
  if (!taskSourceId) throw new NotionReadFailure("schema", "Notion Tasks source is not initialized");
  const rules = new Map((await store.listNotionRuleMappings(connection.workspaceId))
    .filter((rule) => rule.status === "active")
    .map((rule) => [rule.logicalSeriesId, rule]));
  const tasks = await store.listAllTasks();
  const mapped = new Set((await store.listNotionTaskMappings()).map((item) => item.localTaskId));
  const through = shiftDate(today, 31);
  const activeSeries: RecurrenceSeries[] = [];
  for (const rule of rules.values()) {
    if (rule.generationReconcilePending) {
      const latestOccurrence = tasks.filter((task) => task.logicalSeriesId === rule.logicalSeriesId)
        .map((task) => task.occurrenceDate)
        .filter((date): date is LocalDate => date !== undefined).sort().at(-1);
      const generationAfter = [rule.generationAfter, latestOccurrence]
        .filter((date): date is LocalDate => date !== undefined).sort().at(-1);
      const updated = { ...rule, ...(generationAfter ? { generationAfter } : {}),
        generationReconcilePending: false, updatedAt: at };
      await store.putNotionRuleMapping(updated);
      rules.set(rule.logicalSeriesId, updated);
    }
  }
  for (const rule of rules.values()) {
    const series = await store.getRecurrenceSeries(rule.logicalSeriesId);
    if (!series || series.disabled) throw new NotionReadFailure("schema", `Notion rule ${rule.remotePageId} lost its active series`);
    if (rule.generationAfter && rule.generationAfter >= through) continue;
    const startDate = rule.generationAfter && rule.generationAfter >= series.startDate
      ? shiftDate(rule.generationAfter, 1) : series.startDate;
    activeSeries.push({ ...series, startDate });
  }
  await materializeRecurrenceOccurrences(store, activeSeries, { asOfDate: today, throughDate: through, now: at });
  const epoch = (await store.getPlanningVersion()).datasetEpoch;
  let count = 0;
  for (const task of await store.listAllTasks()) {
    if (!task.logicalSeriesId || !task.occurrenceDate || !task.occurrenceKey ||
      task.archived || mapped.has(task.id) || task.occurrenceDate < today || task.occurrenceDate > through) continue;
    const rule = rules.get(task.logicalSeriesId);
    if (!rule) continue;
    if (task.startDate === null || task.endDate === null) {
      throw new NotionReadFailure("schema", `Notion occurrence ${task.id} has no plan date`);
    }
    await store.putNotionTaskMapping({ localTaskId: task.id, workspaceId: connection.workspaceId,
      dataSourceId: taskSourceId, remotePageId: null,
      clientKey: notionClientKey(connection.installationId, task.id),
      rulePageId: rule.remotePageId, occurrenceKey: task.occurrenceKey,
      baseline: null, status: "pending_create", updatedAt: at });
    await store.enqueueNotionOutbox({ operationId: randomUUID(), localTaskId: task.id,
      workspaceId: connection.workspaceId, datasetEpoch: epoch,
      desired: notionTaskFieldsSchema.parse({ title: task.title,
        date: [task.startDate, task.endDate], completed: task.status === "completed" }),
      baseline: null, status: "pending", attemptCount: 0,
      createdAt: at, lastAttemptAt: null, confirmedAt: null });
    count += 1;
  }
  return count;
}

async function preserveMaterializedOccurrences(store: SQLitePlannerStore,
  logicalSeriesId: string): Promise<LocalDate | undefined> {
  let latest: LocalDate | undefined;
  for (const task of await store.listAllTasks()) {
    if (task.logicalSeriesId !== logicalSeriesId) continue;
    if (task.occurrenceDate && (!latest || task.occurrenceDate > latest)) latest = task.occurrenceDate;
    if (task.isSeriesException === false) {
      await store.putTask(taskSchema.parse({ ...task, isSeriesException: true }));
    }
  }
  return latest;
}
