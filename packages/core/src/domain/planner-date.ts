import { addDays, format, parseISO } from "date-fns";
import { zhCN } from "date-fns/locale";

export function todayKey(now = new Date()) {
  return format(now, "yyyy-MM-dd");
}

export function shiftDate(date: string, days: number) {
  return format(addDays(parseLocalDate(date), days), "yyyy-MM-dd");
}

export function formatDayHeading(date: string) {
  return format(parseLocalDate(date), "M 月 d 日 EEEE", { locale: zhCN });
}

export function formatDayShort(date: string) {
  return format(parseLocalDate(date), "M月d日", { locale: zhCN });
}

export function parseLocalDate(date: string) {
  return parseISO(`${date}T12:00:00`);
}

export function toLocalInstant(date: Date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60)
    .toString()
    .padStart(2, "0");
  const offsetRemainder = (absoluteOffset % 60).toString().padStart(2, "0");
  const local = format(date, "yyyy-MM-dd'T'HH:mm:ss.SSS");

  return `${local}${sign}${offsetHours}:${offsetRemainder}`;
}
