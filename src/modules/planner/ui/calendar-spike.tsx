"use client";

import FullCalendar from "@fullcalendar/react";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import type {
  EventContentArg,
  EventDropArg,
  EventInput,
  EventMountArg,
} from "@fullcalendar/core";
import interactionPlugin, {
  Draggable,
  type EventReceiveArg,
  type EventResizeDoneArg,
} from "@fullcalendar/interaction";
import timeGridPlugin from "@fullcalendar/timegrid";
import { AlertTriangle, CalendarDays, GripVertical } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { findOverlappingBlockIds } from "../domain/time-block";

type SpikeTask = {
  id: string;
  title: string;
  duration: string;
  durationLabel: string;
  tone: "amber" | "blue" | "green";
};

const INITIAL_TASKS: SpikeTask[] = [
  {
    id: "write-report",
    title: "写周报",
    duration: "01:00",
    durationLabel: "60 分钟",
    tone: "amber",
  },
  {
    id: "reply-email",
    title: "回复邮件",
    duration: "00:30",
    durationLabel: "30 分钟",
    tone: "blue",
  },
  {
    id: "organize-notes",
    title: "整理资料",
    duration: "00:45",
    durationLabel: "45 分钟",
    tone: "green",
  },
];

const toneClasses: Record<SpikeTask["tone"], string> = {
  amber: "task-card--amber",
  blue: "task-card--blue",
  green: "task-card--green",
};

