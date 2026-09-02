"use client";

import { useLiveQuery } from "dexie-react-hooks";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Download,
  Edit3,
  MoreHorizontal,
  Plus,
  Repeat2,
  RotateCcw,
  Star,
  Upload,
} from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { Menu } from "@heroui/react/menu";
import { Popover } from "@heroui/react/popover";

import { plannerStore } from "../adapters/planner-client";
import { getDayPlan } from "../application/day-plan";
import {
  createPlannerBackup,
  parsePlannerBackup,
  restorePlannerBackup,
  type PlannerBackup,
} from "../application/planner-backup";
import {
  executePlannerCommands,
  type PlannerCommand,
} from "../application/planner-command";
import { ensureRecurrenceOccurrences } from "../application/recurrence-generation";
import {
  clearUndoReceipts,
  undoPlannerCommand,
  type UndoReceipt,
} from "../application/planner-undo";
import {
  formatDayShort,
  parseLocalDate,
  shiftDate,
  todayKey,
} from "../domain/planner-date";
import type {
  DayPlanItem,
  RecurrenceSeries,
  Task,
} from "../domain/planner-model";
import { TaskEditor, type TaskEditorValues } from "./task-editor";
import { ThemeToggle } from "./theme-toggle";

const subscribeToHydration = () => () => undefined;
const subscribeToClock = (onStoreChange: () => void) => {
  const interval = window.setInterval(onStoreChange, 1_000);
  return () => window.clearInterval(interval);
};
const getClockSnapshot = () => Math.floor(Date.now() / 60_000);
const getServerClockSnapshot = () => null;
const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;

type Notice = {
  id: number;
  message: string;
  receipt?: UndoReceipt;
};

