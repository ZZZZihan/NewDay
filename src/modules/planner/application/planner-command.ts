import {
  focusRecordSchema,
  instantSchema,
  localDateSchema,
  recurrenceSeriesSchema,
  taskSchema,
  type FocusRecord,
  type RecurrenceEnd,
  type RecurrencePattern,
  type RecurrenceSeries,
  type Task,
} from "../domain/planner-model";
import {
  recurrenceOccurrenceKey,
  recursOnDate,
} from "../domain/planner-recurrence";
import type { PlannerStore } from "./planner-store";
import {
  createUndoChangeSet,
  publishUndoReceipt,
  type UndoChangeSet,
  type UndoReceipt,
} from "./planner-undo";

export type CreateTaskInput = {
  id: string;
  title: string;
  notes?: string;
  startDate: string;
  endDate: string;
  now: string;
};

export type CreateRecurrenceSeriesInput = {
  id: string;
  title: string;
  notes?: string;
  startDate: string;
  pattern: RecurrencePattern;
  end: RecurrenceEnd;
  excludedDates?: string[];
  now: string;
};

export type PlannerCommand =
  | { type: "createTask"; input: CreateTaskInput }
  | {
      /** @deprecated Use updateTaskDetails and rescheduleTask. */
      type: "updateTask";
      input: {
        taskId: string;
        title?: string;
        notes?: string;
        startDate?: string;
        endDate?: string;
        now: string;
      };
    }
  | {
      type: "updateTaskDetails";
      input: {
        taskId: string;
        title?: string;
        notes?: string;
        now: string;
      };
    }
  | {
      type: "rescheduleTask";
      input: {
        taskId: string;
        startDate: string;
        endDate: string;
        now: string;
      };
    }
  | {
      type: "completeTask" | "reopenTask";
      input: {
        taskId: string;
        now: string;
        completedOn?: string;
        asOfDate?: string;
      };
    }
  | {
      type: "deleteTask";
      input: { taskId: string; now?: string };
    }
  | {
      type: "setTodayFocus";
      input: { taskId: string; date: string; now: string };
    }
  | {
      type: "removeTodayFocus";
      input: { taskId: string; date: string };
    }
  | {
      type: "createRecurrenceSeries";
      input: CreateRecurrenceSeriesInput;
    }
  | {
      type: "createRecurrenceSeriesFromTask";
      input: {
        taskId: string;
        seriesId: string;
        title?: string;
        notes?: string;
        occurrenceDate?: string;
        pattern: RecurrencePattern;
        end: RecurrenceEnd;
        now: string;
      };
    }
  | {
      type: "updateRecurrenceSeries";
      input: {
        seriesId: string;
        title?: string;
        notes?: string;
        pattern?: RecurrencePattern;
        end?: RecurrenceEnd;
        effectiveDate?: string;
        now: string;
      };
    }
  | {
      type: "stopRecurrenceSeries";
      input: { seriesId: string; endDate: string; now: string };
    };

export async function executePlannerCommand(
  store: PlannerStore,
  command: PlannerCommand,
): Promise<UndoReceipt | undefined> {
  return executePlannerCommands(store, [command]);
}

export async function executePlannerCommands(
  store: PlannerStore,
  commands: readonly PlannerCommand[],
): Promise<UndoReceipt | undefined> {
  if (commands.length === 0) {
    return undefined;
  }

  const undoChanges = createUndoChangeSet();
  const detailsIncludedInReschedule = new Set(
    commands
      .filter((command) => command.type === "rescheduleTask")
      .map((command) => command.input.taskId),
  );

  const mutated = await store.transaction(async () => {
    let didMutate = false;

    for (const command of commands) {
      didMutate =
        (await applyPlannerCommand(
          store,
          command,
          undoChanges,
          command.type === "updateTaskDetails" &&
            detailsIncludedInReschedule.has(command.input.taskId),
        )) || didMutate;
    }

    return didMutate;
  });

  return mutated ? publishUndoReceipt(store, undoChanges) : undefined;
}

