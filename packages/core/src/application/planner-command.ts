import {
  focusRecordSchema,
  instantSchema,
  localDateSchema,
  recurrenceSeriesSchema,
  taskSchema,
  type FocusRecord,
  type LocalDate,
  type RecurrenceEnd,
  type RecurrencePattern,
  type RecurrenceSeries,
  type Task,
} from "../domain/planner-model";
import { shiftDate } from "../domain/planner-date";
import {
  recurrenceOccurrenceKey,
  recursOnDate,
} from "../domain/planner-recurrence";
import {
  materializeRecurrenceOccurrences,
  type EnsureRecurrenceOccurrencesInput,
} from "./recurrence-generation";
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

type RecurrenceMaterializationInput = Omit<
  EnsureRecurrenceOccurrencesInput,
  "now"
>;

export type StopRecurrenceImpact = {
  openOrdinaryTaskCount: number;
  focusRecordCount: number;
  preservedTaskCount: number;
  successorSegmentCount: number;
  revision: string;
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
        newSeriesId: string;
        title?: string;
        notes?: string;
        pattern?: RecurrencePattern;
        end?: RecurrenceEnd;
        effectiveDate?: string;
        materialization: RecurrenceMaterializationInput;
        now: string;
      };
    }
  | {
      type: "stopRecurrenceSeries";
      input: {
        seriesId: string;
        endDate: string;
        expectedImpact?: StopRecurrenceImpact;
        now: string;
      };
    };

