import {
  localDateSchema,
  type DayPlan,
  type DayPlanItem,
  type FocusRecord,
  type LocalDate,
  type Task,
} from "../domain/planner-model";
import type { PlannerStore } from "./planner-store";

type DayPlanInput = {
  selectedDate: LocalDate;
  asOfDate: LocalDate;
};

export async function getDayPlan(
  store: PlannerStore,
  input: DayPlanInput,
): Promise<DayPlan> {
  const selectedDate = localDateSchema.parse(input.selectedDate);
  const asOfDate = localDateSchema.parse(input.asOfDate);
  const isToday = selectedDate === asOfDate;
  const tasks = await store.listAllTasks();
  const scheduledTasks = tasks.filter(
    (task) => task.startDate <= selectedDate && task.endDate >= selectedDate,
  );
  const overdueTasks = isToday
    ? tasks.filter(
        (task) => task.status === "open" && task.endDate < asOfDate,
      )
    : [];
  const completedCarryThrough = isToday
    ? tasks.filter(
        (task) =>
          task.status === "completed" &&
          task.completedOn === asOfDate &&
          task.endDate < asOfDate,
      )
    : [];
  const visibleOpenTasks = uniqueTasks([
    ...scheduledTasks.filter((task) => task.status === "open"),
    ...overdueTasks,
  ]);
  const visibleOpenIds = new Set(visibleOpenTasks.map((task) => task.id));
  const focusRecords = isToday
    ? await store.listFocusRecordsForDate(asOfDate)
    : [];
  const focused = focusedItems(focusRecords, tasks, visibleOpenIds, asOfDate);
  const focusedIds = new Set(focused.map(({ task }) => task.id));
  const overdue = overdueTasks
    .filter((task) => !focusedIds.has(task.id))
    .map((task) => ({ task, isOverdue: true }))
    .sort(compareOverdueItems);
  const open = scheduledTasks
    .filter(
      (task) => task.status === "open" && !focusedIds.has(task.id),
    )
    .map((task) => ({ task, isOverdue: false }))
    .sort(compareOpenItems);
  const completed = uniqueTasks([
    ...scheduledTasks.filter((task) => task.status === "completed"),
    ...completedCarryThrough,
  ])
    .map((task) => ({ task, isOverdue: task.endDate < asOfDate }))
    .sort(compareCompletedItems);

  return {
    selectedDate,
    asOfDate,
    isToday,
    focus: focused,
    overdue,
    open,
    completed,
    counts: {
      open: focused.length + overdue.length + open.length,
      completed: completed.length,
      overdue: focused.filter((item) => item.isOverdue).length + overdue.length,
      focus: focused.length,
    },
  };
}

function focusedItems(
  records: FocusRecord[],
  tasks: Task[],
  visibleOpenIds: Set<string>,
  asOfDate: LocalDate,
): DayPlanItem[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  return [...records]
    .sort(
      (left, right) =>
        new Date(left.focusedAt).getTime() -
          new Date(right.focusedAt).getTime() || left.taskId.localeCompare(right.taskId),
    )
    .flatMap((record) => {
      const task = taskById.get(record.taskId);

      if (!task || task.status !== "open" || !visibleOpenIds.has(task.id)) {
        return [];
      }

      return [{ task, isOverdue: task.endDate < asOfDate }];
    });
}

function uniqueTasks(tasks: Task[]) {
  return [...new Map(tasks.map((task) => [task.id, task])).values()];
}

function compareOverdueItems(left: DayPlanItem, right: DayPlanItem) {
  return (
    left.task.endDate.localeCompare(right.task.endDate) ||
    compareCreatedTasks(left.task, right.task)
  );
}

function compareOpenItems(left: DayPlanItem, right: DayPlanItem) {
  return (
    left.task.endDate.localeCompare(right.task.endDate) ||
    left.task.startDate.localeCompare(right.task.startDate) ||
    compareCreatedTasks(left.task, right.task)
  );
}

function compareCompletedItems(left: DayPlanItem, right: DayPlanItem) {
  const leftCompleted = left.task.completedAt ?? left.task.updatedAt;
  const rightCompleted = right.task.completedAt ?? right.task.updatedAt;

  return (
    new Date(rightCompleted).getTime() - new Date(leftCompleted).getTime() ||
    compareCreatedTasks(left.task, right.task)
  );
}

function compareCreatedTasks(left: Task, right: Task) {
  return (
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
    left.id.localeCompare(right.id)
  );
}