async function applyPlannerCommand(
  store: PlannerStore,
  command: PlannerCommand,
  undoChanges: UndoChangeSet,
  captureDetailsForBatch: boolean,
): Promise<boolean> {
  switch (command.type) {
    case "createTask": {
      const input = command.input;

      if (await store.getTask(input.id)) {
        throw new Error(`任务已存在：${input.id}`);
      }

      await store.putTask(
        taskSchema.parse({
          id: input.id,
          title: input.title,
          notes: input.notes ?? "",
          startDate: input.startDate,
          endDate: input.endDate,
          status: "open",
          createdAt: input.now,
          updatedAt: input.now,
          completedAt: null,
          completedOn: null,
        }),
      );
      return true;
    }

    case "updateTask": {
      const input = command.input;
      instantSchema.parse(input.now);
      const task = await requireTask(store, input.taskId);
      const rescheduled = input.startDate !== undefined || input.endDate !== undefined;

      if (rescheduled) {
        captureTask(undoChanges, task);
        await captureAndDeleteTaskFocus(store, task.id, undoChanges);
      }

      await store.putTask(
        taskSchema.parse({
          ...task,
          title: input.title ?? task.title,
          notes: input.notes ?? task.notes,
          startDate: input.startDate ?? task.startDate,
          endDate: input.endDate ?? task.endDate,
          isSeriesException: task.seriesId ? rescheduled || task.isSeriesException : undefined,
          updatedAt: input.now,
        }),
      );
      return true;
    }

    case "updateTaskDetails": {
      const input = command.input;
      instantSchema.parse(input.now);
      const task = await requireTask(store, input.taskId);

      if (captureDetailsForBatch) {
        captureTask(undoChanges, task);
      }

      await store.putTask(
        taskSchema.parse({
          ...task,
          title: input.title ?? task.title,
          notes: input.notes ?? task.notes,
          isSeriesException: task.seriesId ? true : undefined,
          updatedAt: input.now,
        }),
      );
      return true;
    }

    case "rescheduleTask": {
      const input = command.input;
      instantSchema.parse(input.now);
      const task = await requireTask(store, input.taskId);
      captureTask(undoChanges, task);
      await captureAndDeleteTaskFocus(store, task.id, undoChanges);

      await store.putTask(
        taskSchema.parse({
          ...task,
          startDate: input.startDate,
          endDate: input.endDate,
          isSeriesException: task.seriesId ? true : undefined,
          updatedAt: input.now,
        }),
      );
      return true;
    }

    case "completeTask": {
      const input = command.input;
      const now = instantSchema.parse(input.now);
      const completedOn = localDateSchema.parse(
        input.completedOn ?? input.asOfDate ?? now.slice(0, 10),
      );
      const task = await requireTask(store, input.taskId);
      captureTask(undoChanges, task);
      await captureAndDeleteTaskFocus(store, task.id, undoChanges);

      await store.putTask(
        taskSchema.parse({
          ...task,
          status: "completed",
          completedAt: now,
          completedOn,
          updatedAt: now,
        }),
      );
      return true;
    }

    case "reopenTask": {
      const input = command.input;
      const now = instantSchema.parse(input.now);
      const task = await requireTask(store, input.taskId);
      captureTask(undoChanges, task);

      await store.putTask(
        taskSchema.parse({
          ...task,
          status: "open",
          completedAt: null,
          completedOn: null,
          updatedAt: now,
        }),
      );
      return true;
    }

    case "deleteTask": {
      const input = command.input;
      if (input.now !== undefined) {
        instantSchema.parse(input.now);
      }
      const task = await requireTask(store, input.taskId);
      captureTask(undoChanges, task);
      await captureAndDeleteTaskFocus(store, task.id, undoChanges);

      if (task.seriesId && task.occurrenceDate) {
        const series = await requireRecurrenceSeries(store, task.seriesId);
        captureRecurrenceSeries(undoChanges, series);
        await store.putRecurrenceSeries(
          recurrenceSeriesSchema.parse({
            ...series,
            excludedDates: [...new Set([...series.excludedDates, task.occurrenceDate])].sort(),
            updatedAt: input.now ?? series.updatedAt,
          }),
        );
      }

      await store.deleteTask(task.id);
      return true;
    }

    case "setTodayFocus": {
      const input = command.input;
      const date = localDateSchema.parse(input.date);
      const focusedAt = instantSchema.parse(input.now);
      const task = await requireTask(store, input.taskId);

      if (task.status !== "open") {
        throw new Error("只有未完成任务可以设为今日重点");
      }

      if (task.startDate > date) {
        throw new Error("任务在该日期不可见");
      }

      const taskFocus = await store.listFocusRecordsForTask(task.id);
      if (taskFocus.some((record) => record.date === date)) {
        return false;
      }

      const dateFocus = await store.listFocusRecordsForDate(date);
      if (dateFocus.length >= 3) {
        throw new Error("今日重点最多 3 项");
      }

      await store.putFocusRecord(
        focusRecordSchema.parse({
          id: `focus:${date}:${task.id}`,
          date,
          taskId: task.id,
          focusedAt,
        }),
      );
      return true;
    }

    case "removeTodayFocus": {
      const input = command.input;
      const date = localDateSchema.parse(input.date);
      const records = await store.listFocusRecordsForTask(input.taskId);
      const matching = records.filter((record) => record.date === date);

      for (const record of matching) {
        await store.deleteFocusRecord(record.id);
      }
      return matching.length > 0;
    }

    case "createRecurrenceSeries": {
      const input = command.input;
      if (await store.getRecurrenceSeries(input.id)) {
        throw new Error(`重复系列已存在：${input.id}`);
      }

      await store.putRecurrenceSeries(
        recurrenceSeriesSchema.parse({
          id: input.id,
          title: input.title,
          notes: input.notes ?? "",
          startDate: input.startDate,
          pattern: input.pattern,
          end: input.end,
          excludedDates: input.excludedDates ?? [],
          createdAt: input.now,
          updatedAt: input.now,
        }),
      );
      return true;
    }

    case "createRecurrenceSeriesFromTask": {
      const input = command.input;
      const now = instantSchema.parse(input.now);
      const task = await requireTask(store, input.taskId);

      if (task.startDate !== task.endDate) {
        throw new Error("只有单日任务可以设为重复任务");
      }
      if (task.seriesId) {
        throw new Error("任务已经属于重复系列");
      }
      if (await store.getRecurrenceSeries(input.seriesId)) {
        throw new Error(`重复系列已存在：${input.seriesId}`);
      }

      const occurrenceDate = localDateSchema.parse(
        input.occurrenceDate ?? task.startDate,
      );
      const series = recurrenceSeriesSchema.parse({
        id: input.seriesId,
        title: input.title ?? task.title,
        notes: input.notes ?? task.notes,
        startDate: occurrenceDate,
        pattern: input.pattern,
        end: input.end,
        excludedDates: [],
        createdAt: now,
        updatedAt: now,
      });
      if (!recursOnDate(series, occurrenceDate)) {
        throw new Error("重复规则必须包含任务的开始日期");
      }

      const occurrenceKey = recurrenceOccurrenceKey(series.id, occurrenceDate);
      if (await store.getTaskByOccurrenceKey(occurrenceKey)) {
        throw new Error(`重复任务实例已存在：${occurrenceKey}`);
      }

      if (occurrenceDate !== task.startDate) {
        await deleteTaskFocus(store, task.id);
      }
      await store.putRecurrenceSeries(series);
      await store.putTask(
        taskSchema.parse({
          ...task,
          title: series.title,
          notes: series.notes,
          startDate: occurrenceDate,
          endDate: occurrenceDate,
          seriesId: series.id,
          occurrenceDate,
          occurrenceKey,
          isSeriesException: false,
          updatedAt: now,
        }),
      );
      return true;
    }

    case "updateRecurrenceSeries": {
      const input = command.input;
      const now = instantSchema.parse(input.now);
      const series = await requireRecurrenceSeries(store, input.seriesId);
      const effectiveDate = localDateSchema.parse(
        input.effectiveDate ?? series.startDate,
      );
      const updatedSeries = recurrenceSeriesSchema.parse({
        ...series,
        title: input.title ?? series.title,
        notes: input.notes ?? series.notes,
        pattern: input.pattern ?? series.pattern,
        end: input.end ?? series.end,
        updatedAt: now,
      });

      await store.putRecurrenceSeries(updatedSeries);
      await reconcileSeriesOccurrences(store, updatedSeries, effectiveDate, now);
      return true;
    }

    case "stopRecurrenceSeries": {
      const input = command.input;
      const now = instantSchema.parse(input.now);
      const endDate = localDateSchema.parse(input.endDate);
      const series = await requireRecurrenceSeries(store, input.seriesId);
      const stoppedSeries = recurrenceSeriesSchema.parse({
        ...series,
        end: { kind: "onDate", date: endDate },
        updatedAt: now,
      });

      await store.putRecurrenceSeries(stoppedSeries);
      const occurrences = await store.listTasksBySeries(series.id);
      for (const occurrence of occurrences) {
        if (
          occurrence.occurrenceDate &&
          occurrence.occurrenceDate > endDate &&
          occurrence.status === "open" &&
          occurrence.isSeriesException === false
        ) {
          await deleteTaskFocus(store, occurrence.id);
          await store.deleteTask(occurrence.id);
        }
      }
      return true;
    }
  }
}

