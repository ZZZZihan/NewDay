import { formatDayShort, parseLocalDate } from "@newday/core/domain/planner-date";
import type { DatedTask, DayPlanItem } from "@newday/core/domain/planner-model";

export function formatClockTime(date: Date | null, timeZone?: string) {
  if (!date) return "--:--";

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(date);
}

export function formatClockDate(date: Date | null, timeZone?: string) {
  if (!date) return "正在读取当前日期";

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone,
  }).format(date);
}

export function formatTaskRange(task: DatedTask) {
  if (task.startDate === task.endDate) return formatDayShort(task.startDate);

  const sameYear = task.startDate.slice(0, 4) === task.endDate.slice(0, 4);
  const start = sameYear
    ? formatDayShort(task.startDate)
    : formatYearDay(task.startDate);
  const end = sameYear ? formatDayShort(task.endDate) : formatYearDay(task.endDate);
  return `${start} – ${end}`;
}

export function formatYearDay(date: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parseLocalDate(date));
}

export function taskMetadata(item: DayPlanItem) {
  const { task, isOverdue } = item;
  const parts = [
    isOverdue ? `逾期 · 截止 ${formatDayShort(task.endDate)}` : formatTaskRange(task),
  ];

  if (task.seriesId) parts.push(task.isSeriesException ? "重复 · 已单独修改" : "重复");
  if (item.notion) {
    parts.push([item.notion.areaName, item.notion.projectName].filter(Boolean).join(" / ") || "Notion 联动");
    parts.push("只读");
  }
  return parts.join(" · ");
}
