"use client";

import type {
  EventContentArg,
  EventDropArg,
  EventInput,
} from "@fullcalendar/core";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import interactionPlugin, {
  Draggable,
  type EventReceiveArg,
  type EventResizeDoneArg,
} from "@fullcalendar/interaction";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { useLiveQuery } from "dexie-react-hooks";
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Download,
  Edit3,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  createPlannerBackup,
  parsePlannerBackup,
  restorePlannerBackup,
  type PlannerBackup,
} from "../application/planner-backup";
import {
  executePlannerCommand,
  executePlannerCommands,
  type PlannerCommand,
} from "../application/planner-command";
import { plannerStore } from "../adapters/planner-client";
import {
  formatDayHeading,
  formatDayShort,
  shiftDate,
  toLocalInstant,
  todayKey,
} from "../domain/planner-date";
import {
  DEFAULT_PLANNER_PREFERENCES,
  type Task,
  type TimeBlock,
} from "../domain/planner-model";

function timeLabel(date: Date | null) {
  if (!date) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function timeInputValue(date: Date) {
  return `${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function estimateLabel(minutes: number | null) {
  if (!minutes) {
    return "未设置预计时长";
  }

  if (minutes < 60) {
    return `预计 ${minutes} 分钟`;
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0
    ? `预计 ${hours} 小时`
    : `预计 ${hours} 小时 ${remainder} 分钟`;
}

function durationInput(minutes: number | null) {
  const totalMinutes = minutes ?? DEFAULT_PLANNER_PREFERENCES.defaultBlockMinutes;
  const hours = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, "0");
  const remainder = (totalMinutes % 60).toString().padStart(2, "0");
  return `${hours}:${remainder}`;
}

function timeValueToMinutes(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);

  if (!match) {
    return null;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

function timeValueFromMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const remainder = (minutes % 60).toString().padStart(2, "0");
  return `${hours}:${remainder}`;
}

const STANDARD_BLOCK_MINUTES = [15, 30, 45, 60, 90, 120] as const;

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

const subscribeToHydration = () => () => undefined;

export function DayPlanner() {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const [dateOverride, setDateOverride] = useState<string | null>(null);
  const selectedDate = dateOverride ?? (hydrated ? todayKey() : null);
  const [quickTitle, setQuickTitle] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [undoCommands, setUndoCommands] = useState<readonly PlannerCommand[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const quickInputRef = useRef<HTMLInputElement>(null);
  const taskListRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setNotice(null);
      setUndoCommands([]);
    }, 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  function showNotice(message: string) {
    setNotice({ id: crypto.randomUUID(), message });
  }

  const queryDate = selectedDate ?? "1970-01-01";
  const dayPlan = useLiveQuery(
    () => plannerStore.getDayPlan(queryDate),
    [queryDate],
  );

  const blockByTaskId = useMemo(() => {
    const map = new Map<string, string[]>();

    for (const block of dayPlan?.timeBlocks ?? []) {
      map.set(block.taskId, [...(map.get(block.taskId) ?? []), block.id]);
    }

    return map;
  }, [dayPlan?.timeBlocks]);

  const taskById = useMemo(
    () => new Map((dayPlan?.tasks ?? []).map((task) => [task.id, task])),
    [dayPlan?.tasks],
  );

  const unscheduledTasks = useMemo(
    () =>
      (dayPlan?.tasks ?? []).filter(
        (task) => task.status === "open" && !blockByTaskId.has(task.id),
      ),
    [blockByTaskId, dayPlan?.tasks],
  );

  const completedTasks = useMemo(
    () => (dayPlan?.tasks ?? []).filter((task) => task.status === "completed"),
    [dayPlan?.tasks],
  );

  const openTasks = useMemo(
    () => (dayPlan?.tasks ?? []).filter((task) => task.status === "open"),
    [dayPlan?.tasks],
  );

  useEffect(() => {
    const container = taskListRef.current;

    if (!container) {
      return;
    }

    const draggable = new Draggable(container, {
      itemSelector: ".js-planner-task",
      eventData(element) {
        return {
          id: crypto.randomUUID(),
          title: element.dataset.taskTitle,
          duration: element.dataset.duration ?? "00:30",
          extendedProps: {
            taskId: element.dataset.taskId,
          },
        };
      },
    });

    return () => draggable.destroy();
  }, [selectedDate]);

  const events = useMemo<EventInput[]>(
    () =>
      (dayPlan?.timeBlocks ?? []).map((block) => {
        const task = taskById.get(block.taskId);
        return {
          id: block.id,
          title: task?.title ?? "已删除任务",
          start: block.start,
          end: block.end,
          editable: task?.status === "open",
          extendedProps: {
            taskId: block.taskId,
            completed: task?.status === "completed",
            conflict: dayPlan?.conflictingTimeBlockIds.has(block.id) ?? false,
          },
        };
      }),
    [dayPlan?.conflictingTimeBlockIds, dayPlan?.timeBlocks, taskById],
  );

  const editingTask = editingTaskId ? taskById.get(editingTaskId) : undefined;
  const editingTimeBlock = editingTask
    ? dayPlan?.timeBlocks.find((block) => block.taskId === editingTask.id)
    : undefined;

  async function runCommands(
    commands: readonly PlannerCommand[],
    successMessage: string,
    inverseCommands: readonly PlannerCommand[] = [],
  ) {
    setIsSaving(true);

    try {
      await executePlannerCommands(plannerStore, commands);
      showNotice(successMessage);
      setUndoCommands(inverseCommands);
      return true;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "操作失败，请重试");
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function runCommand(
    command: Parameters<typeof executePlannerCommand>[1],
    successMessage: string,
    inverseCommands: readonly PlannerCommand[] = [],
  ) {
    return runCommands([command], successMessage, inverseCommands);
  }

  async function handleUndo() {
    if (undoCommands.length === 0) {
      return;
    }

    const commands = undoCommands;
    setUndoCommands([]);
    await runCommands(commands, "已撤销");
  }

  async function handleExport() {
    setIsSaving(true);

    try {
      const backup = await createPlannerBackup(plannerStore);
      downloadBackup(backup);
      setUndoCommands([]);
      showNotice(`已导出 ${backup.tasks.length} 项任务`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "导出失败，请重试");
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

      if (!confirmed) {
        return;
      }

      const safetyBackup = await createPlannerBackup(plannerStore);
      downloadBackup(safetyBackup, "newday-before-import");
      await restorePlannerBackup(plannerStore, source);
      setEditingTaskId(null);
      setUndoCommands([]);
      showNotice(`导入完成：${candidate.tasks.length} 项任务`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "导入失败，请检查文件");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCarryOver() {
    if (!selectedDate || openTasks.length === 0) {
      return;
    }

    const destinationDate = shiftDate(selectedDate, 1);
    const now = new Date().toISOString();
    const commands: PlannerCommand[] = openTasks.map((task) => ({
      type: "carryOverTask",
      input: {
        taskId: task.id,
        destinationDate,
        now,
      },
    }));
    const inverseCommands: PlannerCommand[] = [];

    for (const task of openTasks) {
      inverseCommands.push({
        type: "moveTaskToDate",
        input: {
          taskId: task.id,
          destinationDate: selectedDate,
          now,
        },
      });

      for (const block of dayPlan?.timeBlocks.filter(
        (candidate) => candidate.taskId === task.id,
      ) ?? []) {
        inverseCommands.push({
          type: "scheduleTask",
          input: {
            id: block.id,
            taskId: task.id,
            start: block.start,
            end: block.end,
            now,
          },
        });
      }
    }

    await runCommands(
      commands,
      `已将 ${openTasks.length} 项任务移到${formatDayShort(destinationDate)}`,
      inverseCommands,
    );
  }

  async function handleQuickAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = quickTitle.trim();

    if (!selectedDate || !title) {
      return;
    }

    setQuickTitle("");
    quickInputRef.current?.focus();
    const saved = await runCommand(
      {
        type: "createTask",
        input: {
          id: crypto.randomUUID(),
          title,
          plannedDate: selectedDate,
          estimatedMinutes: null,
          now: new Date().toISOString(),
        },
      },
      `已添加“${title}”`,
    );

    if (!saved) {
      setQuickTitle(title);
    }
  }

  async function handleReceive(arg: EventReceiveArg) {
    const taskId = String(arg.event.extendedProps.taskId);

    if (!arg.event.start || !arg.event.end || !taskId) {
      arg.revert();
      showNotice("无法创建时间块，操作已回滚");
      return;
    }

    const saved = await runCommand(
      {
        type: "scheduleTask",
        input: {
          id: arg.event.id,
          taskId,
          start: toLocalInstant(arg.event.start),
          end: toLocalInstant(arg.event.end),
          now: new Date().toISOString(),
        },
      },
      `已安排“${arg.event.title}”`,
      [
        {
          type: "unscheduleTask",
          input: { taskId },
        },
      ],
    );

    if (!saved) {
      arg.revert();
    }
  }

  async function handleEventChange(
    type: "moveTimeBlock" | "resizeTimeBlock",
    arg: EventDropArg | EventResizeDoneArg,
  ) {
    if (!arg.event.start || !arg.event.end) {
      arg.revert();
      showNotice("时间块缺少开始或结束时间，操作已回滚");
      return;
    }

    const saved = await runCommand(
      {
        type,
        input: {
          timeBlockId: arg.event.id,
          start: toLocalInstant(arg.event.start),
          end: toLocalInstant(arg.event.end),
          now: new Date().toISOString(),
        },
      },
      type === "moveTimeBlock" ? "时间块已移动" : "时长已调整",
      arg.oldEvent.start && arg.oldEvent.end
        ? [
            {
              type: "moveTimeBlock",
              input: {
                timeBlockId: arg.event.id,
                start: toLocalInstant(arg.oldEvent.start),
                end: toLocalInstant(arg.oldEvent.end),
                now: new Date().toISOString(),
              },
            },
          ]
        : [],
    );

    if (!saved) {
      arg.revert();
    }
  }

  async function handleComplete(task: Task) {
    return runCommand(
      {
        type: task.status === "completed" ? "reopenTask" : "completeTask",
        input: {
          taskId: task.id,
          now: new Date().toISOString(),
        },
      },
      task.status === "completed" ? "任务已恢复" : "任务已完成",
      [
        {
          type: task.status === "completed" ? "completeTask" : "reopenTask",
          input: {
            taskId: task.id,
            now: new Date().toISOString(),
          },
        },
      ],
    );
  }

  function moveDate(offset: number) {
    if (selectedDate) {
      setDateOverride(shiftDate(selectedDate, offset));
      setEditingTaskId(null);
    }
  }

  function eventContent(arg: EventContentArg) {
    const completed = Boolean(arg.event.extendedProps.completed);
    const conflict = Boolean(arg.event.extendedProps.conflict);

    return (
      <div className="day-event-content">
        <div className="day-event-content__time">
          <span>
            {timeLabel(arg.event.start)} – {timeLabel(arg.event.end)}
          </span>
          {conflict ? <span className="conflict-badge">冲突</span> : null}
        </div>
        <strong className={completed ? "line-through opacity-60" : ""}>
          {arg.event.title}
        </strong>
      </div>
    );
  }

  if (!selectedDate) {
    return <PlannerLoading />;
  }

  const selectedIsToday = selectedDate === todayKey();

  return (
    <main className="day-page" aria-busy={isSaving}>
      <div className="day-page__inner">
        <header className="app-header">
          <div className="brand-lockup">
            <span className="brand-mark">N</span>
            <div>
              <p className="brand-name">NewDay</p>
              <p className="brand-caption">把事情放进时间里</p>
            </div>
          </div>

          <div className="header-actions">
            <div className="backup-actions" aria-label="数据备份">
              <button
                type="button"
                className="backup-button"
                onClick={() => void handleExport()}
                disabled={isSaving}
                aria-label="导出数据"
              >
                <Download size={14} />
                <span>导出</span>
              </button>
              <button
                type="button"
                className="backup-button"
                onClick={() => importInputRef.current?.click()}
                disabled={isSaving}
                aria-label="导入数据"
              >
                <Upload size={14} />
                <span>导入</span>
              </button>
              <input
                ref={importInputRef}
                className="backup-input"
                data-testid="import-input"
                type="file"
                accept="application/json,.json"
                disabled={isSaving}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) {
                    void handleImport(file);
                  }
                }}
              />
            </div>

            <nav className="date-navigation" aria-label="日期导航">
              <button
                className="icon-button"
                type="button"
                aria-label="前一天"
                onClick={() => moveDate(-1)}
              >
                <ChevronLeft size={18} />
              </button>
              <label className="date-picker-label">
                <CalendarClock size={16} />
                <input
                  aria-label="选择日期"
                  type="date"
                  value={selectedDate}
                  onChange={(event) => {
                    if (event.target.value) {
                      setDateOverride(event.target.value);
                    }
                  }}
                />
              </label>
              <button
                className="icon-button"
                type="button"
                aria-label="后一天"
                onClick={() => moveDate(1)}
              >
                <ChevronRight size={18} />
              </button>
              <button
                className="today-button"
                type="button"
                disabled={selectedIsToday}
                onClick={() => setDateOverride(todayKey())}
              >
                今天
              </button>
            </nav>
          </div>
        </header>

        <section className="day-heading">
          <div>
            <p className="eyebrow">{selectedIsToday ? "今天" : formatDayShort(selectedDate)}</p>
            <h1>{formatDayHeading(selectedDate)}</h1>
          </div>
          <div className="day-summary" aria-label="当日计划摘要">
            <span>{dayPlan?.tasks.length ?? 0} 项任务</span>
            <span>{events.length} 个时间块</span>
            <span>{completedTasks.length} 项完成</span>
          </div>
        </section>

        <div className="day-workspace">
          <aside className="day-sidebar" aria-label="当日任务">
            <form className="quick-add" onSubmit={handleQuickAdd}>
              <label htmlFor="quick-task">快速添加任务</label>
              <div className="quick-add__row">
                <input
                  ref={quickInputRef}
                  id="quick-task"
                  data-testid="quick-task-input"
                  value={quickTitle}
                  onChange={(event) => setQuickTitle(event.target.value)}
                  placeholder="写下今天要完成的事情…"
                  autoComplete="off"
                />
                <button
                  type="submit"
                  aria-label="添加任务"
                  disabled={!quickTitle.trim() || isSaving}
                >
                  <Plus size={18} />
                </button>
              </div>
            </form>

            <section className="task-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">待安排</p>
                  <h2>还没有具体时间</h2>
                </div>
                <span>{unscheduledTasks.length}</span>
              </div>

              <div
                ref={taskListRef}
                className="day-task-list"
                data-testid="unscheduled-list"
              >
                {unscheduledTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onComplete={handleComplete}
                    onEdit={() => setEditingTaskId(task.id)}
                  />
                ))}

                {dayPlan && unscheduledTasks.length === 0 ? (
                  <div className="task-empty">
                    <Clock3 size={20} />
                    <p>没有待安排任务</p>
                    <span>新任务会先出现在这里。</span>
                  </div>
                ) : null}
              </div>
            </section>

            {completedTasks.length > 0 ? (
              <details className="completed-section">
                <summary>已完成 · {completedTasks.length}</summary>
                <div className="completed-list">
                  {completedTasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onComplete={handleComplete}
                      onEdit={() => setEditingTaskId(task.id)}
                    />
                  ))}
                </div>
              </details>
            ) : null}

            {openTasks.length > 0 ? (
              <div className="day-closeout">
                <div>
                  <p>今天做不完？</p>
                  <span>时间块会清除，任务回到下一天的待安排。</span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCarryOver()}
                  disabled={isSaving}
                >
                  {selectedIsToday ? "未完成移到明天" : "未完成移到下一天"}
                  <ChevronRight size={14} />
                </button>
              </div>
            ) : null}
          </aside>

          <section className="day-timeline" aria-label="当天时间轴">
            <div className="timeline-heading">
              <div>
                <p className="eyebrow">时间安排</p>
                <h2>当天时间轴</h2>
              </div>
              <p>07:00 – 23:00 · 15 分钟粒度</p>
            </div>

            <FullCalendar
              key={selectedDate}
              plugins={[timeGridPlugin, interactionPlugin]}
              initialView="timeGridDay"
              initialDate={selectedDate}
              locale={zhCnLocale}
              timeZone="local"
              headerToolbar={false}
              allDaySlot={false}
              slotMinTime="07:00:00"
              slotMaxTime="23:00:00"
              slotDuration="00:15:00"
              slotLabelInterval="01:00:00"
              snapDuration="00:15:00"
              scrollTime="08:00:00"
              nowIndicator
              editable
              droppable
              eventOverlap
              height="auto"
              events={events}
              eventReceive={(arg) => void handleReceive(arg)}
              eventDrop={(arg) => void handleEventChange("moveTimeBlock", arg)}
              eventResize={(arg) => void handleEventChange("resizeTimeBlock", arg)}
              eventContent={eventContent}
              eventClassNames={(arg) => [
                "day-event",
                arg.event.extendedProps.completed ? "day-event--completed" : "",
                arg.event.extendedProps.conflict ? "day-event--conflict" : "",
              ]}
              eventClick={(arg) => {
                const taskId = String(arg.event.extendedProps.taskId);
                if (taskById.has(taskId)) {
                  setEditingTaskId(taskId);
                }
              }}
              slotLabelFormat={{
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              }}
            />
          </section>
        </div>
      </div>

      {editingTask ? (
        <TaskEditor
          key={editingTask.id}
          task={editingTask}
          timeBlock={editingTimeBlock}
          selectedDate={selectedDate}
          busy={isSaving}
          onClose={() => setEditingTaskId(null)}
          onSave={async (values) => {
            const now = new Date().toISOString();
            const commands: PlannerCommand[] = [
              {
                type: "updateTask",
                input: {
                  taskId: editingTask.id,
                  title: values.title,
                  notes: values.notes,
                  estimatedMinutes: values.estimatedMinutes,
                  now,
                },
              },
            ];
            const inverseCommands: PlannerCommand[] = [
              {
                type: "updateTask",
                input: {
                  taskId: editingTask.id,
                  title: editingTask.title,
                  notes: editingTask.notes,
                  estimatedMinutes: editingTask.estimatedMinutes,
                  now,
                },
              },
            ];

            if (values.startTime) {
              const start = new Date(`${selectedDate}T${values.startTime}:00`);
              const end = new Date(
                start.getTime() + values.blockMinutes * 60 * 1000,
              );
              const timingChanged =
                !editingTimeBlock ||
                new Date(editingTimeBlock.start).getTime() !== start.getTime() ||
                new Date(editingTimeBlock.end).getTime() !== end.getTime();

              if (timingChanged) {
                const timeBlockId = editingTimeBlock?.id ?? crypto.randomUUID();
                commands.push(
                  editingTimeBlock
                    ? {
                        type: "moveTimeBlock",
                        input: {
                          timeBlockId,
                          start: toLocalInstant(start),
                          end: toLocalInstant(end),
                          now,
                        },
                      }
                    : {
                        type: "scheduleTask",
                        input: {
                          id: timeBlockId,
                          taskId: editingTask.id,
                          start: toLocalInstant(start),
                          end: toLocalInstant(end),
                          now,
                        },
                      },
                );
                inverseCommands.unshift(
                  editingTimeBlock
                    ? {
                        type: "moveTimeBlock",
                        input: {
                          timeBlockId,
                          start: editingTimeBlock.start,
                          end: editingTimeBlock.end,
                          now,
                        },
                      }
                    : {
                        type: "unscheduleTask",
                        input: { taskId: editingTask.id },
                      },
                );
              }
            } else if (editingTimeBlock) {
              commands.push({
                type: "unscheduleTask",
                input: { taskId: editingTask.id },
              });
              inverseCommands.unshift({
                type: "scheduleTask",
                input: {
                  id: editingTimeBlock.id,
                  taskId: editingTask.id,
                  start: editingTimeBlock.start,
                  end: editingTimeBlock.end,
                  now,
                },
              });
            }

            const saved = await runCommands(
              commands,
              "任务已保存",
              inverseCommands,
            );
            if (saved) {
              setEditingTaskId(null);
            }
          }}
          scheduled={Boolean(editingTimeBlock)}
          onToggleComplete={async () => {
            const saved = await handleComplete(editingTask);
            if (saved) {
              setEditingTaskId(null);
            }
          }}
          onUnschedule={async () => {
            const saved = await runCommand(
              {
                type: "unscheduleTask",
                input: { taskId: editingTask.id },
              },
              "任务已移回待安排",
              editingTimeBlock
                ? [
                    {
                      type: "scheduleTask",
                      input: {
                        id: editingTimeBlock.id,
                        taskId: editingTask.id,
                        start: editingTimeBlock.start,
                        end: editingTimeBlock.end,
                        now: new Date().toISOString(),
                      },
                    },
                  ]
                : [],
            );
            if (saved) {
              setEditingTaskId(null);
            }
          }}
          onDelete={async () => {
            if (!window.confirm(`删除“${editingTask.title}”？此操作无法撤销。`)) {
              return;
            }

            const deleted = await runCommand(
              {
                type: "deleteTask",
                input: { taskId: editingTask.id },
              },
              "任务已删除",
            );
            if (deleted) {
              setEditingTaskId(null);
            }
          }}
        />
      ) : null}

      {notice ? (
        <div className="app-notice" role="status" data-testid="app-notice">
          <span>{notice.message}</span>
          {undoCommands.length > 0 ? (
            <button type="button" onClick={() => void handleUndo()}>
              撤销
            </button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function TaskRow({
  task,
  onComplete,
  onEdit,
}: {
  task: Task;
  onComplete: (task: Task) => Promise<boolean>;
  onEdit: () => void;
}) {
  const completed = task.status === "completed";

  return (
    <article
      className={`day-task ${completed ? "day-task--completed" : ""} ${completed ? "" : "js-planner-task"}`}
      data-task-id={task.id}
      data-task-title={task.title}
      data-duration={durationInput(task.estimatedMinutes)}
    >
      <button
        type="button"
        className="task-check"
        aria-label={completed ? `恢复任务：${task.title}` : `完成任务：${task.title}`}
        onClick={() => void onComplete(task)}
      >
        {completed ? <Check size={15} /> : <Circle size={15} />}
      </button>
      <button type="button" className="task-main" onClick={onEdit}>
        <strong>{task.title}</strong>
        <span>{estimateLabel(task.estimatedMinutes)}</span>
      </button>
      <button
        type="button"
        className="task-edit"
        aria-label={`编辑任务：${task.title}`}
        onClick={onEdit}
      >
        <Edit3 size={15} />
      </button>
    </article>
  );
}

function TaskEditor({
  task,
  timeBlock,
  selectedDate,
  busy,
  onClose,
  onSave,
  scheduled,
  onToggleComplete,
  onUnschedule,
  onDelete,
}: {
  task: Task;
  timeBlock?: TimeBlock;
  selectedDate: string;
  busy: boolean;
  onClose: () => void;
  onSave: (values: {
    title: string;
    notes: string;
    estimatedMinutes: number | null;
    startTime: string | null;
    blockMinutes: number;
  }) => Promise<void>;
  scheduled: boolean;
  onToggleComplete: () => Promise<void>;
  onUnschedule: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [estimatedMinutes, setEstimatedMinutes] = useState(
    task.estimatedMinutes?.toString() ?? "",
  );
  const estimateOptions = useMemo(() => {
    const current = Number(estimatedMinutes);
    return [...new Set([...STANDARD_BLOCK_MINUTES, current])]
      .filter((minutes) => minutes > 0)
      .sort((left, right) => left - right);
  }, [estimatedMinutes]);
  const existingBlockMinutes = timeBlock
    ? Math.round(
        (new Date(timeBlock.end).getTime() - new Date(timeBlock.start).getTime()) /
          60_000,
      )
    : null;
  const originalStartTime = timeBlock
    ? timeInputValue(new Date(timeBlock.start))
    : "";
  const [startTime, setStartTime] = useState(originalStartTime);
  const [blockMinutes, setBlockMinutes] = useState(
    (
      existingBlockMinutes ??
      task.estimatedMinutes ??
      DEFAULT_PLANNER_PREFERENCES.defaultBlockMinutes
    ).toString(),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const timingLocked = task.status === "completed";
  const durationOptions = useMemo(() => {
    const current = Number(blockMinutes);
    return [...new Set([...STANDARD_BLOCK_MINUTES, current])]
      .filter((minutes) => minutes > 0)
      .sort((left, right) => left - right);
  }, [blockMinutes]);
  const latestStartTime = timeValueFromMinutes(
    Math.max(
      DEFAULT_PLANNER_PREFERENCES.dayStartMinute,
      DEFAULT_PLANNER_PREFERENCES.dayEndMinute - Number(blockMinutes),
    ),
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const timingChanged =
      startTime !== originalStartTime ||
      Number(blockMinutes) !== existingBlockMinutes;

    if (startTime && timingChanged) {
      const startMinute = timeValueToMinutes(startTime);
      const duration = Number(blockMinutes);
      const aligned =
        startMinute !== null &&
        startMinute % DEFAULT_PLANNER_PREFERENCES.slotMinutes === 0 &&
        duration % DEFAULT_PLANNER_PREFERENCES.slotMinutes === 0;
      const withinVisibleDay =
        startMinute !== null &&
        startMinute >= DEFAULT_PLANNER_PREFERENCES.dayStartMinute &&
        startMinute + duration <= DEFAULT_PLANNER_PREFERENCES.dayEndMinute;

      if (!aligned || !withinVisibleDay) {
        setFormError("时间块需按 15 分钟安排，并完整位于 07:00–23:00。");
        return;
      }
    }

    await onSave({
      title: title.trim(),
      notes: notes.trim(),
      estimatedMinutes: estimatedMinutes ? Number(estimatedMinutes) : null,
      startTime: startTime || null,
      blockMinutes: Number(blockMinutes),
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="task-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="task-dialog__header">
          <div>
            <p className="eyebrow">任务详情</p>
            <h2 id="task-dialog-title">编辑任务</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form noValidate onSubmit={handleSubmit}>
          <label className="field-label">
            标题
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={200}
              autoFocus
            />
          </label>

          <label className="field-label">
            预计时长
            <select
              value={estimatedMinutes}
              onChange={(event) => setEstimatedMinutes(event.target.value)}
            >
              <option value="">未设置</option>
              {estimateOptions.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes < 60
                    ? `${minutes} 分钟`
                    : minutes % 60 === 0
                      ? `${minutes / 60} 小时`
                      : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`}
                </option>
              ))}
            </select>
          </label>

          <div className="schedule-fields">
            <label className="field-label">
              开始时间（可选）
              <input
                type="time"
                min={timeValueFromMinutes(
                  DEFAULT_PLANNER_PREFERENCES.dayStartMinute,
                )}
                max={latestStartTime}
                step={DEFAULT_PLANNER_PREFERENCES.slotMinutes * 60}
                value={startTime}
                disabled={timingLocked}
                onChange={(event) => {
                  setStartTime(event.target.value);
                  setFormError(null);
                }}
              />
            </label>

            <label className="field-label">
              时间块时长
              <select
                value={blockMinutes}
                onChange={(event) => {
                  setBlockMinutes(event.target.value);
                  setFormError(null);
                }}
                disabled={!startTime || timingLocked}
              >
                {durationOptions.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes < 60
                      ? `${minutes} 分钟`
                      : minutes % 60 === 0
                        ? `${minutes / 60} 小时`
                        : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="schedule-hint">
            {timingLocked
              ? "已完成任务需先恢复，才能调整时间。"
              : startTime
                ? `${formatDayShort(selectedDate)} ${startTime}，保存后同步到时间轴。`
                : "不设置开始时间时，任务保留在待安排列表。"}
          </p>
          {formError ? (
            <p className="form-error" role="alert">
              {formError}
            </p>
          ) : null}

          <label className="field-label">
            备注
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={5}
              placeholder="补充上下文、完成标准或相关信息…"
            />
          </label>

          <div className="task-dialog__actions">
            <div className="task-dialog__destructive-actions">
              <button
                className="danger-button"
                type="button"
                disabled={busy}
                onClick={() => void onDelete()}
              >
                <Trash2 size={16} />
                删除
              </button>
              {scheduled ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void onUnschedule()}
                >
                  <RotateCcw size={16} />
                  {task.status === "completed" ? "移除时间块" : "移回待安排"}
                </button>
              ) : null}
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => void onToggleComplete()}
              >
                {task.status === "completed" ? (
                  <RotateCcw size={16} />
                ) : (
                  <Check size={16} />
                )}
                {task.status === "completed" ? "恢复任务" : "标记完成"}
              </button>
            </div>
            <div>
              <button className="secondary-button" type="button" onClick={onClose}>
                取消
              </button>
              <button className="primary-button" type="submit" disabled={busy || !title.trim()}>
                保存
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

function PlannerLoading() {
  return (
    <main className="day-page">
      <div className="planner-loading">
        <RotateCcw className="animate-spin" size={20} />
        正在打开今天的计划…
      </div>
    </main>
  );
}