export async function previewStopRecurrenceSeries(
  store: PlannerStore,
  input: { seriesId: string; endDate: string },
): Promise<StopRecurrenceImpact> {
  const endDate = localDateSchema.parse(input.endDate);

  return store.transaction(async () => {
    const tail = await loadLogicalTail(store, input.seriesId);
    validateDateWithinSegment(tail.source, endDate);
    if (tail.source.end.kind === "onDate" && tail.source.end.date < endDate) {
      throw new Error("停止重复不能延长已有截止日期");
    }

    return calculateStopRecurrenceImpact(store, tail, endDate);
  });
}

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

  return store.transaction(async () => {
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

    return didMutate ? publishUndoReceipt(store, undoChanges) : undefined;
  });
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
      const rescheduled = (input.startDate !== undefined && input.startDate !== task.startDate) ||
        (input.endDate !== undefined && input.endDate !== task.endDate);
      const updatedTask = taskSchema.parse({
        ...task, title: input.title ?? task.title, notes: input.notes ?? task.notes,
        startDate: input.startDate ?? task.startDate, endDate: input.endDate ?? task.endDate,
        isSeriesException: task.seriesId ? rescheduled || task.isSeriesException : undefined,
        updatedAt: input.now,
      });
      if (!rescheduled && updatedTask.title === task.title && updatedTask.notes === task.notes) return false;
      if (rescheduled) {
        captureTask(undoChanges, task);
        await captureAndDeleteTaskFocus(store, task.id, undoChanges);
      }
      await store.putTask(updatedTask);
      return true;
    }

    case "updateTaskDetails": {
      const input = command.input;
      instantSchema.parse(input.now);
      const task = await requireTask(store, input.taskId);
      const updatedTask = taskSchema.parse({
        ...task,
        title: input.title ?? task.title,
        notes: input.notes ?? task.notes,
        isSeriesException: task.seriesId ? true : undefined,
        updatedAt: input.now,
      });
      if (updatedTask.title === task.title && updatedTask.notes === task.notes) {
        return false;
      }

      if (captureDetailsForBatch) {
        captureTask(undoChanges, task);
      }

      await store.putTask(updatedTask);
      return true;
    }

    case "rescheduleTask": {
      const input = command.input;
      instantSchema.parse(input.now);
      const task = await requireTask(store, input.taskId);
      const updatedTask = taskSchema.parse({
        ...task,
        startDate: input.startDate,
        endDate: input.endDate,
        isSeriesException: task.seriesId ? true : undefined,
        updatedAt: input.now,
      });
      if (updatedTask.startDate === task.startDate && updatedTask.endDate === task.endDate) {
        return false;
      }
      captureTask(undoChanges, task);
      await captureAndDeleteTaskFocus(store, task.id, undoChanges);

      await store.putTask(updatedTask);
      return true;
    }

    case "completeTask": {
      const input = command.input;
      const now = instantSchema.parse(input.now);
      const completedOn = localDateSchema.parse(
        input.completedOn ?? input.asOfDate ?? now.slice(0, 10),
      );
      const task = await requireTask(store, input.taskId);
      if (task.status === "completed") return false;
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
      if (task.status === "open") return false;
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
      await captureTaskResourceLinks(store, task.id, undoChanges);

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
          logicalSeriesId: input.id,
          title: input.title,
          notes: input.notes ?? "",
          startDate: input.startDate,
          effectiveEndDate: null,
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
        logicalSeriesId: input.seriesId,
        title: input.title ?? task.title,
        notes: input.notes ?? task.notes,
        startDate: occurrenceDate,
        effectiveEndDate: null,
        pattern: input.pattern,
        end: input.end,
        excludedDates: [],
        createdAt: now,
        updatedAt: now,
      });
      if (!recursOnDate(series, occurrenceDate)) {
        throw new Error("重复规则必须包含任务的开始日期");
      }

      const occurrenceKey = recurrenceOccurrenceKey(
        series.logicalSeriesId,
        occurrenceDate,
      );
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
          logicalSeriesId: series.logicalSeriesId,
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
      const tail = await loadLogicalTail(store, input.seriesId);
      const effectiveDate = localDateSchema.parse(
        input.effectiveDate ?? tail.source.startDate,
      );

      validateDateWithinSegment(tail.source, effectiveDate);
      if (
        tail.successors.length === 0 &&
        tail.source.effectiveEndDate === null &&
        (input.title === undefined || input.title === tail.source.title) &&
        (input.notes === undefined || input.notes === tail.source.notes) &&
        (input.pattern === undefined ||
          recurrencePatternsEqual(input.pattern, tail.source.pattern)) &&
        (input.end === undefined || recurrenceEndsEqual(input.end, tail.source.end))
      ) {
        return false;
      }
      if (await store.getRecurrenceSeries(input.newSeriesId)) {
        throw new Error(`重复系列已存在：${input.newSeriesId}`);
      }

      const prefixExclusions = tail.source.excludedDates.filter(
        (date) => date < effectiveDate,
      );
      const tailExclusions = uniqueSortedDates([
        ...tail.source.excludedDates.filter((date) => date >= effectiveDate),
        ...tail.successors.flatMap((series) => series.excludedDates),
      ]);
      const logicalCreatedAt = tail.chain[0]?.createdAt ?? tail.source.createdAt;
      const replacement = recurrenceSeriesSchema.parse({
        id: input.newSeriesId,
        logicalSeriesId: tail.source.logicalSeriesId,
        title: input.title ?? tail.source.title,
        notes: input.notes ?? tail.source.notes,
        startDate: effectiveDate,
        effectiveEndDate: null,
        pattern: input.pattern ?? tail.source.pattern,
        end: input.end ?? tail.source.end,
        excludedDates: tailExclusions,
        createdAt: logicalCreatedAt,
        updatedAt: now,
      });

      captureRecurrenceSeries(undoChanges, tail.source);
      for (const successor of tail.successors) {
        captureRecurrenceSeries(undoChanges, successor);
      }
      captureMissingRecurrenceSeries(undoChanges, replacement.id);

      if (effectiveDate === tail.source.startDate) {
        await store.deleteRecurrenceSeries(tail.source.id);
      } else {
        await store.putRecurrenceSeries(
          recurrenceSeriesSchema.parse({
            ...tail.source,
            effectiveEndDate: shiftDate(effectiveDate, -1),
            excludedDates: prefixExclusions,
            updatedAt: now,
          }),
        );
      }
      for (const successor of tail.successors) {
        await store.deleteRecurrenceSeries(successor.id);
      }
      await store.putRecurrenceSeries(replacement);

      for (const occurrence of tail.tasks) {
        if (!occurrence.occurrenceDate || occurrence.occurrenceDate < effectiveDate) {
          continue;
        }

        captureTask(undoChanges, occurrence);
        if (occurrence.status === "completed" || occurrence.isSeriesException) {
          await store.putTask(
            taskSchema.parse({
              ...occurrence,
              seriesId: replacement.id,
              isSeriesException: true,
            }),
          );
          continue;
        }

        if (recursOnDate(replacement, occurrence.occurrenceDate)) {
          await store.putTask(
            taskSchema.parse({
              ...occurrence,
              title: replacement.title,
              notes: replacement.notes,
              startDate: occurrence.occurrenceDate,
              endDate: occurrence.occurrenceDate,
              seriesId: replacement.id,
              updatedAt: now,
            }),
          );
          continue;
        }

        if (occurrence.occurrenceDate === effectiveDate) {
          await store.putTask(
            taskSchema.parse({
              ...occurrence,
              title: replacement.title,
              notes: replacement.notes,
              seriesId: replacement.id,
              isSeriesException: true,
              updatedAt: now,
            }),
          );
          continue;
        }

        await captureAndDeleteTaskFocus(store, occurrence.id, undoChanges);
        await captureTaskResourceLinks(store, occurrence.id, undoChanges);
        await store.deleteTask(occurrence.id);
      }

      const created = await materializeRecurrenceOccurrences(
        store,
        [replacement],
        { ...input.materialization, now },
      );
      for (const task of created) {
        captureMissingTask(undoChanges, task.id);
      }
      return true;
    }

    case "stopRecurrenceSeries": {
      const input = command.input;
      const now = instantSchema.parse(input.now);
      const endDate = localDateSchema.parse(input.endDate);
      const tail = await loadLogicalTail(store, input.seriesId);

      validateDateWithinSegment(tail.source, endDate);
      if (tail.source.end.kind === "onDate" && tail.source.end.date < endDate) {
        throw new Error("停止重复不能延长已有截止日期");
      }
      if (input.expectedImpact) {
        const actualImpact = await calculateStopRecurrenceImpact(
          store,
          tail,
          endDate,
        );
        if (actualImpact.revision !== input.expectedImpact.revision) {
          throw new Error("停止范围已变化，请重新确认");
        }
      }

      captureRecurrenceSeries(undoChanges, tail.source);
      for (const successor of tail.successors) {
        captureRecurrenceSeries(undoChanges, successor);
      }

      const stoppedSeries = recurrenceSeriesSchema.parse({
        ...tail.source,
        effectiveEndDate: null,
        end: { kind: "onDate", date: endDate },
        excludedDates: uniqueSortedDates(
          tail.chain.flatMap((series) => series.excludedDates),
        ),
        updatedAt: now,
      });
      await store.putRecurrenceSeries(stoppedSeries);
      for (const successor of tail.successors) {
        await store.deleteRecurrenceSeries(successor.id);
      }

      for (const occurrence of tail.tasks) {
        if (!occurrence.occurrenceDate || occurrence.occurrenceDate <= endDate) {
          continue;
        }

        captureTask(undoChanges, occurrence);
        if (shouldRemoveAfterStop(occurrence, endDate)) {
          await captureAndDeleteTaskFocus(store, occurrence.id, undoChanges);
          await captureTaskResourceLinks(store, occurrence.id, undoChanges);
          await store.deleteTask(occurrence.id);
        } else {
          await store.putTask(
            taskSchema.parse({
              ...occurrence,
              seriesId: stoppedSeries.id,
              isSeriesException: true,
            }),
          );
        }
      }
      return true;
    }
  }
}

