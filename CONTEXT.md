# NewDay Planning

NewDay helps one person turn the work they intend to do on a given day into a realistic, time-blocked day plan.

## Language

**Task（任务）**:
Something the user intends to complete. A task may belong to a day and may have an estimated duration, but it does not require a specific start or end time.
_Avoid_: Plan item, schedule item, event

**Time Block（时间块）**:
A reserved interval on the timeline associated with a task. Removing a time block makes the task unscheduled without deleting the task.
_Avoid_: Task, calendar event

**Day Plan（当日计划）**:
The tasks assigned to one calendar date together with their time blocks.
_Avoid_: Calendar, schedule

**Unscheduled（待安排）**:
A task in the selected day plan that is incomplete and has no time block.
_Avoid_: Inbox, backlog

**Conflict（时间冲突）**:
Two time blocks whose occupied intervals overlap. Conflicts are allowed but must be made visible to the user.
_Avoid_: Invalid schedule

**Carry Over（移到明天）**:
Moving an incomplete task to the next calendar date while removing its existing time blocks, so it becomes unscheduled on the destination day.
_Avoid_: Automatic recurrence, copy

**Planner Command（计划命令）**:
A validated request to change planning state. UI interactions, imports, and future LLM suggestions must enter the application through commands rather than writing storage directly.
_Avoid_: UI callback mutation, database operation

**Planner Preferences（计划偏好）**:
The browser-local timeline defaults exported with a backup, including day bounds, slot size, default block duration, and time-zone identity.
_Avoid_: Account settings

**Backup（备份）**:
A versioned JSON snapshot of all tasks, time blocks, and planner preferences. Import validates the whole snapshot and replaces local planning data atomically; it does not merge.
_Avoid_: Sync, event log
