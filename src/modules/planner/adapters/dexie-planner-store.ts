import Dexie, { type Table } from "dexie";

import { getDayPlan } from "../application/day-plan";
import type { PlannerArchiveStore } from "../application/planner-archive-store";
import {
  DEFAULT_PLANNER_PREFERENCES,
  type DayPlan,
  type PlannerPreferences,
  type Task,
  type TimeBlock,
} from "../domain/planner-model";

class NewDayDatabase extends Dexie {
  tasks!: Table<Task, string>;
  timeBlocks!: Table<TimeBlock, string>;
  preferences!: Table<PlannerPreferences, string>;

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
      this.database.timeBlocks,
      this.database.preferences,
      operation,
    );
  }

  async getTask(id: string) {
    return this.database.tasks.get(id);
  }

  async getTimeBlock(id: string) {
    return this.database.timeBlocks.get(id);
  }

  async putTask(task: Task) {
    await this.database.tasks.put(task);
  }

  async putTimeBlock(timeBlock: TimeBlock) {
    await this.database.timeBlocks.put(timeBlock);
  }

  async deleteTask(id: string) {
    await this.database.tasks.delete(id);
  }

  async deleteTimeBlock(id: string) {
    await this.database.timeBlocks.delete(id);
  }

  async deleteTimeBlocksForTask(taskId: string) {
    await this.database.timeBlocks.where("taskId").equals(taskId).delete();
  }

  async listTasksForDate(date: string) {
    return this.database.tasks.where("plannedDate").equals(date).toArray();
  }

  async listTimeBlocksForDate(date: string) {
    return this.database.timeBlocks.where("date").equals(date).toArray();
  }

  async listAllTasks() {
    return this.database.tasks.toArray();
  }

  async listAllTimeBlocks() {
    return this.database.timeBlocks.toArray();
  }

  async getPreferences() {
    const stored = await this.database.preferences.get("default");

    if (stored) {
      return stored;
    }

    return {
      ...DEFAULT_PLANNER_PREFERENCES,
      timeZone:
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        DEFAULT_PLANNER_PREFERENCES.timeZone,
    };
  }

  async replaceAllData(data: {
    tasks: readonly Task[];
    timeBlocks: readonly TimeBlock[];
    preferences: PlannerPreferences;
  }) {
    await this.database.transaction(
      "rw",
      this.database.tasks,
      this.database.timeBlocks,
      this.database.preferences,
      async () => {
        await Promise.all([
          this.database.tasks.clear(),
          this.database.timeBlocks.clear(),
          this.database.preferences.clear(),
        ]);
        await this.database.tasks.bulkAdd([...data.tasks]);
        await this.database.timeBlocks.bulkAdd([...data.timeBlocks]);
        await this.database.preferences.put(data.preferences);
      },
    );
  }

  async getDayPlan(date: string): Promise<DayPlan> {
    return getDayPlan(this, date);
  }
}
