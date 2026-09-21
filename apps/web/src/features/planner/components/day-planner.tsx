"use client";

import { CalendarDays, Check, ChevronLeft, ChevronRight, Download, MoreHorizontal, Plus, Upload } from "lucide-react";
import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Input } from "@heroui/react/input";
import { Menu } from "@heroui/react/menu";
import { Popover } from "@heroui/react/popover";
import { formatDayShort, parseLocalDate, shiftDate } from "@newday/core/domain/planner-date";
import { ThemeToggle } from "@/features/theme/theme-toggle";
import { AgentPlanner } from "@/features/agent/components/agent-planner";
import { useDayPlanner } from "../hooks/use-day-planner";
import { formatClockDate, formatClockTime, formatYearDay } from "../lib/planner-format";
import { TaskEditor } from "./task-editor";
import { PlannerLoading, TaskGroup, TaskRow } from "./task-list";
import { PlannerStatus } from "./planner-status";
import { FullscreenToggle } from "./fullscreen-toggle";

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;

export function DayPlanner() {
  const {
    now, today, timeZone, selectedDate, setDateOverride, quickTitle, setQuickTitle,
    setEditingTaskId, editingTask, editingSeries, editingSeriesActionsAllowed,
    notice, isSaving, isUndoing, quickInputRef, importInputRef,
    dayPlan, dataError, refreshing, refresh, migration, seriesError, seriesLoading, retrySeries,
    handleUndo, handleQuickAdd, handleComplete, handleFocus, handleExport,
    handleImport, saveEditor, moveDate, deleteEditingTask, stopEditingRecurrence,
  } = useDayPlanner();
  if (!selectedDate) return <PlannerLoading />;

  const selectedIsToday = selectedDate === today;
  const mondayOffset = (parseLocalDate(selectedDate).getDay() + 6) % 7;
  const weekStart = shiftDate(selectedDate, -mondayOffset);
  const weekDays = WEEKDAY_LABELS.map((weekday, index) => ({
    weekday,
    date: shiftDate(weekStart, index),
  }));
  const [clockHours, clockMinutes] = formatClockTime(now, timeZone).split(":");
  const focusedIds = new Set(dayPlan?.focus.map(({ task }) => task.id) ?? []);
  const focusAtLimit = (dayPlan?.counts.focus ?? 0) >= 3;
  const hasOpenGroups = Boolean(
    dayPlan &&
      (dayPlan.focus.length > 0 || dayPlan.overdue.length > 0 || dayPlan.open.length > 0),
  );

  return (
    <main className="day-page" aria-busy={isSaving || isUndoing || migration.checking}>
      <div className="planner-frame">
        <Card className="time-panel" aria-label="时间与日期">
          <header className="panel-header">
            <div className="panel-brand">
              <span className="brand-mark" aria-hidden="true">N</span>
              <div>
                <p className="brand-name">NewDay</p>
                <p className="brand-caption">今天，只看要做的事</p>
              </div>
            </div>

            <div className="panel-utilities">
              <FullscreenToggle />
              <ThemeToggle />
              <Popover>
                <Popover.Trigger className="more-trigger" aria-label="更多操作" aria-haspopup="menu">
                  <MoreHorizontal size={20} aria-hidden="true" />
                </Popover.Trigger>
                <Popover.Content className="more-popover" placement="bottom end">
                  <Popover.Dialog>
                    <Menu aria-label="更多操作菜单" className="more-menu">
                      <Menu.Item id="export" aria-label="导出数据" isDisabled={isSaving || isUndoing || migration.checking} onAction={() => void handleExport()}>
                        <Download size={17} aria-hidden="true" />
                        <span><strong>导出备份</strong><small>保存任务、重复规则与重点</small></span>
                      </Menu.Item>
                      <Menu.Item id="import" aria-label="导入数据" isDisabled={isSaving || isUndoing || migration.checking} onAction={() => importInputRef.current?.click()}>
                        <Upload size={17} aria-hidden="true" />
                        <span><strong>导入备份</strong><small>替换当前全部规划数据</small></span>
                      </Menu.Item>
                    </Menu>
                  </Popover.Dialog>
                </Popover.Content>
              </Popover>
              <input
                ref={importInputRef}
                className="visually-hidden"
                data-testid="import-input"
                type="file"
                accept="application/json,.json"
                disabled={isSaving || isUndoing || migration.checking}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void handleImport(file);
                }}
              />
            </div>
          </header>

          <section className="time-panel__clock" aria-label="当前时间">
            <time className="hero-clock" data-testid="current-clock" dateTime={now?.toISOString()}>
              <span>{clockHours}</span>
              <span className="hero-clock__colon">:</span>
              <span>{clockMinutes}</span>
            </time>
            <p className="hero-date">{formatClockDate(now, timeZone)}</p>
          </section>

          <div className="time-panel__bottom">
            <nav className="week-navigation" aria-label="日期导航">
              <div className="week-navigation__header">
                <Button className="date-arrow" type="button" variant="ghost" size="sm" isIconOnly aria-label="前一天" onPress={() => moveDate(-1)}>
                  <ChevronLeft size={19} />
                </Button>
                <div className="date-picker-control">
                  <Button className="date-picker-button" type="button" variant="ghost" aria-hidden="true">
                    <CalendarDays size={16} aria-hidden="true" />
                    <span>{formatDayShort(selectedDate)}{selectedIsToday ? " · 今天" : ""}</span>
                  </Button>
                  <input
                    className="date-picker-input"
                    aria-label="选择日期"
                    type="date"
                    value={selectedDate}
                    onChange={(event) => {
                      if (event.target.value) {
                        setDateOverride(event.target.value);
                        setEditingTaskId(null);
                      }
                    }}
                  />
                </div>
                <Button className="date-arrow" type="button" variant="ghost" size="sm" isIconOnly aria-label="后一天" onPress={() => moveDate(1)}>
                  <ChevronRight size={19} />
                </Button>
              </div>

              <div className="week-strip" aria-label="本周日期">
                {weekDays.map(({ weekday, date }) => (
                  <Button
                    key={date}
                    type="button"
                    variant="ghost"
                    className={`week-day ${date === selectedDate ? "week-day--selected" : ""} ${date === today ? "week-day--today" : ""}`}
                    aria-label={`查看${formatYearDay(date)}的任务`}
                    aria-pressed={date === selectedDate}
                    onPress={() => {
                      setDateOverride(date);
                      setEditingTaskId(null);
                    }}
                  >
                    <small>{weekday}</small>
                    <span>{Number(date.slice(8, 10))}</span>
                  </Button>
                ))}
              </div>
            </nav>

            <div className="time-panel__summary">
              <p className="task-summary" aria-label="任务概览">
                <strong>{dayPlan?.counts.open ?? 0} 项待办</strong>
                <span aria-hidden="true">·</span>
                <span>{dayPlan?.counts.completed ?? 0} 项完成</span>
              </p>
              {!selectedIsToday ? (
                <Button className="today-button" type="button" variant="ghost" size="sm" onPress={() => setDateOverride(null)}>
                  回到今天
                </Button>
              ) : null}
            </div>
          </div>

          <footer className="time-panel__footer-zone">
            <blockquote>“把今天过好，就是最好的计划。”</blockquote>
            <div className="time-panel__footer">
              <span className="local-status-dot" aria-hidden="true" />
              任务保存在服务端
            </div>
          </footer>
        </Card>

        <section className="schedule-panel" aria-label="每日任务表">
          <header className="schedule-heading">
            <div>
              <p className="section-kicker">{selectedIsToday ? "今天" : formatDayShort(selectedDate)}</p>
              <h1>{selectedIsToday ? "今天的任务" : "这一天的任务"}</h1>
            </div>
            <p className="schedule-meta"><strong>{dayPlan?.counts.open ?? 0}</strong> 项待办</p>
          </header>

          <PlannerStatus
            migration={migration}
            dataError={dataError}
            seriesError={seriesError}
            refreshing={refreshing}
            onRetry={() => void refresh()}
            onRetrySeries={retrySeries}
          />

          <AgentPlanner
            selectedDate={selectedDate}
            today={today}
            tasks={[...(dayPlan?.focus ?? []), ...(dayPlan?.overdue ?? []), ...(dayPlan?.open ?? [])].map(({ task }) => task)}
            disabled={migration.checking || isSaving || isUndoing}
            disabledReason={migration.checking ? "正在检查并迁移旧浏览器任务…" : undefined}
            onApplied={refresh}
          />

          <form className="quick-add" onSubmit={handleQuickAdd}>
            <Input
              ref={quickInputRef}
              id="quick-task"
              data-testid="quick-task-input"
              value={quickTitle}
              onChange={(event) => setQuickTitle(event.target.value)}
              placeholder="添加一件要做的事"
              aria-label="添加一件要做的事"
              autoComplete="off"
              fullWidth
              variant="secondary"
            />
            <Button type="submit" variant="primary" size="lg" isIconOnly aria-label="添加任务" isDisabled={!quickTitle.trim() || isSaving || isUndoing || migration.checking}>
              <Plus size={20} />
            </Button>
          </form>

          <div className="daily-task-list" data-testid="daily-task-list">
            {!dayPlan && !dataError ? (
              <div className="task-list-loading" role="status">
                <span className="task-list-loading__indicator" aria-hidden="true" />
                {migration.checking ? "正在检查并迁移旧浏览器任务…" : "正在读取这一天的任务…"}
              </div>
            ) : null}

            {dayPlan?.focus.length ? (
              <TaskGroup title="今日重点" count={dayPlan.focus.length} className="task-group--focus">
                {dayPlan.focus.map((item) => (
                  <TaskRow
                    key={item.task.id}
                    busy={isSaving || isUndoing}
                    item={item}
                    focused
                    canFocus={selectedIsToday}
                    focusDisabled={false}
                    onFocus={handleFocus}
                    onComplete={handleComplete}
                    onEdit={() => setEditingTaskId(item.task.id)}
                  />
                ))}
              </TaskGroup>
            ) : null}

            {dayPlan?.overdue.length ? (
              <TaskGroup title="逾期" count={dayPlan.overdue.length} className="task-group--overdue">
                {dayPlan.overdue.map((item) => (
                  <TaskRow
                    key={item.task.id}
                    busy={isSaving || isUndoing}
                    item={item}
                    focused={focusedIds.has(item.task.id)}
                    canFocus={selectedIsToday}
                    focusDisabled={focusAtLimit}
                    onFocus={handleFocus}
                    onComplete={handleComplete}
                    onEdit={() => setEditingTaskId(item.task.id)}
                  />
                ))}
              </TaskGroup>
            ) : null}

            {dayPlan?.open.length ? (
              <TaskGroup title="待办" count={dayPlan.open.length}>
                {dayPlan.open.map((item) => (
                  <TaskRow
                    key={item.task.id}
                    busy={isSaving || isUndoing}
                    item={item}
                    focused={focusedIds.has(item.task.id)}
                    canFocus={selectedIsToday}
                    focusDisabled={focusAtLimit}
                    onFocus={handleFocus}
                    onComplete={handleComplete}
                    onEdit={() => setEditingTaskId(item.task.id)}
                  />
                ))}
              </TaskGroup>
            ) : null}

            {selectedIsToday && focusAtLimit && (dayPlan?.open.length || dayPlan?.overdue.length) ? (
              <p className="focus-limit-note" id="focus-limit-help">今日重点最多 3 项</p>
            ) : null}

            {dayPlan && !hasOpenGroups ? (
              <Card className="task-empty" variant="tertiary">
                <Check size={24} aria-hidden="true" />
                <p>{dayPlan.completed.length > 0 ? "这一天已经完成了" : "这一天还没有任务"}</p>
                <span>在上方写下一件要做的事。</span>
              </Card>
            ) : null}

            {dayPlan?.completed.length ? (
              <details className="completed-section" open>
                <summary>已完成 · {dayPlan.completed.length}</summary>
                <div className="completed-list">
                  {dayPlan.completed.map((item) => (
                    <TaskRow
                      key={item.task.id}
                      busy={isSaving || isUndoing}
                    item={item}
                      focused={false}
                      canFocus={false}
                      focusDisabled={false}
                      onFocus={handleFocus}
                      onComplete={handleComplete}
                      onEdit={() => setEditingTaskId(item.task.id)}
                    />
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        </section>
      </div>

      {editingTask && (!editingTask.seriesId || editingSeries) ? (
        <TaskEditor
          key={`${editingTask.id}:${editingSeries?.updatedAt ?? "one-off"}`}
          task={editingTask}
          series={editingSeries}
          allowSeriesActions={editingSeriesActionsAllowed}
          busy={isSaving || isUndoing || seriesLoading || Boolean(seriesError)}
          loading={seriesLoading}
          loadError={seriesError}
          onRetryLoad={retrySeries}
          onClose={() => setEditingTaskId(null)}
          onSave={async (values) => {
            const saved = await saveEditor(editingTask, editingSeries, values);
            if (saved) setEditingTaskId(null);
          }}
          onToggleComplete={async () => {
            const saved = await handleComplete(editingTask);
            if (saved) setEditingTaskId(null);
          }}
          onDelete={deleteEditingTask}
          onStopRecurrence={editingSeries ? stopEditingRecurrence : undefined}
        />
      ) : null}

      {notice ? (
        <div className="app-notice" role="status" data-testid="app-notice">
          <span>{notice.message}</span>
          {notice.receipt ? (
            <Button type="button" variant="ghost" size="sm" isDisabled={isUndoing || isSaving} onPress={() => void handleUndo()}>
              撤销
            </Button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