function downloadBackup(backup: PlannerBackup, prefix = "newday-backup") {
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const timestamp = backup.exportedAt.replaceAll(":", "-");
  anchor.href = url;
  anchor.download = `${prefix}-${timestamp}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatClockTime(date: Date | null) {
  if (!date) return "--:--";

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatClockDate(date: Date | null) {
  if (!date) return "正在读取当前日期";

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

function formatTaskRange(task: Task) {
  if (task.startDate === task.endDate) return formatDayShort(task.startDate);

  const sameYear = task.startDate.slice(0, 4) === task.endDate.slice(0, 4);
  const start = sameYear
    ? formatDayShort(task.startDate)
    : formatYearDay(task.startDate);
  const end = sameYear ? formatDayShort(task.endDate) : formatYearDay(task.endDate);
  return `${start} – ${end}`;
}

function formatYearDay(date: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parseLocalDate(date));
}

function taskMetadata(item: DayPlanItem) {
  const { task, isOverdue } = item;
  const parts = [
    isOverdue ? `逾期 · 截止 ${formatDayShort(task.endDate)}` : formatTaskRange(task),
  ];

  if (task.seriesId) parts.push(task.isSeriesException ? "重复 · 已单独修改" : "重复");
  return parts.join(" · ");
}

export function DayPlanner() {
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
  const today = hydrated ? todayKey() : "1970-01-01";
  const [dateOverride, setDateOverride] = useState<string | null>(null);
  const selectedDate = dateOverride ?? (hydrated ? today : null);
  const [quickTitle, setQuickTitle] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [generationRevision, setGenerationRevision] = useState(0);
  const noticeId = useRef(0);
  const quickInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const queryDate = selectedDate ?? "1970-01-01";
  const dayPlan = useLiveQuery(
    () => getDayPlan(plannerStore, { selectedDate: queryDate, asOfDate: today }),
    [queryDate, today],
  );
  const taskById = useMemo(() => {
    const items = dayPlan
      ? [...dayPlan.focus, ...dayPlan.overdue, ...dayPlan.open, ...dayPlan.completed]
      : [];
    return new Map(items.map(({ task }) => [task.id, task]));
  }, [dayPlan]);
  const editingTask = editingTaskId ? taskById.get(editingTaskId) : undefined;
  const editingSeriesId = editingTask?.seriesId;
  const editingSeries = useLiveQuery(
    () =>
      editingSeriesId
        ? plannerStore.getRecurrenceSeries(editingSeriesId)
        : undefined,
    [editingSeriesId],
  );

  useEffect(() => {
    if (!selectedDate || !hydrated) return;

    const throughDate = shiftDate(today, 31);
    const additionallyEnsureDate =
      selectedDate > throughDate ? selectedDate : undefined;
    let active = true;

    void ensureRecurrenceOccurrences(plannerStore, {
      asOfDate: today,
      throughDate,
      additionallyEnsureDate,
      now: new Date().toISOString(),
    }).catch((error) => {
      if (active) {
        showFailureNotice(error instanceof Error ? error.message : "无法生成重复任务");
      }
    });

    return () => {
      active = false;
    };
  }, [generationRevision, hydrated, selectedDate, today]);

  const activeNoticeId = notice?.id;
  useEffect(() => {
    if (activeNoticeId === undefined) return;
    const timeout = window.setTimeout(() => {
      clearUndoReceipts(plannerStore);
      setNotice(null);
    }, 10_000);
    return () => window.clearTimeout(timeout);
  }, [activeNoticeId]);

  function showNotice(message: string, receipt?: UndoReceipt) {
    noticeId.current += 1;
    setNotice({ id: noticeId.current, message, receipt });
  }

  function showFailureNotice(message: string) {
    noticeId.current += 1;
    const id = noticeId.current;
    setNotice((current) => ({ id, message, receipt: current?.receipt }));
  }

  async function runCommand(command: PlannerCommand, successMessage: string) {
    return runCommands([command], successMessage);
  }

  async function runCommands(
    commands: readonly PlannerCommand[],
    successMessage: string,
  ) {
    setIsSaving(true);

    try {
      const receipt = await executePlannerCommands(plannerStore, commands);
      showNotice(successMessage, receipt);
      return true;
    } catch (error) {
      showFailureNotice(
        error instanceof Error ? error.message : "操作失败，请重试",
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function handleUndo() {
    if (!notice?.receipt || isUndoing) return;
    setIsUndoing(true);

    try {
      await undoPlannerCommand(plannerStore, notice.receipt);
      showNotice("已撤销");
    } catch (error) {
      setNotice((current) =>
        current
          ? {
              ...current,
              message: error instanceof Error ? error.message : "撤销失败，请重试",
            }
          : current,
      );
    } finally {
      setIsUndoing(false);
    }
  }

  async function handleQuickAdd(event: FormEvent<HTMLFormElement>) {
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
        },
      },
      `已添加“${title}”`,
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
    setIsSaving(true);
    try {
      const backup = await createPlannerBackup(plannerStore);
      downloadBackup(backup);
      showNotice(`已导出 ${backup.tasks.length} 项任务`);
    } catch (error) {
      showFailureNotice(error instanceof Error ? error.message : "导出失败，请重试");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleImport(file: File) {
    setIsSaving(true);
    try {
      if (file.size > 10 * 1024 * 1024) {
        throw new Error("备份文件不能超过 10 MB");
      }

      const source = await file.text();
      const candidate = parsePlannerBackup(source);
      const confirmed = window.confirm(
        `导入将替换当前全部数据，共 ${candidate.tasks.length} 项任务。继续吗？`,
      );
      if (!confirmed) return;

      const safetyBackup = await createPlannerBackup(plannerStore);
      downloadBackup(safetyBackup, "newday-before-import");
      await restorePlannerBackup(plannerStore, source);
      setEditingTaskId(null);
      setGenerationRevision((current) => current + 1);
      showNotice(`导入完成：${candidate.tasks.length} 项任务`);
    } catch (error) {
      showFailureNotice(error instanceof Error ? error.message : "导入失败，请检查文件");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveEditor(
    task: Task,
    series: RecurrenceSeries | undefined,
    values: TaskEditorValues,
  ) {
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
      );
      if (saved) setGenerationRevision((current) => current + 1);
      return saved;
    }

    if (series && values.scope === "series" && values.pattern && values.end) {
      const saved = await runCommand(
        {
          type: "updateRecurrenceSeries",
          input: {
            seriesId: series.id,
            title: values.title,
            notes: values.notes,
            pattern: values.pattern,
            end: values.end,
            effectiveDate: task.occurrenceDate ?? task.startDate,
            now: timestamp,
          },
        },
        "后续重复已更新",
      );
      if (saved) setGenerationRevision((current) => current + 1);
      return saved;
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
    return runCommands(commands, "任务已保存");
  }

  function moveDate(offset: number) {
    if (!selectedDate) return;
    setDateOverride(shiftDate(selectedDate, offset));
    setEditingTaskId(null);
  }

  if (!selectedDate) return <PlannerLoading />;

  const selectedIsToday = selectedDate === today;
  const mondayOffset = (parseLocalDate(selectedDate).getDay() + 6) % 7;
  const weekStart = shiftDate(selectedDate, -mondayOffset);
  const weekDays = WEEKDAY_LABELS.map((weekday, index) => ({
    weekday,
    date: shiftDate(weekStart, index),
  }));
  const [clockHours, clockMinutes] = formatClockTime(now).split(":");
  const focusedIds = new Set(dayPlan?.focus.map(({ task }) => task.id) ?? []);
  const focusAtLimit = (dayPlan?.counts.focus ?? 0) >= 3;
  const hasOpenGroups = Boolean(
    dayPlan &&
      (dayPlan.focus.length > 0 || dayPlan.overdue.length > 0 || dayPlan.open.length > 0),
  );

  return (
    <main className="day-page" aria-busy={isSaving || isUndoing}>
      <div className="planner-frame">
        <Card className="time-panel" aria-label="时间与日期">
          <header className="panel-header">
            <div className="panel-brand">
              <span className="brand-mark" aria-hidden="true">N</span>
              <div>
                <p className="brand-name">NewDay</p>
                <p className="brand-caption">今天，只看要做的事</p>
              </div>
            </div>

            <div className="panel-utilities">
              <ThemeToggle />
              <Popover>
                <Popover.Trigger className="more-trigger" aria-label="更多操作" aria-haspopup="menu">
                  <MoreHorizontal size={20} aria-hidden="true" />
                </Popover.Trigger>
                <Popover.Content className="more-popover" placement="bottom end">
                  <Popover.Dialog>
                    <Menu aria-label="更多操作菜单" className="more-menu">
                      <Menu.Item id="export" aria-label="导出数据" isDisabled={isSaving} onAction={() => void handleExport()}>
                        <Download size={17} aria-hidden="true" />
                        <span><strong>导出备份</strong><small>保存任务、重复规则与重点</small></span>
                      </Menu.Item>
                      <Menu.Item id="import" aria-label="导入数据" isDisabled={isSaving} onAction={() => importInputRef.current?.click()}>
                        <Upload size={17} aria-hidden="true" />
                        <span><strong>导入备份</strong><small>替换当前全部规划数据</small></span>
                      </Menu.Item>
                    </Menu>
                  </Popover.Dialog>
                </Popover.Content>
              </Popover>
              <input
                ref={importInputRef}
                className="visually-hidden"
                data-testid="import-input"
                type="file"
                accept="application/json,.json"
                disabled={isSaving}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void handleImport(file);
                }}
              />
            </div>
          </header>

          <section className="time-panel__clock" aria-label="当前时间">
            <time className="hero-clock" data-testid="current-clock" dateTime={now?.toISOString()}>
              <span>{clockHours}</span>
              <span className="hero-clock__colon">:</span>
              <span>{clockMinutes}</span>
            </time>
            <p className="hero-date">{formatClockDate(now)}</p>
          </section>

          <div className="time-panel__bottom">
            <nav className="week-navigation" aria-label="日期导航">
              <div className="week-navigation__header">
                <Button className="date-arrow" type="button" variant="ghost" size="sm" isIconOnly aria-label="前一天" onPress={() => moveDate(-1)}>
                  <ChevronLeft size={19} />
                </Button>
                <div className="date-picker-control">
                  <Button className="date-picker-button" type="button" variant="ghost" aria-hidden="true">
                    <CalendarDays size={16} aria-hidden="true" />
                    <span>{formatDayShort(selectedDate)}{selectedIsToday ? " · 今天" : ""}</span>
                  </Button>
                  <input
                    className="date-picker-input"
                    aria-label="选择日期"
                    type="date"
                    value={selectedDate}
                    onChange={(event) => {
                      if (event.target.value) {
                        setDateOverride(event.target.value);
                        setEditingTaskId(null);
                      }
                    }}
                  />
                </div>
                <Button className="date-arrow" type="button" variant="ghost" size="sm" isIconOnly aria-label="后一天" onPress={() => moveDate(1)}>
                  <ChevronRight size={19} />
                </Button>
              </div>

              <div className="week-strip" aria-label="本周日期">
                {weekDays.map(({ weekday, date }) => (
                  <Button
                    key={date}
                    type="button"
                    variant="ghost"
                    className={`week-day ${date === selectedDate ? "week-day--selected" : ""} ${date === today ? "week-day--today" : ""}`}
                    aria-label={`查看${formatYearDay(date)}的任务`}
                    aria-pressed={date === selectedDate}
                    onPress={() => {
                      setDateOverride(date);
                      setEditingTaskId(null);
                    }}
                  >
                    <small>{weekday}</small>
                    <span>{Number(date.slice(8, 10))}</span>
                  </Button>
                ))}
              </div>
            </nav>

            <div className="time-panel__summary">
              <p className="task-summary" aria-label="任务概览">
                <strong>{dayPlan?.counts.open ?? 0} 项待办</strong>
                <span aria-hidden="true">·</span>
                <span>{dayPlan?.counts.completed ?? 0} 项完成</span>
              </p>
              {!selectedIsToday ? (
                <Button className="today-button" type="button" variant="ghost" size="sm" onPress={() => setDateOverride(today)}>
                  回到今天
                </Button>
              ) : null}
            </div>
          </div>

          <footer className="time-panel__footer-zone">
            <blockquote>“把今天过好，就是最好的计划。”</blockquote>
            <div className="time-panel__footer">
              <span className="local-status-dot" aria-hidden="true" />
              仅保存在此浏览器
            </div>
          </footer>
        </Card>

        <section className="schedule-panel" aria-label="每日任务表">
          <header className="schedule-heading">
            <div>
              <p className="section-kicker">{selectedIsToday ? "今天" : formatDayShort(selectedDate)}</p>
              <h1>{selectedIsToday ? "今天的任务" : "这一天的任务"}</h1>
            </div>
            <p className="schedule-meta"><strong>{dayPlan?.counts.open ?? 0}</strong> 项待办</p>
          </header>

          <form className="quick-add" onSubmit={handleQuickAdd}>
            <Input
              ref={quickInputRef}
              id="quick-task"
              data-testid="quick-task-input"
              value={quickTitle}
              onChange={(event) => setQuickTitle(event.target.value)}
              placeholder="添加一件要做的事"
              aria-label="添加一件要做的事"
              autoComplete="off"
              fullWidth
              variant="secondary"
            />
            <Button type="submit" variant="primary" size="lg" isIconOnly aria-label="添加任务" isDisabled={!quickTitle.trim() || isSaving}>
              <Plus size={20} />
            </Button>
          </form>

          <div className="daily-task-list" data-testid="daily-task-list">
            {!dayPlan ? (
              <div className="task-list-loading" role="status">
                <span className="task-list-loading__indicator" aria-hidden="true" />
                正在读取这一天的任务…
              </div>
            ) : null}

            {dayPlan?.focus.length ? (
              <TaskGroup title="今日重点" count={dayPlan.focus.length} className="task-group--focus">
                {dayPlan.focus.map((item) => (
                  <TaskRow
                    key={item.task.id}
                    item={item}
                    focused
                    canFocus={selectedIsToday}
                    focusDisabled={false}
                    onFocus={handleFocus}
                    onComplete={handleComplete}
                    onEdit={() => setEditingTaskId(item.task.id)}
                  />
                ))}
              </TaskGroup>
            ) : null}

            {dayPlan?.overdue.length ? (
              <TaskGroup title="逾期" count={dayPlan.overdue.length} className="task-group--overdue">
                {dayPlan.overdue.map((item) => (
                  <TaskRow
                    key={item.task.id}
                    item={item}
                    focused={focusedIds.has(item.task.id)}
                    canFocus={selectedIsToday}
                    focusDisabled={focusAtLimit}
                    onFocus={handleFocus}
                    onComplete={handleComplete}
                    onEdit={() => setEditingTaskId(item.task.id)}
                  />
                ))}
              </TaskGroup>
            ) : null}

            {dayPlan?.open.length ? (
              <TaskGroup title="待办" count={dayPlan.open.length}>
                {dayPlan.open.map((item) => (
                  <TaskRow
                    key={item.task.id}
                    item={item}
                    focused={focusedIds.has(item.task.id)}
                    canFocus={selectedIsToday}
                    focusDisabled={focusAtLimit}
                    onFocus={handleFocus}
                    onComplete={handleComplete}
                    onEdit={() => setEditingTaskId(item.task.id)}
                  />
                ))}
              </TaskGroup>
            ) : null}

            {selectedIsToday && focusAtLimit && (dayPlan?.open.length || dayPlan?.overdue.length) ? (
              <p className="focus-limit-note" id="focus-limit-help">今日重点最多 3 项</p>
            ) : null}

            {dayPlan && !hasOpenGroups ? (
              <Card className="task-empty" variant="tertiary">
                <Check size={24} aria-hidden="true" />
                <p>{dayPlan.completed.length > 0 ? "这一天已经完成了" : "这一天还没有任务"}</p>
                <span>在上方写下一件要做的事。</span>
              </Card>
            ) : null}

            {dayPlan?.completed.length ? (
              <details className="completed-section" open>
                <summary>已完成 · {dayPlan.completed.length}</summary>
                <div className="completed-list">
                  {dayPlan.completed.map((item) => (
                    <TaskRow
                      key={item.task.id}
                      item={item}
                      focused={false}
                      canFocus={false}
                      focusDisabled={false}
                      onFocus={handleFocus}
                      onComplete={handleComplete}
                      onEdit={() => setEditingTaskId(item.task.id)}
                    />
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        </section>
      </div>

      {editingTask && (!editingTask.seriesId || editingSeries) ? (
        <TaskEditor
          key={`${editingTask.id}:${editingSeries?.updatedAt ?? "one-off"}`}
          task={editingTask}
          series={editingSeries}
          busy={isSaving}
          onClose={() => setEditingTaskId(null)}
          onSave={async (values) => {
            const saved = await saveEditor(editingTask, editingSeries, values);
            if (saved) setEditingTaskId(null);
          }}
          onToggleComplete={async () => {
            const saved = await handleComplete(editingTask);
            if (saved) setEditingTaskId(null);
          }}
          onDelete={async () => {
            if (!window.confirm(`删除“${editingTask.title}”？你可以在提示消失前撤销。`)) return;
            const deleted = await runCommand(
              { type: "deleteTask", input: { taskId: editingTask.id, now: new Date().toISOString() } },
              "任务已删除",
            );
            if (deleted) setEditingTaskId(null);
          }}
          onStopRecurrence={editingSeries ? async () => {
            const stopped = await runCommand(
              {
                type: "stopRecurrenceSeries",
                input: {
                  seriesId: editingSeries.id,
                  endDate: editingTask.occurrenceDate ?? editingTask.startDate,
                  now: new Date().toISOString(),
                },
              },
              "已停止后续重复",
            );
            if (stopped) setEditingTaskId(null);
          } : undefined}
        />
      ) : null}

      {notice ? (
        <div className="app-notice" role="status" data-testid="app-notice">
          <span>{notice.message}</span>
          {notice.receipt ? (
            <Button type="button" variant="ghost" size="sm" isDisabled={isUndoing} onPress={() => void handleUndo()}>
              撤销
            </Button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function TaskGroup({
  title,
  count,
  className = "",
  children,
}: {
  title: string;
  count: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`task-group ${className}`} aria-labelledby={`task-group-${title}`}>
      <h2 id={`task-group-${title}`}>{title}<span>{count}</span></h2>
      <div>{children}</div>
    </section>
  );
}

function TaskRow({
  item,
  focused,
  canFocus,
  focusDisabled,
  onFocus,
  onComplete,
  onEdit,
}: {
  item: DayPlanItem;
  focused: boolean;
  canFocus: boolean;
  focusDisabled: boolean;
  onFocus: (task: Task, focused: boolean) => Promise<boolean>;
  onComplete: (task: Task) => Promise<boolean>;
  onEdit: () => void;
}) {
  const { task } = item;
  const completed = task.status === "completed";
  const focusLabel = focused
    ? `移出今日重点：${task.title}`
    : `设为今日重点：${task.title}`;

  return (
    <article className={`day-task ${completed ? "day-task--completed" : ""} ${item.isOverdue ? "day-task--overdue" : ""}`}>
      <Button
        type="button"
        className="task-check"
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label={completed ? `恢复任务：${task.title}` : `完成任务：${task.title}`}
        onPress={() => void onComplete(task)}
      >
        {completed ? <Check size={17} /> : <Circle size={18} />}
      </Button>
      <Button type="button" className="task-main" variant="ghost" onPress={onEdit}>
        <strong>{task.title}</strong>
        <span>{taskMetadata(item)}</span>
      </Button>
      <div className="task-actions">
        {canFocus && !completed ? (
          <Button
            type="button"
            className={`task-focus ${focused ? "task-focus--active" : ""}`}
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={focusLabel}
            aria-describedby={!focused && focusDisabled ? "focus-limit-help" : undefined}
            isDisabled={!focused && focusDisabled}
            onPress={() => void onFocus(task, focused)}
          >
            <Star size={16} fill={focused ? "currentColor" : "none"} />
          </Button>
        ) : task.seriesId ? (
          <span className="task-repeat-mark" title="重复任务" aria-hidden="true"><Repeat2 size={15} /></span>
        ) : null}
        <Button type="button" className="task-edit" variant="ghost" size="sm" isIconOnly aria-label={`编辑任务：${task.title}`} onPress={onEdit}>
          <Edit3 size={16} />
        </Button>
      </div>
    </article>
  );
}

function PlannerLoading() {
  return (
    <main className="day-page">
      <div className="planner-loading" role="status">
        <RotateCcw className="animate-spin" size={20} aria-hidden="true" />
        正在打开今天的任务…
      </div>
    </main>
  );
}
