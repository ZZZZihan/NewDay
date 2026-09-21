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
This scheduling date is not an external promise or a hard deadline unless the user supplies an explicit constraint.
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
One logical stream of repeated work. Its identity remains stable when the recurrence rule changes, even though storage may contain multiple effective-dated rule segments.
_Avoid_: Multi-day task, custom interval

**Rule Segment（规则段）**:
One physical recurrence rule that applies from its inclusive start date through its internal effective end date. Updating “this and future” preserves earlier segments and replaces the logical tail from the chosen effective date.
_Avoid_: A new unrelated series, retroactive overwrite

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
The server keeps one latest receipt for 10 seconds and binds it to the originating browser-page instance. Another mutation can supersede it; a page reload or API restart ends its usable lifetime.
_Avoid_: History, audit log

**Backup（备份）**:
A versioned JSON snapshot of tasks, recurring series, and focus records. Import validates the whole snapshot and replaces server planning data atomically; it does not merge.
_Avoid_: Sync, event log

**Daily Context（当天上下文）**:
The user's explicit goals, energy, capacity and constraints for one date in the saved planning timezone. Missing values remain unknown. Context has its own revision and is bound to the current dataset and timezone; it is not a permanent preference.
_Avoid_: Inferred habits, availability guessed from the task list

**Explicit Preference（明确偏好）**:
A user-entered, editable preference stored with its own revision. Feedback reasons do not automatically become preferences. Disabling history reference excludes recorded outcomes and feedback from future model snapshots while preserving explicit preferences.
_Avoid_: Learned fact, automatic profile

**Planning Snapshot（规划快照）**:
One consistent, persisted view of the planning version, daily context, preferences, eligible tasks, existing focus and sourced recent records. Recurring occurrences are materialized before the version is sampled, inside the same SQLite transaction. An oversized context is rejected explicitly rather than silently truncated.
_Avoid_: Live task state, permission to execute

**Planning Proposal（规划建议）**:
A persisted suggestion, clarification question set or no-action result. A ready proposal selects one to three existing tasks with reasons, fact references and explicit assumptions. It does not write task data. The user's confirmed final selection replaces today's entire focus set; no-action preserves the existing set.
_Avoid_: Command, successful execution

**Planning Version（规划版本）**:
The pair `datasetEpoch` and `plannerRevision`. Actual task, recurrence or focus changes advance the revision once per outer transaction; no-ops and Agent record writes do not. Successful task replacement, initial browser migration and independent Agent import create a new epoch. Daily context and preferences use separate revisions.
_Avoid_: Modification timestamp, browser state

**Execution Operation（执行操作）**:
A user-confirmed apply or conditional revert, identified by a stable `operationId`. Focus changes, the operation event and receipt commit atomically; an apply also records adoption feedback in that transaction. Repeating an identical request returns its original terminal result; reusing the ID with different input is a conflict.
_Avoid_: Model response, accepted request

**Execution Receipt（执行回执）**:
The persisted result of a committed operation: before/after versions, final focus, changes and execution time. A missing HTTP response means the client must query the original operation, not assume failure. The minimal dedupe ledger survives Agent history cleanup; removed details return `details_deleted` without fabricating a receipt.
_Avoid_: Undo token, proof of model quality

**Conditional Revert（恢复采纳前的重点）**:
A new idempotent operation restoring the focus set before an Agent apply. It requires the same date, timezone and epoch, an unchanged planning version and compatible task/focus state. Its record persists across API restarts. This is distinct from the manual action's 10-second Undo receipt.
_Avoid_: Unconditional rollback, restore all tasks

**Recorded Daily Outcome（已记录的当日结果）**:
A completion, reopen, reschedule, deletion or restoration event recorded after adoption in the same dataset and calendar day. Unknown means the required event was not recorded; today's task status cannot establish yesterday's outcome. A next-day event remains attributed to its actual date.
_Avoid_: Historical state inferred from current data

**Agent Backup（Agent 备份）**:
A separate `newday-agent` v1 archive containing Agent records and explicit preferences; the current business backup is `newday-backup` v6 and remains separate. Import stores source Agent records in read-only namespaces, preserves original archives, and never replays execution IDs or activates imported daily contexts. Preference import is an explicit choice and creates a current preference revision.
_Avoid_: Task restore, executable replay

## 运行与目录边界

NewDay 由独立的 Next.js 前端和 Fastify API 组成。任务的权威副本保存在后端 SQLite，默认是仓库根目录的 `data/newday.sqlite`。浏览器通过 Web 同源 `/api` 转发访问后端，不再把新任务写入 IndexedDB；主题偏好仍保存在浏览器中。

`apps/web` 负责呈现和交互，`apps/api` 负责 HTTP 校验、请求编排和持久化。`packages/core/src/domain` 定义领域对象和规则，`packages/core/src/application` 定义由 API 执行的业务操作及存储接口，`packages/core/src/contracts` 提供可跨端使用的任务备份、Agent 规划与独立备份格式及校验。前端只导入 application 类型，不执行其中的存储操作。

手动清单位于 `features/planner`，规划交互位于 `features/agent`，两者通过共享 HTTP 请求器访问同一个 Fastify API。用户确认并保存时区后，人工清单的实际今天、完成日期和今日重点与 Agent 使用同一时区；未配置时区前，人工入口保留浏览器传入日期的原有行为，Agent 生成要求先设置时区。

Agent 页面用 `sessionStorage` 保存同一标签页刷新所需的运行标识、待确认操作和待确认澄清请求，不在浏览器存储权威任务副本。关闭标签页后的自动会话恢复没有保证；服务器记录可按 ID 查询。模型调用在 SQLite 事务之外进行，最多一条有效活动运行，默认每次最长 30 秒、每轮最多 3 次调用。API 重启将未完成运行标为中断，不自动续跑。

模型默认关闭，配置和发送数据范围见 [README](./README.md)。模型只能输出建议、澄清或无动作结果；首版业务写权限只有经确认的今日重点最终集合。软件、真实模型评测和实际使用效果的验收分别记录在 [Agent 开发执行记录](./docs/agent-development-status.md)。

旧浏览器数据的迁移与新任务保存是两个流程：迁移只读旧 IndexedDB，在空服务端接收后仍保留原数据；用户下载旧备份后可明确清除旧库。已有服务端数据不会被自动迁移覆盖。普通备份导入则是明确的全部替换操作。

当前面向本机单人使用，没有账号身份、租户隔离或离线写入队列。目录与接口细节见 [架构说明](./docs/architecture.md)。
