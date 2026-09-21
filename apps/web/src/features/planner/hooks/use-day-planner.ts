import { type FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { parsePlannerBackup } from "@newday/core/contracts/planner-backup";
import type { PlannerCommand } from "@newday/core/application/planner-command";
import { shiftDate, todayKey } from "@newday/core/domain/planner-date";
import { hasTaskDates, type DatedTask, type RecurrenceSeries, type Task } from "@newday/core/domain/planner-model";
import { plannerApi, type CommandPreconditions, type CommandReceipt } from "../api/planner-api";
import type { TaskEditorValues } from "../components/task-editor";
import { downloadBackup } from "../lib/backup-download";
import { useLegacyMigration } from "../migration/use-legacy-migration";
import { usePlannerData, usePlannerSeries } from "./use-planner-data";
import { usePlanningClock } from "./use-planning-clock";

const subscribeToHydration = () => () => undefined;
const subscribeToClock = (onStoreChange: () => void) => {
  const interval = window.setInterval(onStoreChange, 1_000);
  return () => window.clearInterval(interval);
};
const getClockSnapshot = () => Math.floor(Date.now() / 60_000);
const getServerClockSnapshot = () => null;

type Notice = { id: number; message: string; receipt?: CommandReceipt };

export function useDayPlanner() {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const clockMinute = useSyncExternalStore(
    subscribeToClock,
    getClockSnapshot,
    getServerClockSnapshot,
  );
  const now = clockMinute === null ? null : new Date(clockMinute * 60_000);
  const planningClock = usePlanningClock(clockMinute);
  const today = planningClock.status?.today ?? (hydrated ? todayKey() : "1970-01-01");
  const timeZone = planningClock.status?.timeZone ?? undefined;
  const [dateOverride, setDateOverride] = useState<string | null>(null);
  const selectedDate = dateOverride ?? (hydrated && planningClock.ready ? today : null);
  const [quickTitle, setQuickTitle] = useState("");
  const [editingTaskId, setEditingTaskIdState] = useState<string | null>(null);
  // Polls may replace task props while this editor is open. Keep the opening
  // snapshot stable so the API can reject a save based on stale input.
  const [editingTaskSnapshot, setEditingTaskSnapshot] = useState<Task | null>(null);
  const [editingSeriesSnapshot, setEditingSeriesSnapshot] = useState<RecurrenceSeries | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const noticeId = useRef(0);
  const mutationPending = useRef(false);
  const quickInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const migration = useLegacyMigration(hydrated);
  const { dayPlan, error: dataError, refreshing, refresh } = usePlannerData(
    selectedDate, today, !migration.checking,
  );
  const taskById = useMemo(() => {
    const items = dayPlan
      ? [...dayPlan.focus, ...dayPlan.overdue, ...dayPlan.open, ...dayPlan.completed]
      : [];
    return new Map(items.map(({ task }) => [task.id, task]));
  }, [dayPlan]);
  const editingTask = editingTaskId && editingTaskSnapshot?.id === editingTaskId && hasTaskDates(editingTaskSnapshot)
    ? editingTaskSnapshot
    : editingTaskId ? taskById.get(editingTaskId) : undefined;

  function setEditingTaskId(taskId: string | null) {
    setEditingTaskIdState(taskId);
    setEditingSeriesSnapshot(null);
    if (taskId === null) {
      setEditingTaskSnapshot(null);
      return;
    }
    const task = taskById.get(taskId);
    setEditingTaskSnapshot(task && hasTaskDates(task) ? task : null);
  }
  const editingSeriesId = editingTask?.seriesId;
  const {
    series: liveEditingSeries,
    error: liveSeriesError,
    loading: liveSeriesLoading,
    retry: retrySeries,
  } = usePlannerSeries(
    editingSeriesId, editingTask?.updatedAt, dayPlan,
  );
  useEffect(() => {
    if (!editingSeriesId) {
      setEditingSeriesSnapshot(null);
      return;
    }
    if (liveEditingSeries?.id !== editingSeriesId) return;
    setEditingSeriesSnapshot((current) =>
      current?.id === editingSeriesId ? current : liveEditingSeries);
  }, [editingSeriesId, liveEditingSeries]);
  const editingSeries: RecurrenceSeries | undefined = editingSeriesId
    ? editingSeriesSnapshot?.id === editingSeriesId
      ? editingSeriesSnapshot ?? undefined
      : liveEditingSeries?.id === editingSeriesId ? liveEditingSeries : undefined
    : undefined;
  // Revalidation may discover that a series changed or disappeared. Once the
  // editor has an opening snapshot, keep the form usable so its save reaches
  // the transactional conflict check instead of losing the local draft.
  const seriesLoading = Boolean(editingSeriesId && !editingSeries && liveSeriesLoading);
  const seriesError = editingSeries ? null : liveSeriesError;
  const editingSeriesActionsAllowed = Boolean(
    editingTask &&
      editingSeries &&
      seriesAllowsTailOperations(
        editingSeries,
        editingTask.occurrenceDate ?? editingTask.startDate,
      ),
  );

  const activeNoticeId = notice?.id;
  useEffect(() => {
    if (activeNoticeId === undefined) return;
    const timeout = window.setTimeout(() => {
      setNotice(null);
    }, 10_000);
    return () => window.clearTimeout(timeout);
  }, [activeNoticeId]);

  function showNotice(message: string, receipt?: CommandReceipt) {
    noticeId.current += 1;
    setNotice({ id: noticeId.current, message, receipt });
  }

  function showFailureNotice(message: string) {
    noticeId.current += 1;
    const id = noticeId.current;
    setNotice((current) => ({ id, message, receipt: current?.receipt }));
  }

  async function runCommand(
    command: PlannerCommand,
    successMessage: string,
    preconditions: CommandPreconditions = {},
  ) {
    return runCommands([command], successMessage, preconditions);
  }

  async function runCommands(
    commands: readonly PlannerCommand[],
    successMessage: string,
    preconditions: CommandPreconditions = {},
  ) {
    if (mutationPending.current || migration.checking) return false;
    mutationPending.current = true;
    setIsSaving(true);

    try {
      const { receipt } = await plannerApi.commands(commands, preconditions);
      await refresh();
      showNotice(successMessage, receipt ?? undefined);
      return true;
    } catch (error) {
      showFailureNotice(
        error instanceof Error ? error.message : "操作失败，请重试",
      );
      return false;
    } finally {
      mutationPending.current = false;
      setIsSaving(false);
    }
  }

  async function handleUndo(): Promise<boolean> {
    if (!notice?.receipt || mutationPending.current || migration.checking) return false;
    mutationPending.current = true;
    setIsUndoing(true);

    try {
      await plannerApi.undo(notice.receipt);
      await refresh();
      showNotice("已撤销");
      return true;
    } catch (error) {
      setNotice((current) =>
        current
          ? {
              ...current,
              message: error instanceof Error ? error.message : "撤销失败，请重试",
            }
          : current,
      );
      return false;
    } finally {
      mutationPending.current = false;
      setIsUndoing(false);
    }
  }

  async function handleQuickAdd(event: FormEvent<HTMLFormElement>, notionWorkspaceId?: string) {
    event.preventDefault();
    const title = quickTitle.trim();
    if (!selectedDate || !title) return;

    setQuickTitle("");
    quickInputRef.current?.focus();
    const saved = await runCommand(
      {
        type: "createTask",
        input: {
          id: crypto.randomUUID(),
          title,
          startDate: selectedDate,
          endDate: selectedDate,
          now: new Date().toISOString(),
          ...(notionWorkspaceId ? { notionWorkspaceId } : {}),
        },
      },
      notionWorkspaceId ? `已添加“${title}”，等待 Notion 同步` : `已添加“${title}”`,
    );
    if (!saved) setQuickTitle(title);
  }

  async function handleComplete(task: Task) {
    return runCommand(
      {
        type: task.status === "completed" ? "reopenTask" : "completeTask",
        input: {
          taskId: task.id,
          now: new Date().toISOString(),
          asOfDate: today,
        },
      },
      task.status === "completed" ? "任务已恢复" : "任务已完成",
    );
  }

  async function handleSchedule(task: Task, date: string) {
    return runCommand({ type: "rescheduleTask", input: {
      taskId: task.id, startDate: date, endDate: date, now: new Date().toISOString(),
    } }, "任务已安排日期，等待 Notion 同步", { expectedTask: task });
  }

  async function handleFocus(task: Task, focused: boolean) {
    return runCommand(
      focused
        ? { type: "removeTodayFocus", input: { taskId: task.id, date: today } }
        : {
            type: "setTodayFocus",
            input: { taskId: task.id, date: today, now: new Date().toISOString() },
          },
      focused ? "已移出今日重点" : "已设为今日重点",
    );
  }

  async function handleExport() {
    if (mutationPending.current || migration.checking) return;
    mutationPending.current = true;
    setIsSaving(true);
    try {
      const backup = await plannerApi.backup();
      downloadBackup(backup);
      showNotice(`已导出 ${backup.tasks.length} 项任务、${backup.resources.length} 份资料`);
    } catch (error) {
      showFailureNotice(error instanceof Error ? error.message : "导出失败，请重试");
    } finally {
      mutationPending.current = false;
      setIsSaving(false);
    }
  }

  async function handleImport(file: File): Promise<boolean> {
    if (mutationPending.current || migration.checking) return false;
    mutationPending.current = true;
    setIsSaving(true);
    try {
      if (file.size > 10 * 1024 * 1024) {
        throw new Error("备份文件不能超过 10 MB");
      }

      const source = await file.text();
      const candidate = parsePlannerBackup(source);
      const confirmed = window.confirm(
        `导入将替换当前全部数据，共 ${candidate.tasks.length} 项任务、${candidate.resources.length} 份资料、${candidate.inboxItems.length} 条收集箱内容。继续吗？`,
      );
      if (!confirmed) return false;

      const safetyBackup = await plannerApi.backup();
      downloadBackup(safetyBackup, "newday-before-import");
      await plannerApi.restore(source);
      await refresh();
      setEditingTaskId(null);
      showNotice(`导入完成：${candidate.tasks.length} 项任务、${candidate.resources.length} 份资料`);
      return true;
    } catch (error) {
      showFailureNotice(error instanceof Error ? error.message : "导入失败，请检查文件");
      return false;
    } finally {
      mutationPending.current = false;
      setIsSaving(false);
    }
  }

  async function saveEditor(
    task: DatedTask,
    series: RecurrenceSeries | undefined,
    values: TaskEditorValues,
  ) {
    if (series && (seriesLoading || seriesError)) return false;
    const timestamp = new Date().toISOString();

    if (!series && values.recurrenceKind !== "none" && values.pattern && values.end) {
      const saved = await runCommand(
        {
          type: "createRecurrenceSeriesFromTask",
          input: {
            taskId: task.id,
            seriesId: crypto.randomUUID(),
            title: values.title,
            notes: values.notes,
            occurrenceDate: values.startDate,
            pattern: values.pattern,
            end: values.end,
            now: timestamp,
          },
        },
        "重复任务已保存",
        { expectedTask: task },
      );
      return saved;
    }

    if (series && values.scope === "series" && values.pattern && values.end) {
      const throughDate = shiftDate(today, 31);
      return runCommand(
        {
          type: "updateRecurrenceSeries",
          input: {
            seriesId: series.id,
            newSeriesId: crypto.randomUUID(),
            title: values.title,
            notes: values.notes,
            pattern: values.pattern,
            end: values.end,
            effectiveDate: task.occurrenceDate ?? task.startDate,
            materialization: {
              asOfDate: today,
              throughDate,
              additionallyEnsureDate:
                selectedDate && selectedDate > throughDate
                  ? selectedDate
                  : undefined,
            },
            now: timestamp,
          },
        },
        "后续重复已更新",
        { expectedSeries: series },
      );
    }

    const commands: PlannerCommand[] = [];
    if (values.title !== task.title || values.notes !== task.notes) {
      commands.push({
        type: "updateTaskDetails",
        input: {
          taskId: task.id,
          title: values.title,
          notes: values.notes,
          now: timestamp,
        },
      });
    }
    if (values.startDate !== task.startDate || values.endDate !== task.endDate) {
      commands.push({
        type: "rescheduleTask",
        input: {
          taskId: task.id,
          startDate: values.startDate,
          endDate: values.endDate,
          now: timestamp,
        },
      });
    }

    if (commands.length === 0) return true;
    return runCommands(commands, "任务已保存", { expectedTask: task });
  }

  function moveDate(offset: number) {
    if (!selectedDate) return;
    setDateOverride(shiftDate(selectedDate, offset));
    setEditingTaskId(null);
  }

  function openExternalTask(task: Task) {
    setEditingSeriesSnapshot(null);
    setEditingTaskSnapshot(task);
    setEditingTaskIdState(task.id);
  }

  async function deleteEditingTask() {
    if (!editingTask) return;

    if (!window.confirm(`删除“${editingTask.title}”？你可以在提示消失前撤销。`)) return;
    const deleted = await runCommand(
      { type: "deleteTask", input: { taskId: editingTask.id, now: new Date().toISOString() } },
      "任务已删除",
    );
    if (deleted) setEditingTaskId(null);
  }

  async function stopEditingRecurrence() {
    if (!editingTask || !editingSeries || mutationPending.current) return;
    mutationPending.current = true;

    const endDate = editingTask.occurrenceDate ?? editingTask.startDate;
    setIsSaving(true);
    let impact;
    try {
      impact = await plannerApi.stopPreview(editingSeries.id, endDate);
    } catch (error) {
      showFailureNotice(
        error instanceof Error ? error.message : "无法计算停止范围",
      );
      return;
    } finally {
      mutationPending.current = false;
      setIsSaving(false);
    }

    const focusMessage = impact.focusRecordCount
      ? `，并移除 ${impact.focusRecordCount} 条重点记录`
      : "";
    const successorMessage = impact.successorSegmentCount
      ? `；${impact.successorSegmentCount} 段后续重复规则会一并移除`
      : "";
    const preservedMessage = impact.preservedTaskCount
      ? `；${impact.preservedTaskCount} 个已完成或单独修改的实例会保留`
      : "";
    if (
      !window.confirm(
        `将停止 ${endDate} 之后的重复，并移除 ${impact.openOrdinaryTaskCount} 个已生成且尚未完成的普通实例${focusMessage}${successorMessage}${preservedMessage}。你可以在提示消失前撤销。继续吗？`,
      )
    ) {
      return;
    }

    const stopped = await runCommand(
      {
        type: "stopRecurrenceSeries",
        input: {
          seriesId: editingSeries.id,
          endDate,
          expectedImpact: impact,
          now: new Date().toISOString(),
        },
      },
      "已停止后续重复",
    );
    if (stopped) setEditingTaskId(null);
  }

  return {
    now, today, timeZone, selectedDate, setDateOverride, quickTitle, setQuickTitle,
    setEditingTaskId, openExternalTask, editingTask, editingSeries, editingSeriesActionsAllowed,
    notice, isSaving, isUndoing, quickInputRef, importInputRef,
    dayPlan, dataError, refreshing, refresh, migration, seriesError, seriesLoading, retrySeries,
    handleUndo, handleQuickAdd, handleComplete, handleSchedule, handleFocus, handleExport,
    handleImport, saveEditor, moveDate, deleteEditingTask, stopEditingRecurrence,
  };
}

function seriesAllowsTailOperations(
  series: RecurrenceSeries,
  occurrenceDate: string,
) {
  return (
    occurrenceDate >= series.startDate &&
    (series.effectiveEndDate === null ||
      occurrenceDate <= series.effectiveEndDate) &&
    (series.end.kind === "never" || occurrenceDate <= series.end.date)
  );
}
