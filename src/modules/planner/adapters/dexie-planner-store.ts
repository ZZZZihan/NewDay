import Dexie, { type Table } from "dexie";

import type {
  PlannerArchiveData,
  PlannerArchiveStore,
} from "../application/planner-archive-store";
import type {
  FocusRecord,
  RecurrenceSeries,
  Task,
} from "../domain/planner-model";

type LegacyTaskRecord = {
  plannedDate?: string;
  estimatedMinutes?: number | null;
  startDate?: string;
  endDate?: string;
  completedOn?: string | null;
};

class NewDayDatabase extends Dexie {
  tasks!: Table<Task, string>;
  recurrenceSeries!: Table<RecurrenceSeries, string>;
  focusRecords!: Table<FocusRecord, string>;

  constructor(name: string) {
    super(name);

    this.version(1).stores({
      tasks: "id, plannedDate, status, updatedAt",
      timeBlocks: "id, taskId, date, start, updatedAt",
    });

    this.version(2).stores({
      tasks: "id, plannedDate, status, updatedAt",
      timeBlocks: "id, taskId, date, start, updatedAt",
      preferences: "id",
    });

    this.version(3)
      .stores({
        tasks: "id, startDate, endDate, status, updatedAt",
        timeBlocks: null,
        preferences: null,
      })
      .upgrade(async (transaction) => {
        await transaction
          .table<LegacyTaskRecord, string>("tasks")
          .toCollection()
          .modify((task) => {
            const fallbackDate = task.startDate ?? task.plannedDate;

            if (!fallbackDate) {
              throw new Error("旧任务缺少所属日期，无法迁移");
            }

            task.startDate = fallbackDate;
            task.endDate = task.endDate ?? fallbackDate;
            delete task.plannedDate;
            delete task.estimatedMinutes;
          });
      });

    this.version(4)
      .stores({
        tasks:
          "id, startDate, endDate, status, completedOn, updatedAt, seriesId, occurrenceDate, &occurrenceKey",
        recurrenceSeries: "id, startDate, updatedAt",
        focusRecords: "id, date, taskId, focusedAt, &[date+taskId]",
      })
      .upgrade(async (transaction) => {
        await transaction
          .table<LegacyTaskRecord, string>("tasks")
          .toCollection()
          .modify((task) => {
            task.completedOn = null;
          });
      });
  }
}

export class DexiePlannerStore implements PlannerArchiveStore {
  private readonly database: NewDayDatabase;

  constructor(public readonly databaseName = "newday") {
    this.database = new NewDayDatabase(databaseName);
  }

  static async deleteDatabase(databaseName: string) {
    await Dexie.delete(databaseName);
  }

  close() {
    this.database.close();
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.database.transaction(
      "rw",
      this.database.tasks,
      this.database.recurrenceSeries,
      this.database.focusRecords,
      operation,
    );
  }

  async getTask(id: string) {
    return this.database.tasks.get(id);
  }

  async getTaskByOccurrenceKey(occurrenceKey: string) {
    return this.database.tasks
      .where("occurrenceKey")
      .equals(occurrenceKey)
      .first();
  }

  async putTask(task: Task) {
    await this.database.tasks.put(task);
  }

  async deleteTask(id: string) {
    await this.database.tasks.delete(id);
  }

  async listAllTasks() {
    return this.database.tasks.toArray();
  }

  async listTasksBySeries(seriesId: string) {
    return this.database.tasks.where("seriesId").equals(seriesId).toArray();
  }

  async getRecurrenceSeries(id: string) {
    return this.database.recurrenceSeries.get(id);
  }

  async putRecurrenceSeries(series: RecurrenceSeries) {
    await this.database.recurrenceSeries.put(series);
  }

  async deleteRecurrenceSeries(id: string) {
    await this.database.recurrenceSeries.delete(id);
  }

  async listAllRecurrenceSeries() {
    return this.database.recurrenceSeries.toArray();
  }

  async getFocusRecord(id: string) {
    return this.database.focusRecords.get(id);
  }

  async putFocusRecord(record: FocusRecord) {
    await this.database.focusRecords.put(record);
  }

  async deleteFocusRecord(id: string) {
    await this.database.focusRecords.delete(id);
  }

  async listFocusRecordsForDate(date: string) {
    return this.database.focusRecords.where("date").equals(date).toArray();
  }

  async listFocusRecordsForTask(taskId: string) {
    return this.database.focusRecords.where("taskId").equals(taskId).toArray();
  }

  async listAllFocusRecords() {
    return this.database.focusRecords.toArray();
  }

  async replaceAllData(data: PlannerArchiveData) {
    await this.database.transaction(
      "rw",
      this.database.tasks,
      this.database.recurrenceSeries,
      this.database.focusRecords,
      async () => {
        await Promise.all([
          this.database.tasks.clear(),
          this.database.recurrenceSeries.clear(),
          this.database.focusRecords.clear(),
        ]);
        await this.database.tasks.bulkAdd([...data.tasks]);
        await this.database.recurrenceSeries.bulkAdd([
          ...(data.recurrenceSeries ?? []),
        ]);
        await this.database.focusRecords.bulkAdd([...(data.focusRecords ?? [])]);
      },
    );
  }

}
