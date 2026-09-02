import type {
  FocusRecord,
  RecurrenceSeries,
  Task,
} from "../domain/planner-model";
import type { PlannerStore } from "./planner-store";

export type PlannerArchiveData = {
  tasks: readonly Task[];
  recurrenceSeries?: readonly RecurrenceSeries[];
  focusRecords?: readonly FocusRecord[];
};

export interface PlannerArchiveStore extends PlannerStore {
  replaceAllData(data: PlannerArchiveData): Promise<void>;
}
