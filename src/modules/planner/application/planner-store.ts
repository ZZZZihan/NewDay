import type { Task, TimeBlock } from "../domain/planner-model";

export interface PlannerStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  getTask(id: string): Promise<Task | undefined>;
  getTimeBlock(id: string): Promise<TimeBlock | undefined>;
  putTask(task: Task): Promise<void>;
  putTimeBlock(timeBlock: TimeBlock): Promise<void>;
  deleteTask(id: string): Promise<void>;
  deleteTimeBlock(id: string): Promise<void>;
  deleteTimeBlocksForTask(taskId: string): Promise<void>;
  listTasksForDate(date: string): Promise<Task[]>;
  listTimeBlocksForDate(date: string): Promise<TimeBlock[]>;
}
