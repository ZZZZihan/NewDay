import type {
  PlannerArchiveData,
  PlannerArchiveStore,
} from "@newday/core/application/planner-archive-store";
import type {
  FocusRecord,
  RecurrenceSeries,
  Task,
} from "@newday/core/domain/planner-model";

export class MemoryPlannerStore implements PlannerArchiveStore {
  private tasks = new Map<string, Task>();
  private recurrenceSeries = new Map<string, RecurrenceSeries>();
  private focusRecords = new Map<string, FocusRecord>();

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const tasksSnapshot = new Map(this.tasks);
    const recurrenceSeriesSnapshot = new Map(this.recurrenceSeries);
    const focusRecordsSnapshot = new Map(this.focusRecords);

    try {
      return await operation();
    } catch (error) {
      this.tasks = tasksSnapshot;
      this.recurrenceSeries = recurrenceSeriesSnapshot;
      this.focusRecords = focusRecordsSnapshot;
      throw error;
    }
  }

  async getTask(id: string) {
    return clone(this.tasks.get(id));
  }

  async getTaskByOccurrenceKey(occurrenceKey: string) {
    return clone(
      [...this.tasks.values()].find(
        (task) => task.occurrenceKey === occurrenceKey,
      ),
    );
  }

  async putTask(task: Task) {
    const duplicate = [...this.tasks.values()].find(
      (stored) =>
        task.occurrenceKey !== undefined &&
        stored.occurrenceKey === task.occurrenceKey &&
        stored.id !== task.id,
    );

    if (duplicate) {
      throw new Error(`重复任务实例键：${task.occurrenceKey}`);
    }

    this.tasks.set(task.id, structuredClone(task));
  }

  async deleteTask(id: string) {
    this.tasks.delete(id);
  }

  async listAllTasks() {
    return cloneValues(this.tasks);
  }

  async listTasksBySeries(seriesId: string) {
    return [...this.tasks.values()]
      .filter((task) => task.seriesId === seriesId)
      .map((task) => structuredClone(task));
  }

  async getRecurrenceSeries(id: string) {
    return clone(this.recurrenceSeries.get(id));
  }

  async putRecurrenceSeries(series: RecurrenceSeries) {
    this.recurrenceSeries.set(series.id, structuredClone(series));
  }

  async deleteRecurrenceSeries(id: string) {
    this.recurrenceSeries.delete(id);
  }

  async listAllRecurrenceSeries() {
    return cloneValues(this.recurrenceSeries);
  }

  async listRecurrenceSeriesByLogicalSeriesId(logicalSeriesId: string) {
    return [...this.recurrenceSeries.values()]
      .filter((series) => series.logicalSeriesId === logicalSeriesId)
      .sort((left, right) =>
        left.startDate.localeCompare(right.startDate) || left.id.localeCompare(right.id),
      )
      .map((series) => structuredClone(series));
  }

  async getFocusRecord(id: string) {
    return clone(this.focusRecords.get(id));
  }

  async putFocusRecord(record: FocusRecord) {
    const duplicate = [...this.focusRecords.values()].find(
      (stored) =>
        stored.date === record.date &&
        stored.taskId === record.taskId &&
        stored.id !== record.id,
    );

    if (duplicate) {
      throw new Error(`任务在该日期已设为重点：${record.taskId}`);
    }

    this.focusRecords.set(record.id, structuredClone(record));
  }

  async deleteFocusRecord(id: string) {
    this.focusRecords.delete(id);
  }

  async listFocusRecordsForDate(date: string) {
    return [...this.focusRecords.values()]
      .filter((record) => record.date === date)
      .map((record) => structuredClone(record));
  }

  async listFocusRecordsForTask(taskId: string) {
    return [...this.focusRecords.values()]
      .filter((record) => record.taskId === taskId)
      .map((record) => structuredClone(record));
  }

  async listAllFocusRecords() {
    return cloneValues(this.focusRecords);
  }

  async replaceAllData(data: PlannerArchiveData) {
    await this.transaction(async () => {
      const tasks = new Map<string, Task>();
      const occurrenceKeys = new Set<string>();

      for (const task of data.tasks) {
        if (tasks.has(task.id)) {
          throw new Error(`重复任务 ID：${task.id}`);
        }

        if (
          task.occurrenceKey !== undefined &&
          occurrenceKeys.has(task.occurrenceKey)
        ) {
          throw new Error(`重复任务实例键：${task.occurrenceKey}`);
        }

        tasks.set(task.id, structuredClone(task));
        if (task.occurrenceKey !== undefined) {
          occurrenceKeys.add(task.occurrenceKey);
        }
      }

      const recurrenceSeries = mapUniqueById(
        data.recurrenceSeries ?? [],
        "重复系列",
      );
      const focusRecords = new Map<string, FocusRecord>();
      const focusKeys = new Set<string>();

      for (const record of data.focusRecords ?? []) {
        if (focusRecords.has(record.id)) {
          throw new Error(`重复重点记录 ID：${record.id}`);
        }

        const focusKey = `${record.date}:${record.taskId}`;
        if (focusKeys.has(focusKey)) {
          throw new Error(`任务在该日期已设为重点：${record.taskId}`);
        }

        focusRecords.set(record.id, structuredClone(record));
        focusKeys.add(focusKey);
      }

      this.tasks = tasks;
      this.recurrenceSeries = recurrenceSeries;
      this.focusRecords = focusRecords;
    });
  }

}

function mapUniqueById<T extends { id: string }>(
  values: readonly T[],
  label: string,
) {
  const result = new Map<string, T>();

  for (const value of values) {
    if (result.has(value.id)) {
      throw new Error(`${label} ID 重复：${value.id}`);
    }

    result.set(value.id, structuredClone(value));
  }

  return result;
}

function cloneValues<T>(values: Map<string, T>) {
  return [...values.values()].map((value) => structuredClone(value));
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
