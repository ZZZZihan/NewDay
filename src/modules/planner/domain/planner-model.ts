import { z } from "zod";

export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealCalendarDate, { message: "日期不是有效的日历日期" });
export const instantSchema = z.string().datetime({ offset: true });

export const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10_000).default(""),
  plannedDate: localDateSchema,
  status: z.enum(["open", "completed"]),
  estimatedMinutes: z.number().int().positive().max(24 * 60).nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  completedAt: instantSchema.nullable(),
});

export const timeBlockSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    date: localDateSchema,
    start: instantSchema,
    end: instantSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .refine((block) => new Date(block.start) < new Date(block.end), {
    message: "时间块结束时间必须晚于开始时间",
    path: ["end"],
  })
  .refine((block) => localDateForInstant(block.start) === block.date, {
    message: "时间块开始时间必须位于所属日期",
    path: ["start"],
  })
  .refine((block) => localDateForInstant(block.end) === block.date, {
    message: "时间块暂不支持跨越午夜",
    path: ["end"],
  });

export const plannerPreferencesSchema = z
  .object({
    id: z.literal("default"),
    timeZone: z.string().min(1),
    dayStartMinute: z.number().int().min(0).max(24 * 60 - 1),
    dayEndMinute: z.number().int().min(1).max(24 * 60),
    slotMinutes: z.number().int().positive().max(60),
    defaultBlockMinutes: z.number().int().positive().max(24 * 60),
  })
  .refine(
    (preferences) => preferences.dayEndMinute > preferences.dayStartMinute,
    {
      message: "每日结束时间必须晚于开始时间",
      path: ["dayEndMinute"],
    },
  );

export type Task = z.infer<typeof taskSchema>;
export type TimeBlock = z.infer<typeof timeBlockSchema>;
export type PlannerPreferences = z.infer<typeof plannerPreferencesSchema>;

export const DEFAULT_PLANNER_PREFERENCES: PlannerPreferences = {
  id: "default",
  timeZone: "local",
  dayStartMinute: 7 * 60,
  dayEndMinute: 23 * 60,
  slotMinutes: 15,
  defaultBlockMinutes: 30,
};

export type DayPlan = {
  date: string;
  tasks: Task[];
  timeBlocks: TimeBlock[];
  conflictingTimeBlockIds: Set<string>;
};

export function localDateForInstant(instant: string) {
  return instant.slice(0, 10);
}

function isRealCalendarDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
