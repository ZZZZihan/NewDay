import { Check, Circle, Edit3, Repeat2, RotateCcw, Star } from "lucide-react";
import { Button } from "@heroui/react/button";
import type { DayPlanItem, Task } from "@newday/core/domain/planner-model";
import { taskMetadata } from "../lib/planner-format";

export function TaskGroup({
  title,
  count,
  className = "",
  children,
}: {
  title: string;
  count: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`task-group ${className}`} aria-labelledby={`task-group-${title}`}>
      <h2 id={`task-group-${title}`}>{title}<span>{count}</span></h2>
      <div>{children}</div>
    </section>
  );
}

export function TaskRow({
  item,
  busy,
  focused,
  canFocus,
  focusDisabled,
  onFocus,
  onComplete,
  onEdit,
}: {
  item: DayPlanItem;
  busy: boolean;
  focused: boolean;
  canFocus: boolean;
  focusDisabled: boolean;
  onFocus: (task: Task, focused: boolean) => Promise<boolean>;
  onComplete: (task: Task) => Promise<boolean>;
  onEdit: () => void;
}) {
  const { task } = item;
  const completed = task.status === "completed";
  const linked = Boolean(item.notion);
  const focusLabel = focused
    ? `移出今日重点：${task.title}`
    : `设为今日重点：${task.title}`;

  return (
    <article className={`day-task ${completed ? "day-task--completed" : ""} ${item.isOverdue ? "day-task--overdue" : ""}`}>
      <Button
        type="button"
        isDisabled={busy || linked}
        className="task-check"
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label={completed ? `恢复任务：${task.title}` : `完成任务：${task.title}`}
        onPress={() => void onComplete(task)}
      >
        {completed ? <Check size={17} /> : <Circle size={18} />}
      </Button>
      <Button type="button" className="task-main" variant="ghost" isDisabled={busy || linked} onPress={onEdit}>
        <strong>{task.title}</strong>
        <span>{taskMetadata(item)}</span>
      </Button>
      <div className="task-actions">
        {item.notion?.url ? <a className="task-notion-link" href={item.notion.url} target="_blank" rel="noopener noreferrer" aria-label={`在 Notion 查看：${task.title}`}>Notion ↗</a> : null}
        {canFocus && !completed ? (
          <Button
            type="button"
            className={`task-focus ${focused ? "task-focus--active" : ""}`}
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label={focusLabel}
            aria-describedby={!focused && focusDisabled ? "focus-limit-help" : undefined}
            isDisabled={busy || (!focused && focusDisabled)}
            onPress={() => void onFocus(task, focused)}
          >
            <Star size={16} fill={focused ? "currentColor" : "none"} />
          </Button>
        ) : task.seriesId ? (
          <span className="task-repeat-mark" title="重复任务" aria-hidden="true"><Repeat2 size={15} /></span>
        ) : null}
        <Button type="button" className="task-edit" variant="ghost" isDisabled={busy || linked} size="sm" isIconOnly aria-label={linked ? `Notion 只读任务：${task.title}` : `编辑任务：${task.title}`} onPress={onEdit}>
          <Edit3 size={16} />
        </Button>
      </div>
    </article>
  );
}

export function PlannerLoading() {
  return (
    <main className="day-page">
      <div className="planner-loading" role="status">
        <RotateCcw className="animate-spin" size={20} aria-hidden="true" />
        正在打开今天的任务…
      </div>
    </main>
  );
}
