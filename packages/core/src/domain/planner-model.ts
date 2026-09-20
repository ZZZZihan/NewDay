import { z } from "zod";

export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealCalendarDate, { message: "日期不是有效的日历日期" });
export const instantSchema = z.string().datetime({ offset: true });

export type LocalDate = z.infer<typeof localDateSchema>;
export type Instant = z.infer<typeof instantSchema>;

export const isoWeekdaySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);
export type IsoWeekday = z.infer<typeof isoWeekdaySchema>;

const weeklyRecurrencePatternSchema = z
  .object({
    kind: z.literal("weekly"),
    weekdays: z.array(isoWeekdaySchema).min(1),
  })
  .superRefine((pattern, context) => {
    for (let index = 1; index < pattern.weekdays.length; index += 1) {
      if (pattern.weekdays[index] <= pattern.weekdays[index - 1]) {
        context.addIssue({
          code: "custom",
          message: "每周重复日期必须按 ISO 星期顺序排列且不能重复",
          path: ["weekdays", index],
        });
        return;
      }
    }
  });

export const recurrencePatternSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily") }),
  z.object({ kind: z.literal("weekdays") }),
  weeklyRecurrencePatternSchema,
  z.object({
    kind: z.literal("monthly"),
    dayOfMonth: z.number().int().min(1).max(31),
  }),
]);

export const recurrenceEndSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("never") }),
  z.object({ kind: z.literal("onDate"), date: localDateSchema }),
]);

export const recurrenceSeriesSchema = z
  .object({
    id: z.string().min(1),
    logicalSeriesId: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    notes: z.string().max(10_000).default(""),
    startDate: localDateSchema,
    effectiveEndDate: localDateSchema.nullable(),
    pattern: recurrencePatternSchema,
    end: recurrenceEndSchema,
    excludedDates: z.array(localDateSchema).default([]),
    disabled: z.boolean().optional(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .superRefine((series, context) => {
    if (series.end.kind === "onDate" && series.end.date < series.startDate) {
      context.addIssue({
        code: "custom",
        message: "重复结束日期不能早于开始日期",
        path: ["end"],
      });
    }

    if (series.effectiveEndDate !== null && series.effectiveEndDate < series.startDate) {
      context.addIssue({
        code: "custom",
        message: "规则段结束日期不能早于开始日期",
        path: ["effectiveEndDate"],
      });
    }

    if (
      series.effectiveEndDate !== null &&
      series.end.kind === "onDate" &&
      series.end.date < series.effectiveEndDate
    ) {
      context.addIssue({
        code: "custom",
        message: "重复结束日期不能早于规则段结束日期",
        path: ["end"],
      });
    }
  });

export const focusRecordSchema = z.object({
  id: z.string().min(1),
  date: localDateSchema,
  taskId: z.string().min(1),
  focusedAt: instantSchema,
});

export const taskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    notes: z.string().max(10_000).default(""),
    startDate: localDateSchema.nullable(),
    endDate: localDateSchema.nullable(),
    status: z.enum(["open", "completed"]),
    createdAt: instantSchema,
    updatedAt: instantSchema,
    completedAt: instantSchema.nullable(),
    completedOn: localDateSchema.nullable().default(null),
    seriesId: z.string().min(1).optional(),
    logicalSeriesId: z.string().min(1).optional(),
    occurrenceDate: localDateSchema.optional(),
    occurrenceKey: z.string().min(1).optional(),
    isSeriesException: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .superRefine((task, context) => {
    if ((task.startDate === null) !== (task.endDate === null)) {
      context.addIssue({
        code: "custom",
        message: "任务的开始和结束日期必须同时为空或同时填写",
        path: ["endDate"],
      });
    }
    if (task.startDate !== null && task.endDate !== null && task.endDate < task.startDate) {
      context.addIssue({
        code: "custom",
        message: "截止日期不能早于开始日期",
        path: ["endDate"],
      });
    }

    if (task.status === "open") {
      if (task.completedAt !== null) {
        context.addIssue({
          code: "custom",
          message: "未完成任务不能包含完成时间",
          path: ["completedAt"],
        });
      }

      if (task.completedOn !== null) {
        context.addIssue({
          code: "custom",
          message: "未完成任务不能包含完成日期",
          path: ["completedOn"],
        });
      }
    } else if (task.completedAt === null && task.completedOn !== null) {
      context.addIssue({
        code: "custom",
        message: "完成日期不能缺少对应的完成时间",
        path: ["completedAt"],
      });
    }

    const recurrenceMetadata = [
      task.seriesId,
      task.logicalSeriesId,
      task.occurrenceDate,
      task.occurrenceKey,
      task.isSeriesException,
    ];
    const recurrenceFieldCount = recurrenceMetadata.filter(
      (value) => value !== undefined,
    ).length;

    if (recurrenceFieldCount !== 0 && recurrenceFieldCount !== recurrenceMetadata.length) {
      context.addIssue({
        code: "custom",
        message: "重复任务实例元数据必须同时提供",
        path: ["seriesId"],
      });
      return;
    }

    if (recurrenceFieldCount === recurrenceMetadata.length) {
      if (task.occurrenceKey !== `${task.logicalSeriesId}:${task.occurrenceDate}`) {
        context.addIssue({
          code: "custom",
          message: "重复任务实例键必须匹配逻辑系列和名义日期",
          path: ["occurrenceKey"],
        });
      }

      if (task.startDate === null || task.endDate === null || task.startDate !== task.endDate) {
        context.addIssue({
          code: "custom",
          message: "重复任务实例必须是单日任务",
          path: ["endDate"],
        });
      }

      if (
        task.isSeriesException === false &&
        (task.startDate !== task.occurrenceDate || task.endDate !== task.occurrenceDate)
      ) {
        context.addIssue({
          code: "custom",
          message: "未修改的重复任务实例日期必须与名义日期一致",
          path: ["occurrenceDate"],
        });
      }
    }
  });

export type RecurrencePattern = z.infer<typeof recurrencePatternSchema>;
export type RecurrenceEnd = z.infer<typeof recurrenceEndSchema>;
export type RecurrenceSeries = z.infer<typeof recurrenceSeriesSchema>;
export type FocusRecord = z.infer<typeof focusRecordSchema>;
export type Task = z.infer<typeof taskSchema>;
export type DatedTask = Task & { startDate: LocalDate; endDate: LocalDate };
export function hasTaskDates(task: Task): task is DatedTask {
  return task.startDate !== null && task.endDate !== null;
}
export type NotionTaskAttribution = {
  workspaceId: string;
  url: string | null;
  areaName: string | null;
  projectName: string | null;
  projectUrl: string | null;
};

export type DayPlanItem = {
  task: DatedTask;
  isOverdue: boolean;
  notion?: NotionTaskAttribution;
};

export type DayPlan = {
  selectedDate: LocalDate;
  asOfDate: LocalDate;
  isToday: boolean;
  focus: DayPlanItem[];
  overdue: DayPlanItem[];
  open: DayPlanItem[];
  completed: DayPlanItem[];
  counts: {
    open: number;
    completed: number;
    overdue: number;
    focus: number;
  };
};

function isRealCalendarDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
