import { getDayPlan } from "../application/day-plan";
import type { PlannerArchiveStore } from "../application/planner-archive-store";
import {
  DEFAULT_PLANNER_PREFERENCES,
  type DayPlan,
  type PlannerPreferences,
  type Task,
  type TimeBlock,
} from "../domain/planner-model";

export class MemoryPlannerStore implements PlannerArchiveStore {
  private tasks = new Map<string, Task>();
  private timeBlocks = new Map<string, TimeBlock>();
  private preferences: PlannerPreferences = structuredClone(
    DEFAULT_PLANNER_PREFERENCES,
  );

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const tasksSnapshot = new Map(this.tasks);
    const timeBlocksSnapshot = new Map(this.timeBlocks);
    const preferencesSnapshot = structuredClone(this.preferences);

    try {
      return await operation();
    } catch (error) {
      this.tasks = tasksSnapshot;
      this.timeBlocks = timeBlocksSnapshot;
      this.preferences = preferencesSnapshot;
      throw error;
    }
  }

  async getTask(id: string) {
    return clone(this.tasks.get(id));
  }

  async getTimeBlock(id: string) {
    return clone(this.timeBlocks.get(id));
  }

  async putTask(task: Task) {
    this.tasks.set(task.id, structuredClone(task));
  }

  async putTimeBlock(timeBlock: TimeBlock) {
    this.timeBlocks.set(timeBlock.id, structuredClone(timeBlock));
  }

  async deleteTask(id: string) {
    this.tasks.delete(id);
  }

  async deleteTimeBlock(id: string) {
    this.timeBlocks.delete(id);
  }

  async deleteTimeBlocksForTask(taskId: string) {
    for (const [id, block] of this.timeBlocks) {
      if (block.taskId === taskId) {
        this.timeBlocks.delete(id);
      }
    }
  }

  async listTasksForDate(date: string) {
    return [...this.tasks.values()]
      .filter((task) => task.plannedDate === date)
      .map((task) => structuredClone(task));
  }

  async listTimeBlocksForDate(date: string) {
    return [...this.timeBlocks.values()]
      .filter((block) => block.date === date)
      .map((block) => structuredClone(block));
  }

  async listAllTasks() {
    return [...this.tasks.values()].map((task) => structuredClone(task));
  }

  async listAllTimeBlocks() {
    return [...this.timeBlocks.values()].map((block) => structuredClone(block));
  }

  async getPreferences() {
    return structuredClone(this.preferences);
  }

  async replaceAllData(data: {
    tasks: readonly Task[];
    timeBlocks: readonly TimeBlock[];
    preferences: PlannerPreferences;
  }) {
    await this.transaction(async () => {
      this.tasks = new Map(
        data.tasks.map((task) => [task.id, structuredClone(task)]),
      );
      this.timeBlocks = new Map(
        data.timeBlocks.map((block) => [block.id, structuredClone(block)]),
      );
      this.preferences = structuredClone(data.preferences);
    });
  }

  async getDayPlan(date: string): Promise<DayPlan> {
    return getDayPlan(this, date);
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
