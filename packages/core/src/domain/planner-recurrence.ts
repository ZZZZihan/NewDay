import {
  eachDayOfInterval,
  format,
  getDaysInMonth,
  getISODay,
} from "date-fns";

import { parseLocalDate } from "./planner-date";
import {
  localDateSchema,
  type LocalDate,
  type RecurrenceSeries,
} from "./planner-model";

export function recurrenceOccurrenceKey(
  logicalSeriesId: string,
  occurrenceDate: LocalDate,
) {
  return `${logicalSeriesId}:${occurrenceDate}`;
}

export function recursOnDate(
  series: RecurrenceSeries,
  candidateDate: LocalDate,
) {
  const date = localDateSchema.parse(candidateDate);

  if (date < series.startDate) {
    return false;
  }

  if (series.effectiveEndDate !== null && date > series.effectiveEndDate) {
    return false;
  }

  if (series.end.kind === "onDate" && date > series.end.date) {
    return false;
  }

  if (series.excludedDates.includes(date)) {
    return false;
  }

  const parsedDate = parseLocalDate(date);

  switch (series.pattern.kind) {
    case "daily":
      return true;
    case "weekdays":
      return getISODay(parsedDate) <= 5;
    case "weekly":
      return series.pattern.weekdays.some(
        (weekday) => weekday === getISODay(parsedDate),
      );
    case "monthly":
      return (
        parsedDate.getDate() ===
        Math.min(series.pattern.dayOfMonth, getDaysInMonth(parsedDate))
      );
  }
}

export function recurrenceDatesInRange(
  series: RecurrenceSeries,
  rangeStart: LocalDate,
  rangeEnd: LocalDate,
) {
  const start = localDateSchema.parse(rangeStart);
  const end = localDateSchema.parse(rangeEnd);

  if (end < start) {
    return [];
  }

  return eachDayOfInterval({
    start: parseLocalDate(start),
    end: parseLocalDate(end),
  })
    .map((date) => format(date, "yyyy-MM-dd"))
    .filter((date) => recursOnDate(series, date));
}
