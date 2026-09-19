import {
  instantSchema,
  localDateSchema,
  taskSchema,
  type LocalDate,
  type RecurrenceSeries,
  type Task,
} from "../domain/planner-model";
import {
  recurrenceDatesInRange,
  recurrenceOccurrenceKey,
  recursOnDate,
} from "../domain/planner-recurrence";
import type { PlannerStore } from "./planner-store";

export type EnsureRecurrenceOccurrencesInput = {
  asOfDate: LocalDate;
  throughDate: LocalDate;
  additionallyEnsureDate?: LocalDate;
  now: string;
};

export async function ensureRecurrenceOccurrences(
  store: PlannerStore,
  input: EnsureRecurrenceOccurrencesInput,
): Promise<Task[]> {
  const parsed = parseGenerationInput(input);

  return store.transaction(async () =>
    materializeRecurrenceOccurrences(
      store,
      await store.listAllRecurrenceSeries(),
      parsed,
    ),
  );
}

export async function materializeRecurrenceOccurrences(
  store: PlannerStore,
  seriesList: readonly RecurrenceSeries[],
  input: EnsureRecurrenceOccurrencesInput,
): Promise<Task[]> {
  const parsed = parseGenerationInput(input);
  const created: Task[] = [];

  for (const series of seriesList) {
    const dates = new Set(
      recurrenceDatesInRange(series, parsed.asOfDate, parsed.throughDate),
    );

    if (
      parsed.additionallyEnsureDate !== undefined &&
      parsed.additionallyEnsureDate >= parsed.asOfDate &&
      recursOnDate(series, parsed.additionallyEnsureDate)
    ) {
      dates.add(parsed.additionallyEnsureDate);
    }

    for (const occurrenceDate of [...dates].sort()) {
      const occurrenceKey = recurrenceOccurrenceKey(
        series.logicalSeriesId,
        occurrenceDate,
      );

      if (await store.getTaskByOccurrenceKey(occurrenceKey)) {
        continue;
      }

      const id = occurrenceKey;
      const taskWithSameId = await store.getTask(id);
      if (taskWithSameId) {
        throw new Error(`重复任务实例 ID 冲突：${id}`);
      }

      const occurrence = taskSchema.parse({
        id,
        title: series.title,
        notes: series.notes,
        startDate: occurrenceDate,
        endDate: occurrenceDate,
        status: "open",
        createdAt: parsed.now,
        updatedAt: parsed.now,
        completedAt: null,
        completedOn: null,
        seriesId: series.id,
        logicalSeriesId: series.logicalSeriesId,
        occurrenceDate,
        occurrenceKey,
        isSeriesException: false,
      });

      await store.putTask(occurrence);
      created.push(occurrence);
    }
  }

  return created;
}

function parseGenerationInput(
  input: EnsureRecurrenceOccurrencesInput,
): EnsureRecurrenceOccurrencesInput {
  const asOfDate = localDateSchema.parse(input.asOfDate);
  const throughDate = localDateSchema.parse(input.throughDate);
  const additionallyEnsureDate =
    input.additionallyEnsureDate === undefined
      ? undefined
      : localDateSchema.parse(input.additionallyEnsureDate);
  const now = instantSchema.parse(input.now);

  if (throughDate < asOfDate) {
    throw new Error("重复任务生成结束日期不能早于开始日期");
  }

  return { asOfDate, throughDate, additionallyEnsureDate, now };
}