function toTimeLabel(date: Date | null) {
  if (!date) {
    return "--:--";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function mutationMessage(title: string, action: string, start: Date | null) {
  return `${title} · ${action}至 ${toTimeLabel(start)}`;
}

function eventTimeText(start: Date | null, end: Date | null) {
  if (!start || !end) {
    return "";
  }

  return `${toTimeLabel(start)} – ${toTimeLabel(end)}`;
}

export function CalendarSpike() {
  const taskListRef = useRef<HTMLDivElement>(null);
  const [tasks, setTasks] = useState(INITIAL_TASKS);
  const [events, setEvents] = useState<EventInput[]>([]);
  const [lastMutation, setLastMutation] = useState(
    "等待操作：把左侧任务拖到右侧时间轴",
  );

  const conflictIds = useMemo(() => {
    return findOverlappingBlockIds(
      events.flatMap((event) => {
        const start = event.start ? new Date(event.start as string | Date) : null;
        const end = event.end ? new Date(event.end as string | Date) : null;

        return start && end
          ? [
              {
                id: String(event.id),
                start,
                end,
              },
            ]
          : [];
      }),
    );
  }, [events]);

  useEffect(() => {
    const container = taskListRef.current;

    if (!container) {
      return;
    }

    const draggable = new Draggable(container, {
      itemSelector: ".js-draggable-task",
      eventData(element) {
        return {
          id: element.dataset.taskId,
          title: element.dataset.taskTitle,
          duration: element.dataset.duration,
          extendedProps: {
            tone: element.dataset.tone,
          },
        };
      },
    });

    return () => draggable.destroy();
  }, []);

  function syncEvent(
    arg: EventReceiveArg | EventDropArg | EventResizeDoneArg,
    action: string,
  ) {
    const event = arg.event;

    if (!event.start || !event.end) {
      arg.revert();
      setLastMutation("操作已回滚：时间块缺少开始或结束时间");
      return;
    }

    setEvents((current) => {
      const nextEvent: EventInput = {
        id: event.id,
        title: event.title,
        start: event.start ?? undefined,
        end: event.end ?? undefined,
        extendedProps: event.extendedProps,
      };
      const withoutCurrent = current.filter((item) => item.id !== event.id);
      return [...withoutCurrent, nextEvent];
    });
    setLastMutation(mutationMessage(event.title, action, event.start));
  }

  function handleReceive(arg: EventReceiveArg) {
    syncEvent(arg, "已安排");
    setTasks((current) => current.filter((task) => task.id !== arg.event.id));
  }

  function handleDrop(arg: EventDropArg) {
    syncEvent(arg, "已移动");
  }

  function handleResize(arg: EventResizeDoneArg) {
    syncEvent(arg, "已调整");
  }

  function eventClassNames(arg: { event: { id: string } }) {
    const tone = String(
      events.find((event) => event.id === arg.event.id)?.extendedProps?.tone ??
        "amber",
    );

    return [
      `planner-event--${tone}`,
      conflictIds.has(arg.event.id) ? "planner-event--conflict" : "",
    ].filter(Boolean);
  }

  function eventContent(arg: EventContentArg) {
    const hasConflict = conflictIds.has(arg.event.id);

    return (
      <div className="event-content">
        <div className="event-content__topline">
          <span>{eventTimeText(arg.event.start, arg.event.end)}</span>
          {hasConflict ? <AlertTriangle aria-label="时间冲突" size={14} /> : null}
        </div>
        <strong>{arg.event.title}</strong>
      </div>
    );
  }

  function eventDidMount(arg: EventMountArg) {
    arg.el.dataset.eventId = arg.event.id;
  }

  return (
    <main className="min-h-screen bg-[var(--page-background)] px-4 py-6 text-[var(--ink)] sm:px-6 lg:px-10">
      <section className="mx-auto max-w-[1480px]">
        <header className="mb-6 flex flex-col gap-3 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="eyebrow">NewDay · Spike 01</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              时间轴交互探针
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)] sm:text-base">
              只验证外部拖入、15 分钟吸附、移动、拉伸与重叠警告；暂不接正式业务数据。
            </p>
          </div>
          <div className="status-chip" aria-live="polite">
            <span className="status-chip__dot" />
            <span data-testid="mutation-status">{lastMutation}</span>
          </div>
        </header>

        <div className="planner-shell">
          <aside className="task-panel" aria-label="待安排任务">
            <div className="task-panel__header">
              <div>
                <p className="eyebrow">待安排</p>
                <h2 className="mt-1 text-xl font-semibold">今天要做</h2>
              </div>
              <span className="counter" data-testid="scheduled-count">
                {events.length} / {INITIAL_TASKS.length}
              </span>
            </div>

            <div ref={taskListRef} className="mt-5 grid gap-3">
              {tasks.map((task) => (
                <article
                  key={task.id}
                  className={`js-draggable-task task-card ${toneClasses[task.tone]}`}
                  data-task-id={task.id}
                  data-task-title={task.title}
                  data-duration={task.duration}
                  data-tone={task.tone}
                  data-testid={`task-${task.id}`}
                >
                  <GripVertical className="task-card__grip" size={18} />
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium">{task.title}</h3>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      预计 {task.durationLabel}
                    </p>
                  </div>
                </article>
              ))}

              {tasks.length === 0 ? (
                <div className="empty-state">
                  <CalendarDays size={22} />
                  <p>全部任务都已放入时间轴。</p>
                </div>
              ) : null}
            </div>

            <div className="panel-note">
              <strong>探针规则</strong>
              <ul>
                <li>拖入后自动使用任务预计时长</li>
                <li>拖动和拉伸按 15 分钟吸附</li>
                <li>重叠允许，但双方显示警告</li>
              </ul>
            </div>
          </aside>

          <section className="calendar-panel" aria-label="当天时间轴">
            <FullCalendar
              plugins={[timeGridPlugin, interactionPlugin]}
              initialView="timeGridDay"
              initialDate="2026-09-01"
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
              eventResizableFromStart={false}
              height="auto"
              events={events}
              eventReceive={handleReceive}
              eventDrop={handleDrop}
              eventResize={handleResize}
              eventClassNames={eventClassNames}
              eventContent={eventContent}
              eventDidMount={eventDidMount}
              slotLabelFormat={{
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              }}
              eventTimeFormat={{
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              }}
            />
          </section>
        </div>
      </section>
    </main>
  );
}
