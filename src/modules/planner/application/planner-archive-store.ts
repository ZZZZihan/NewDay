import type {
  PlannerPreferences,
  Task,
  TimeBlock,
} from "../domain/planner-model";
import type { PlannerStore } from "./planner-store";

export interface PlannerArchiveStore extends PlannerStore {
  listAllTasks(): Promise<Task[]>;
  listAllTimeBlocks(): Promise<TimeBlock[]>;
  getPreferences(): Promise<PlannerPreferences>;
  replaceAllData(data: {
    tasks: readonly Task[];
    timeBlocks: readonly TimeBlock[];
    preferences: PlannerPreferences;
  }): Promise<void>;
}
