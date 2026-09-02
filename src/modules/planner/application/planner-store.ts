import type {
  FocusRecord,
  RecurrenceSeries,
  Task,
} from "../domain/planner-model";

export interface PlannerStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;

  getTask(id: string): Promise<Task | undefined>;
  getTaskByOccurrenceKey(occurrenceKey: string): Promise<Task | undefined>;
  putTask(task: Task): Promise<void>;
  deleteTask(id: string): Promise<void>;
  listAllTasks(): Promise<Task[]>;
  listTasksBySeries(seriesId: string): Promise<Task[]>;

  getRecurrenceSeries(id: string): Promise<RecurrenceSeries | undefined>;
  putRecurrenceSeries(series: RecurrenceSeries): Promise<void>;
  deleteRecurrenceSeries(id: string): Promise<void>;
  listAllRecurrenceSeries(): Promise<RecurrenceSeries[]>;

  getFocusRecord(id: string): Promise<FocusRecord | undefined>;
  putFocusRecord(record: FocusRecord): Promise<void>;
  deleteFocusRecord(id: string): Promise<void>;
  listFocusRecordsForDate(date: string): Promise<FocusRecord[]>;
  listFocusRecordsForTask(taskId: string): Promise<FocusRecord[]>;
  listAllFocusRecords(): Promise<FocusRecord[]>;
}
