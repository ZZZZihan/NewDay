# NewDay Planning

NewDay helps one person keep daily work clear by showing tasks across simple calendar-day ranges, without hour-level scheduling.

## Language

**Task（任务）**:
Something the user intends to complete. A one-off task may remain visible across multiple days; a recurring occurrence is always a single-day task.
_Avoid_: Event, time block, schedule item

**Start Date（开始日期）**:
The first calendar day on which a task appears in the daily list.
_Avoid_: Start time, planned date

**Due Date（截止日期）**:
The final calendar day in a task's intended range. It is inclusive and cannot be earlier than the start date. An open task remains actionable after this date as overdue work.
_Avoid_: Expected date, end time

**Daily List（每日任务）**:
The tasks visible for the selected calendar day, grouped into today's focus, overdue, remaining open, and completed work where applicable.
_Avoid_: Timeline, day schedule, calendar view

**Overdue（逾期）**:
An open task whose due date is before the actual current date. Overdue work is projected into today's daily list without changing its original dates.
_Avoid_: Automatically rescheduled, expired

**Completed（已完成）**:
A task state indicating that no further action is currently required. Completion records both the instant and the local calendar date; the task remains associated with its original range or occurrence.
_Avoid_: Archived, deleted

**Recurring Series（重复系列）**:
A rule that describes repeated work from a start date, using daily, weekday, selected-weekday, or monthly recurrence, with an optional inclusive ending date.
_Avoid_: Multi-day task, custom interval

**Occurrence（重复实例）**:
A single-day task created for one nominal date in a recurring series. It can be completed, moved, edited, focused, or deleted independently without changing its identity.
_Avoid_: Copy, date range

**Today's Focus（今日重点）**:
Up to three open tasks highlighted for the actual current date. Focus is date-specific rather than a permanent task ranking.
_Avoid_: Priority rank, pinned task

**Reschedule（改期）**:
Changing a task's visible start and due dates. Rescheduling a recurring occurrence keeps its nominal occurrence identity and marks it as an exception.
_Avoid_: Recreate, carry over

**Undo（撤销）**:
A one-time, short-lived restoration of the latest eligible successful action. It restores the exact affected task, recurring-series, and focus state without replacing unrelated data.
_Avoid_: History, audit log

**Backup（备份）**:
A versioned JSON snapshot of tasks, recurring series, and focus records. Import validates the whole snapshot and replaces local planning data atomically; it does not merge.
_Avoid_: Sync, event log