async function reconcileSeriesOccurrences(
  store: PlannerStore,
  series: RecurrenceSeries,
  effectiveDate: string,
  now: string,
) {
  const occurrences = await store.listTasksBySeries(series.id);

  for (const occurrence of occurrences) {
    if (
      !occurrence.occurrenceDate ||
      occurrence.occurrenceDate < effectiveDate ||
      occurrence.status === "completed" ||
      occurrence.isSeriesException
    ) {
      continue;
    }

    if (!recursOnDate(series, occurrence.occurrenceDate)) {
      await deleteTaskFocus(store, occurrence.id);
      await store.deleteTask(occurrence.id);
      continue;
    }

    await store.putTask(
      taskSchema.parse({
        ...occurrence,
        title: series.title,
        notes: series.notes,
        updatedAt: now,
      }),
    );
  }
}

async function deleteTaskFocus(store: PlannerStore, taskId: string) {
  const records = await store.listFocusRecordsForTask(taskId);
  for (const record of records) {
    await store.deleteFocusRecord(record.id);
  }
}

async function captureAndDeleteTaskFocus(
  store: PlannerStore,
  taskId: string,
  undoChanges: UndoChangeSet,
) {
  const records = await store.listFocusRecordsForTask(taskId);

  for (const record of records) {
    captureFocusRecord(undoChanges, record);
    await store.deleteFocusRecord(record.id);
  }
}

function captureTask(undoChanges: UndoChangeSet, task: Task) {
  if (!undoChanges.tasks.has(task.id)) {
    undoChanges.tasks.set(task.id, structuredClone(task));
  }
}

function captureRecurrenceSeries(
  undoChanges: UndoChangeSet,
  series: RecurrenceSeries,
) {
  if (!undoChanges.recurrenceSeries.has(series.id)) {
    undoChanges.recurrenceSeries.set(series.id, structuredClone(series));
  }
}

function captureFocusRecord(
  undoChanges: UndoChangeSet,
  record: FocusRecord,
) {
  if (!undoChanges.focusRecords.has(record.id)) {
    undoChanges.focusRecords.set(record.id, structuredClone(record));
  }
}

async function requireTask(store: PlannerStore, id: string) {
  const task = await store.getTask(id);

  if (!task) {
    throw new Error(`任务不存在：${id}`);
  }

  return task;
}

async function requireRecurrenceSeries(store: PlannerStore, id: string) {
  const series = await store.getRecurrenceSeries(id);

  if (!series) {
    throw new Error(`重复系列不存在：${id}`);
  }

  return series;
}
