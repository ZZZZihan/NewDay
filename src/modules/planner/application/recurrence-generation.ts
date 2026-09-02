import {
  instantSchema,
  localDateSchema,
  taskSchema,
  type LocalDate,
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

  return store.transaction(async () => {
    const created: Task[] = [];
    const seriesList = await store.listAllRecurrenceSeries();

    for (const series of seriesList) {
      const dates = new Set(
        recurrenceDatesInRange(series, asOfDate, throughDate),
      );

      if (
        additionallyEnsureDate !== undefined &&
        additionallyEnsureDate >= asOfDate &&
        recursOnDate(series, additionallyEnsureDate)
      ) {
        dates.add(additionallyEnsureDate);
      }

      for (const occurrenceDate of [...dates].sort()) {
        const occurrenceKey = recurrenceOccurrenceKey(series.id, occurrenceDate);

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
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          completedOn: null,
          seriesId: series.id,
          occurrenceDate,
          occurrenceKey,
          isSeriesException: false,
        });

        await store.putTask(occurrence);
        created.push(occurrence);
      }
    }

    return created;
  });
}