async function loadLogicalTail(store: PlannerStore, seriesId: string) {
  const source = await requireRecurrenceSeries(store, seriesId);
  const chain = await store.listRecurrenceSeriesByLogicalSeriesId(
    source.logicalSeriesId,
  );
  const sourceIndex = chain.findIndex((series) => series.id === source.id);

  if (sourceIndex < 0) {
    throw new Error(`重复系列谱系不完整：${source.logicalSeriesId}`);
  }

  const successors = chain.slice(sourceIndex + 1);
  const taskById = new Map<string, Task>();
  const taskLists = await Promise.all(
    [source, ...successors].map((segment) =>
      store.listTasksBySeries(segment.id),
    ),
  );
  for (const tasks of taskLists) {
    for (const task of tasks) {
      taskById.set(task.id, task);
    }
  }

  return {
    source,
    chain,
    successors,
    tasks: [...taskById.values()],
  };
}

async function calculateStopRecurrenceImpact(
  store: PlannerStore,
  tail: Awaited<ReturnType<typeof loadLogicalTail>>,
  endDate: LocalDate,
): Promise<StopRecurrenceImpact> {
  const affected = tail.tasks
    .filter(
      (task) =>
        task.occurrenceDate !== undefined && task.occurrenceDate > endDate,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const removable = affected.filter((task) =>
    shouldRemoveAfterStop(task, endDate),
  );
  const focusRecords = (
    await Promise.all(
      removable.map((task) => store.listFocusRecordsForTask(task.id)),
    )
  )
    .flat()
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    openOrdinaryTaskCount: removable.length,
    focusRecordCount: focusRecords.length,
    preservedTaskCount: affected.length - removable.length,
    successorSegmentCount: tail.successors.length,
    revision: JSON.stringify({
      endDate,
      series: [tail.source, ...tail.successors].map((series) => ({
        id: series.id,
        startDate: series.startDate,
        effectiveEndDate: series.effectiveEndDate,
        end: series.end,
        excludedDates: series.excludedDates,
        updatedAt: series.updatedAt,
      })),
      tasks: affected.map((task) => ({
        id: task.id,
        seriesId: task.seriesId,
        occurrenceDate: task.occurrenceDate,
        status: task.status,
        isSeriesException: task.isSeriesException,
        updatedAt: task.updatedAt,
      })),
      focusRecords: focusRecords.map((record) => ({
        id: record.id,
        date: record.date,
        taskId: record.taskId,
        focusedAt: record.focusedAt,
      })),
    }),
  };
}

