"use client";

import { useCallback, useState } from "react";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Download, Inbox, Library, ListTodo, MoreHorizontal, Plus, Sun, Upload, Link2 } from "lucide-react";
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
import { LifePanel, type LifeView } from "./life-panel";
import { useLifeWorkspace } from "../hooks/use-life-workspace";
import { useNotionConnection } from "../hooks/use-notion-connection";
import { NotionConnectionPanel } from "./notion-connection-panel";

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;

export function DayPlanner() {
  const [view, setView] = useState<"today" | LifeView | "notion">("today");
  const life = useLifeWorkspace(view !== "today" && view !== "notion");
  const onNotionReturn = useCallback(() => setView("notion"), []);
  const {
    now, today, timeZone, selectedDate, setDateOverride, quickTitle, setQuickTitle,
    setEditingTaskId, openExternalTask, editingTask, editingSeries, editingSeriesActionsAllowed,
    notice, isSaving, isUndoing, quickInputRef, importInputRef,
    dayPlan, dataError, refreshing, refresh, migration, seriesError, seriesLoading, retrySeries,
    handleUndo, handleQuickAdd, handleComplete, handleFocus, handleExport,
    handleImport, saveEditor, moveDate, deleteEditingTask, stopEditingRecurrence,
  } = useDayPlanner();
  const refreshLife = life.refresh;
  const refreshAfterNotionScan = useCallback(async () => {
    await Promise.all([refresh(), refreshLife()]);
  }, [refresh, refreshLife]);
  const notion = useNotionConnection(onNotionReturn, refreshAfterNotionScan);
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
  const taskTotal = (dayPlan?.counts.open ?? 0) + (dayPlan?.counts.completed ?? 0);
  const progress = taskTotal ? Math.round(((dayPlan?.counts.completed ?? 0) / taskTotal) * 100) : 0;

  async function mutateLife(operation: () => Promise<unknown>) {
    const saved = await life.mutate(operation);
    if (saved) await refresh();
    return saved;
  }

  async function undoAndRefreshLife() {
    if (await handleUndo()) await life.refresh();
  }

  return (
    <main className="day-page" aria-busy={isSaving || isUndoing || migration.checking}>
      <div className="workspace-shell">
        <header className="panel-header workspace-header">
            <div className="panel-brand">
              <span className="brand-mark" aria-hidden="true">N</span>
              <div>
                <p className="brand-name">NewDay</p>
                <p className="brand-caption">个人工作台</p>
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
                        <span><strong>导出备份</strong><small>保存任务、收集箱与资料库</small></span>
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
                  if (file) void (async () => {
                    if (await handleImport(file)) await life.refresh();
                  })();
                }}
              />
            </div>
        </header>

        <div className="planner-frame">
          <Card className="time-panel" aria-label="时间与日期">
          <p className="sidebar-kicker">当前时间</p>

          <section className="time-panel__clock" aria-label="当前时间">
            <time className="hero-clock" data-testid="current-clock" dateTime={now?.toISOString()}>
              <span>{clockHours}</span>
              <span className="hero-clock__colon">:</span>
              <span>{clockMinutes}</span>
            </time>
            <p className="hero-date">{formatClockDate(now, timeZone)}</p>
          </section>

          <nav className="life-navigation" aria-label="工作台导航">
            <p className="sidebar-kicker">工作空间</p>
            <button type="button" className={view === "today" ? "selected" : ""} aria-current={view === "today" ? "page" : undefined} onClick={() => setView("today")}><Sun size={17} />今天</button>
            <button type="button" className={view === "inbox" ? "selected" : ""} aria-current={view === "inbox" ? "page" : undefined} onClick={() => setView("inbox")}><Inbox size={17} />收集箱</button>
            <button type="button" className={view === "tasks" ? "selected" : ""} aria-current={view === "tasks" ? "page" : undefined} onClick={() => setView("tasks")}><ListTodo size={17} />任务总表</button>
            <button type="button" className={view === "library" ? "selected" : ""} aria-current={view === "library" ? "page" : undefined} onClick={() => setView("library")}><Library size={17} />资料库</button>
            <button type="button" className={view === "notion" ? "selected" : ""} aria-current={view === "notion" ? "page" : undefined} onClick={() => setView("notion")}><Link2 size={17} />Notion 连接</button>
          </nav>

          <div className="time-panel__bottom">
            <p className="sidebar-kicker">日期导航</p>
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
            <div className="sidebar-progress" aria-label={`已完成 ${progress}%`}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <p className="sidebar-progress-label">已完成 {dayPlan?.counts.completed ?? 0} / {taskTotal}<strong>{progress}%</strong></p>
          </div>

          <footer className="time-panel__footer-zone">
            <div className="time-panel__footer">
              <span className="local-status-dot" aria-hidden="true" />
              任务保存在服务端
            </div>
          </footer>
        </Card>

        {view === "today" ? <section className="schedule-panel" aria-label="每日任务表">
          <header className="schedule-heading">
            <div>
              <p className="section-kicker">{formatYearDay(selectedDate)} · {selectedIsToday ? "今天" : "日计划"}</p>
              <h1>{selectedIsToday ? "今天的任务" : "这一天的任务"}</h1>
              <p className="schedule-subtitle">把时间留给真正重要的事。</p>
            </div>
            <p className="schedule-meta">{selectedIsToday ? "今日计划" : formatDayShort(selectedDate)}</p>
          </header>

          <div className="planner-metrics" aria-label="任务统计">
            <div><span>待办</span><strong>{dayPlan?.counts.open ?? 0}</strong><small>项任务</small></div>
            <div><span>今日重点</span><strong>{dayPlan?.counts.focus ?? 0}</strong><small>最多 3 项</small></div>
            <div><span>已完成</span><strong>{dayPlan?.counts.completed ?? 0}</strong><small>项任务</small></div>
            <div className="planner-metrics__progress"><span>当前进度</span><strong>{progress}<em>%</em></strong><small>{taskTotal ? `${taskTotal} 项任务` : "暂无任务"}</small></div>
          </div>

          <PlannerStatus
            migration={migration}
            dataError={dataError}
            seriesError={seriesError}
            refreshing={refreshing}
            onRetry={() => void refresh()}
            onRetrySeries={retrySeries}
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
        </section> : view === "notion" ? <NotionConnectionPanel connection={notion} /> : <LifePanel view={view} today={today} workspace={life.workspace} error={life.error} busy={life.busy} mutate={mutateLife} refresh={life.refresh} onOpenTask={openExternalTask} onCompleteTask={handleComplete} onViewChange={setView} />}
        <aside className="assistant-panel" aria-label="规划助手">
          <AgentPlanner
            selectedDate={selectedDate}
            today={today}
            tasks={[...(dayPlan?.focus ?? []), ...(dayPlan?.overdue ?? []), ...(dayPlan?.open ?? [])].map(({ task }) => task)}
            disabled={migration.checking || isSaving || isUndoing}
            disabledReason={migration.checking ? "正在检查并迁移旧浏览器任务…" : undefined}
            onApplied={refresh}
          />
        </aside>
        </div>
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
            if (saved) { setEditingTaskId(null); await life.refresh(); }
          }}
          onToggleComplete={async () => {
            const saved = await handleComplete(editingTask);
            if (saved) { setEditingTaskId(null); await life.refresh(); }
          }}
          onDelete={async () => { await deleteEditingTask(); await life.refresh(); }}
          onStopRecurrence={editingSeries ? stopEditingRecurrence : undefined}
        />
      ) : null}

      {notice ? (
        <div className="app-notice" role="status" data-testid="app-notice">
          <span>{notice.message}</span>
          {notice.receipt ? (
            <Button type="button" variant="ghost" size="sm" isDisabled={isUndoing || isSaving} onPress={() => void undoAndRefreshLife()}>
              撤销
            </Button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
