import type { DayPlan } from "../domain/planner-model";
import { findOverlappingBlockIds } from "../domain/time-block";
import type { PlannerStore } from "./planner-store";

export async function getDayPlan(
  store: PlannerStore,
  date: string,
): Promise<DayPlan> {
  const [tasks, blocksForDate] = await Promise.all([
    store.listTasksForDate(date),
    store.listTimeBlocksForDate(date),
  ]);
  const sortedTasks = [...tasks].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
      left.id.localeCompare(right.id),
  );
  const taskIds = new Set(sortedTasks.map((task) => task.id));
  const timeBlocks = blocksForDate
    .filter((block) => taskIds.has(block.taskId))
    .sort(
      (left, right) =>
        new Date(left.start).getTime() - new Date(right.start).getTime() ||
        left.id.localeCompare(right.id),
    );

  return {
    date,
    tasks: sortedTasks,
    timeBlocks,
    conflictingTimeBlockIds: findOverlappingBlockIds(
      timeBlocks.map((block) => ({
        id: block.id,
        start: new Date(block.start),
        end: new Date(block.end),
      })),
    ),
  };
}