function recurrencePatternsEqual(
  left: RecurrencePattern,
  right: RecurrencePattern,
) {
  if (left.kind !== right.kind) return false;

  switch (left.kind) {
    case "daily":
    case "weekdays":
      return true;
    case "weekly":
      return (
        right.kind === "weekly" &&
        left.weekdays.length === right.weekdays.length &&
        left.weekdays.every((day, index) => day === right.weekdays[index])
      );
    case "monthly":
      return right.kind === "monthly" && left.dayOfMonth === right.dayOfMonth;
  }
}

function recurrenceEndsEqual(left: RecurrenceEnd, right: RecurrenceEnd) {
  return (
    left.kind === right.kind &&
    (left.kind === "never" ||
      (right.kind === "onDate" && left.date === right.date))
  );
}

function validateDateWithinSegment(
  series: RecurrenceSeries,
  date: LocalDate,
) {
  if (
    date < series.startDate ||
    (series.effectiveEndDate !== null && date > series.effectiveEndDate)
  ) {
    throw new Error("生效日期不在当前重复规则段内");
  }
}

function shouldRemoveAfterStop(task: Task, endDate: LocalDate) {
  return (
    task.occurrenceDate !== undefined &&
    task.occurrenceDate > endDate &&
    task.status === "open" &&
    task.isSeriesException === false
  );
}

function uniqueSortedDates(dates: readonly string[]) {
  return [...new Set(dates)].sort();
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

async function captureTaskResourceLinks(
  store: PlannerStore,
  taskId: string,
  undoChanges: UndoChangeSet,
) {
  if (!store.listResourceTaskLinksForTask) return;
  for (const link of await store.listResourceTaskLinksForTask(taskId)) {
    if (!undoChanges.resourceTaskLinks.some((saved) =>
      saved.resourceId === link.resourceId && saved.taskId === link.taskId)) {
      undoChanges.resourceTaskLinks.push(link);
    }
  }
}

function captureTask(undoChanges: UndoChangeSet, task: Task) {
  if (!undoChanges.tasks.has(task.id)) {
    undoChanges.tasks.set(task.id, structuredClone(task));
  }
}

function captureMissingTask(undoChanges: UndoChangeSet, taskId: string) {
  if (!undoChanges.tasks.has(taskId)) {
    undoChanges.tasks.set(taskId, undefined);
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

function captureMissingRecurrenceSeries(
  undoChanges: UndoChangeSet,
  seriesId: string,
) {
  if (!undoChanges.recurrenceSeries.has(seriesId)) {
    undoChanges.recurrenceSeries.set(seriesId, undefined);
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
