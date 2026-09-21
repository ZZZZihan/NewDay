"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  type ExecutionReceipt, type PlanningHistoryEntry, type PlanningSnapshot,
} from "@newday/core/contracts/agent-planning";
import type { Task } from "@newday/core/domain/planner-model";
import type { AgentApi } from "../api/agent-api";
import type { SessionStore } from "../hooks/agent-session";
import { useAgentPlanner } from "../hooks/use-agent-planner";
import styles from "./agent-planner.module.css";

export type AgentPlannerProps = {
  selectedDate: string; today: string; disabled?: boolean; disabledReason?: string;
  onApplied: () => void | Promise<void>; onPreferencesChanged?: () => void;
  api?: AgentApi; sessionStore?: SessionStore;
  tasks?: Task[];
};

export function AgentPlanner(props: AgentPlannerProps) {
  return <AgentPlannerView key={`${props.selectedDate}:${props.today}`} {...props} />;
}

function AgentPlannerView({ selectedDate, today, disabled = false, disabledReason, onApplied, onPreferencesChanged, api, sessionStore, tasks = [] }: AgentPlannerProps) {
  const { state, controller } = useAgentPlanner(selectedDate, { onApplied, onPreferencesChanged }, api, sessionStore, !disabledReason);
  const [expanded, setExpanded] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [rejectionReason, setRejectionReason] = useState("");
  const proposalHeading = useRef<HTMLHeadingElement>(null);
  const run = state.run;
  const proposal = run?.proposal;
  const output = proposal?.output;
  const pending = Boolean(state.pending);
  const busy = disabled || Boolean(state.busy) || state.loading;
  const knownToday = state.status?.today ?? today;
  const isToday = selectedDate === knownToday;
  const isCurrentSnapshot = Boolean(run && run.snapshot.date === knownToday && run.snapshot.date === today && run.snapshot.timeZone === state.preferences?.timeZone);
  const executable = run?.run.status === "ready" && run.snapshot.scope.complete && proposal?.lifecycle === "ready" && output?.kind === "ready" && isCurrentSnapshot && !state.receipt && !state.detailsDeleted;
  const working = run?.run.status === "running" || run?.run.status === "needs_clarification";
  const hasContent = expanded || Boolean(run || state.pending || state.error || state.notice);
  const availableTasks = new Map([...tasks, ...(run?.snapshot.candidates.map((candidate) => candidate.task) ?? [])].map((task) => [task.id, task.title]));
  for (const constraint of state.draft.taskConstraints) if (constraint.taskId && !availableTasks.has(constraint.taskId)) availableTasks.set(constraint.taskId, "当前清单外的已约束任务");

  useEffect(() => {
    if (proposal?.proposalId) proposalHeading.current?.focus();
  }, [proposal?.proposalId]);

  function submit(event: FormEvent) { event.preventDefault(); setExpanded(true); void controller.start(); }
  return (
    <section className={styles.panel} aria-label="今日规划助手" data-testid="agent-planner">
      <div className={styles.header}>
        <div><p className={styles.kicker}>✦ &nbsp; PLANNING ASSISTANT</p><h2>规划助手</h2><p className={styles.muted}>结合你的目标与限制，从已有任务中建议 1–3 件重点。</p></div>
        <button type="button" className={styles.secondary} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} disabled={state.loading}>
          {expanded ? "收起规划输入" : "帮我定今日重点"}
        </button>
      </div>

      {disabledReason ? <p role="status" className={styles.muted}>{disabledReason}</p> : null}
      {state.loading ? <p role="status" className={styles.muted}>正在读取规划设置…</p> : null}
      {!state.loading && state.status && !state.status.configured ? <p className={styles.muted}>尚未配置规划模型。配置后可生成建议，当前仍可手动安排任务。</p> : null}
      {state.status?.modelId?.includes("scripted") ? <p className={styles.muted}>当前使用测试模型，仅验证规划流程，不代表真实模型建议。</p> : null}
      {!isToday && state.status ? <p className={styles.muted}>这里展示 {selectedDate} 的决策记录。生成建议请回到规划时区的今天（{knownToday}）。</p> : null}

      {hasContent && !state.loading ? (
        <div className={styles.body}>
          {expanded && (isToday || !state.preferences?.timeZone) ? (
            <form className={styles.form} onSubmit={submit}>
              <fieldset disabled={disabled || pending || Boolean(state.busy)}>
                <label>当天目标<span className={styles.optional}>可选，每行一项</span><textarea rows={2} value={state.draft.goals} onChange={(event) => controller.updateDraft({ goals: event.target.value })} placeholder="今天最想推进什么？" maxLength={10000} /></label>
                <div className={styles.columns}>
                  <label>今天的精力<select value={state.draft.energy} onChange={(event) => controller.updateDraft({ energy: event.target.value as typeof state.draft.energy })}><option value="">还不确定</option><option value="low">偏低</option><option value="normal">一般</option><option value="high">充沛</option></select></label>
                  <label>今天最多承担几项<select value={state.draft.capacity} onChange={(event) => controller.updateDraft({ capacity: event.target.value })}><option value="">还不确定</option><option value="1">1 项</option><option value="2">2 项</option><option value="3">3 项</option></select></label>
                </div>
                <label>当天限制<span className={styles.optional}>可选，每行一项</span><textarea rows={2} value={state.draft.limitations} onChange={(event) => controller.updateDraft({ limitations: event.target.value })} placeholder="例如：等待他人回复，某件事今天还不能开始" maxLength={10000} /></label>
                {availableTasks.size ? <details className={styles.preferences} open={state.draft.taskConstraints.length > 0}><summary>明确任务限制</summary><p className={styles.muted}>这里只保存你明确指定的条件。任务的展示日期不自动视为硬截止。</p>{[...availableTasks].map(([taskId, title]) => <div className={styles.taskConstraint} key={taskId}><strong>{title}</strong><label className={styles.checkbox}><input type="checkbox" aria-label={`等待他人或条件满足：${title}`} checked={state.draft.taskConstraints.some((constraint) => constraint.taskId === taskId && constraint.kind === "blocked_task")} onChange={(event) => controller.setTaskConstraint(taskId, "blocked_task", event.target.checked ? `等待他人或条件满足：${title}` : null)} />等待他人或条件满足</label><label className={styles.checkbox}><input type="checkbox" aria-label={`今天必须纳入：${title}`} checked={state.draft.taskConstraints.some((constraint) => constraint.taskId === taskId && constraint.kind === "must_include")} onChange={(event) => controller.setTaskConstraint(taskId, "must_include", event.target.checked ? `今天必须纳入：${title}` : null)} />今天必须纳入</label><label>明确截止说明 · {title}<input value={state.draft.taskConstraints.find((constraint) => constraint.taskId === taskId && constraint.kind === "hard_deadline")?.sourceText ?? ""} onChange={(event) => controller.setTaskConstraint(taskId, "hard_deadline", event.target.value || null)} placeholder="仅填写你明确知道的硬约束；留空表示未知" maxLength={2000} /></label></div>)}</details> : null}
                <label className={styles.checkbox}><input type="checkbox" checked={state.draft.rest} onChange={(event) => controller.updateDraft({ rest: event.target.checked })} />今天休息，不安排新重点</label>
                <details className={styles.preferences} open={!state.preferences?.timeZone}>
                  <summary>规划时区与明确偏好</summary>
                  <label>规划时区<input value={state.draft.timeZone} onChange={(event) => controller.updateDraft({ timeZone: event.target.value })} placeholder="Asia/Shanghai" required /></label>
                  {!state.preferences?.timeZone ? <p className={styles.muted}>时区来自浏览器建议，保存后才用于计算今天。</p> : null}
                  <label>明确偏好<span className={styles.optional}>可选，每行一项</span><textarea rows={2} value={state.draft.preferences} onChange={(event) => controller.updateDraft({ preferences: event.target.value })} placeholder="例如：精力有限时优先推进一个重要项目" maxLength={10000} /></label>
                  <label className={styles.checkbox}><input type="checkbox" checked={state.draft.learningEnabled} onChange={(event) => controller.updateDraft({ learningEnabled: event.target.checked })} />允许参考已经记录的任务结果</label>
                  <button className={styles.secondary} type="button" onClick={() => void controller.savePreferences()} disabled={busy}>保存规划偏好</button>
                </details>
              </fieldset>
              <div className={styles.actions}>
                <button className={styles.primary} type="submit" disabled={busy || pending || !state.status?.configured || !isToday}>{state.busy === "starting" ? "正在准备建议…" : working ? "重新生成建议" : "帮我定今日重点"}</button>
                {working ? <button className={styles.secondary} type="button" disabled={pending} onClick={() => void controller.cancel()}>停止这轮规划</button> : null}
              </div>
              <p className={styles.muted}>生成时会保存上述当天信息。未填写的精力和限制保持未知；建议由你确认后才应用。</p>
            </form>
          ) : null}

          {run?.run.status === "running" ? <p role="status" className={styles.muted}>正在结合当天信息生成建议…你可以继续管理任务。</p> : null}
          {run?.run.status === "interrupted" ? <p role="status">上次规划因服务重启而中断，请重新生成建议。</p> : null}
          {run?.run.status === "cancelled" ? <p role="status">这轮规划已取消。</p> : null}

          {proposal && output && run ? (
            <section className={styles.proposal} data-testid="agent-proposal" aria-label="规划建议">
              <h3 ref={proposalHeading} tabIndex={-1}>{output.kind === "ready" ? "建议的今日重点" : output.kind === "needs_clarification" ? "先确认一下当天安排" : "今天的建议"}</h3>
              <p className={styles.muted}>{run.snapshot.scope.description}</p>
              {!run.snapshot.scope.complete ? <p role="alert">当前上下文没有包含全部候选任务，请缩小范围后重新规划。</p> : null}
              {output.kind === "ready" ? (
                <>
                  <ol className={styles.suggestions}>
                    {output.selections.map((selection) => <li key={selection.taskId}><strong>{taskTitle(run.snapshot, selection.taskId)}</strong><p>{selection.reason}</p><ul className={styles.sources}>{selection.factRefs.map((id) => { const fact = run.snapshot.facts.find((fact) => fact.id === id); return <li key={id}>来源：{fact ? `${sourceNames[fact.source]} · ${fact.text}` : "该来源已不可用"}</li>; })}</ul></li>)}
                  </ol>
                  {executable ? (
                    <>
                      <fieldset className={styles.selection} disabled={busy || pending}><legend>最终选择 · {state.selectedTaskIds.length}/3 项</legend>{run.snapshot.candidates.map(({ task, executable, blocked }) => <label key={task.id} className={styles.checkbox}><input type="checkbox" checked={state.selectedTaskIds.includes(task.id)} onChange={() => controller.selectTask(task.id)} disabled={!executable || blocked || task.status !== "open" || (!state.selectedTaskIds.includes(task.id) && state.selectedTaskIds.length >= 3)} />{task.title}{blocked ? <span className={styles.muted}>等待条件满足</span> : null}</label>)}</fieldset>
                      <FocusPreview snapshot={run.snapshot} selected={state.selectedTaskIds} />
                      <label>拒绝原因<span className={styles.optional}>可跳过</span><input value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} maxLength={2000} disabled={busy || pending} /></label>
                      <div className={styles.actions}><button className={styles.primary} type="button" disabled={busy || pending || state.selectedTaskIds.length < 1} onClick={() => void controller.apply()}>采纳今日重点</button><button className={styles.secondary} type="button" disabled={busy || pending} onClick={() => void controller.feedback(proposal.proposalId, "rejected", rejectionReason)}>拒绝建议</button></div>
                    </>
                  ) : <p className={styles.muted}>{proposal.lifecycle === "applied" ? "这份建议已有执行记录。" : proposal.lifecycle === "rejected" ? "你已拒绝这份建议，今日重点保持原样。" : "这份建议已失效，请依据当前任务和当天信息重新生成。"}</p>}
                </>
              ) : output.kind === "needs_clarification" && run.run.status === "needs_clarification" && run.run.clarificationRound === 0 && proposal.lifecycle !== "superseded" && proposal.lifecycle !== "expired" ? (
                <form onSubmit={(event) => { event.preventDefault(); void controller.answer(answers); }} className={styles.form}><p className={styles.muted}>只澄清这一轮。不确定时可以填“不知道”，或留空。</p>{state.answerPending ? <p role="status">回答已提交，结果尚未确认。重试会使用原回答和原请求标识。</p> : null}{output.questions.map((question) => <label key={question.id}>{question.question}<input value={answers[question.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} disabled={busy || pending || state.answerPending || !isCurrentSnapshot} maxLength={2000} /></label>)}<button className={styles.primary} type="submit" disabled={busy || pending || !isCurrentSnapshot}>{state.answerPending ? "重试原回答" : "提交回答"}</button></form>
              ) : output.kind === "no_action" ? <><p>{output.reason}</p><p className={styles.muted}>未更改已有今日重点。</p></> : null}
              {output.assumptions.length ? <div className={styles.assumptions}><strong>明确假设</strong><ul>{output.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></div> : null}
            </section>
          ) : null}

          {state.error ? <div className={styles.error} role="alert"><p>{state.error}</p>{["VERSION_CONFLICT", "DATE_EXPIRED", "PROPOSAL_NOT_EXECUTABLE"].includes(state.errorCode ?? "") ? <p>任务或当天信息已经变化。这份建议不能覆盖新状态，请重新生成。</p> : null}{!pending ? <button className={styles.secondary} type="button" disabled={busy} onClick={() => void controller.initialize()}>重新读取规划状态</button> : null}</div> : null}
          {state.pending ? <div className={styles.pending} role="status"><strong>执行结果待确认</strong><p>正在保留原请求标识，确认完成前无法再次采纳。</p><div className={styles.actions}><button className={styles.secondary} type="button" disabled={Boolean(state.busy)} onClick={() => void controller.confirmOperation()}>确认执行结果</button>{state.canRetryPending ? <button className={styles.secondary} type="button" disabled={Boolean(state.busy)} onClick={() => void controller.retryPendingOperation()}>按原请求重试</button> : null}</div>{state.canRetryPending ? <p className={styles.muted}>重试会保留相同请求标识与原选择。若服务端已执行，将返回原回执。</p> : null}</div> : null}
          {state.notice ? <p className={styles.notice} role="status">{state.notice}</p> : null}
          {state.receipt?.canRevert && state.receipt.date === knownToday && !state.detailsDeleted ? <button className={styles.secondary} type="button" disabled={busy || pending} onClick={() => void controller.revert(state.receipt!)}>恢复采纳前的重点</button> : null}
        </div>
      ) : null}

      <details className={styles.history} data-testid="agent-history" open={!isToday}>
        <summary>{isToday ? "当日决策记录" : `${selectedDate} 的决策与结果`}{state.history?.entries.length ? ` · ${state.history.entries.length}` : ""}</summary>
        {state.history?.entries.length ? state.history.entries.map((entry) => <HistoryEntry key={entry.id} entry={entry} today={knownToday} busy={busy || pending} onFeedback={(reason) => entry.proposal ? void controller.feedback(entry.proposal.proposalId, "reviewed", reason, entry.receipt ?? undefined) : undefined} onRevert={(receipt) => void controller.revert(receipt)} />) : <p className={styles.muted}>这一天还没有已记录的规划决策。此前结果未知。</p>}
      </details>
    </section>
  );
}

const sourceNames = { task: "任务信息", context: "当天输入", preference: "明确偏好", history: "已记录结果" };
export function taskTitle(snapshot: PlanningSnapshot | null, id: string) {
  return snapshot?.candidates.find((candidate) => candidate.task.id === id)?.task.title ?? snapshot?.recentOutcomes.find((outcome) => outcome.taskId === id)?.title ?? "原任务（当前详情不可用）";
}
export function focusDiff(before: readonly string[], selected: readonly string[]) {
  return { added: selected.filter((id) => !before.includes(id)), retained: selected.filter((id) => before.includes(id)), removed: before.filter((id) => !selected.includes(id)) };
}
function FocusPreview({ snapshot, selected }: { snapshot: PlanningSnapshot; selected: string[] }) {
  const diff = focusDiff(snapshot.currentFocusTaskIds, selected);
  return <div className={styles.preview} data-testid="agent-focus-preview"><strong>采纳后将替换今日重点集合</strong><dl>{([["新增", diff.added], ["保留", diff.retained], ["移除", diff.removed]] as const).map(([label, ids]) => <div key={label}><dt>{label}</dt><dd>{ids.length ? ids.map((id) => taskTitle(snapshot, id)).join("、") : "无"}</dd></div>)}</dl><p className={styles.muted}>只调整今日重点，不更改任务内容或完成状态。</p></div>;
}
const outcomeNames = { completed: "已完成", reopened: "重新打开", rescheduled: "已改期", deleted: "已删除", restored: "已恢复", unknown: "结果未知" };
function HistoryEntry({ entry, today, busy, onFeedback, onRevert }: { entry: PlanningHistoryEntry; today: string; busy: boolean; onFeedback: (reason: string) => void; onRevert: (receipt: ExecutionReceipt) => void }) {
  const [reason, setReason] = useState("");
  return <article className={styles.historyEntry}><strong>{entry.date} · {entry.receipt ? entry.receipt.action === "revert" ? "已恢复" : "已采纳" : entry.proposal?.lifecycle === "rejected" ? "已拒绝" : "规划建议"}</strong>{entry.readOnly ? <p className={styles.muted}>来自旧数据集，只读记录</p> : null}
    {entry.proposal?.output.kind === "ready" ? <p>原建议：{entry.proposal.output.selections.map((selection) => taskTitle(entry.snapshot, selection.taskId)).join("、")}</p> : null}
    {entry.receipt ? <p>最终重点：{entry.receipt.finalFocusTaskIds.length ? entry.receipt.finalFocusTaskIds.map((id) => taskTitle(entry.snapshot, id)).join("、") : "无"}</p> : null}
    {entry.outcomes.length ? <ul>{entry.outcomes.map((outcome) => <li key={outcome.taskId}>{outcome.title} · {outcomeNames[outcome.status]}</li>)}</ul> : <p className={styles.muted}>尚无已记录的任务结果。</p>}
    {entry.feedback.map((feedback) => <p key={feedback.feedbackId} className={styles.muted}>反馈：{feedback.reason || "未填写原因"}</p>)}
    {!entry.readOnly && entry.proposal ? <form className={styles.form} onSubmit={(event) => { event.preventDefault(); onFeedback(reason); }}><label>这次重点安排有帮助吗？<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="原因可跳过；例如重要事项是否推进" maxLength={2000} disabled={busy} /></label><div className={styles.actions}><button className={styles.secondary} type="submit" disabled={busy}>记录反馈</button>{entry.receipt?.canRevert && entry.date === today ? <button className={styles.secondary} type="button" disabled={busy} onClick={() => onRevert(entry.receipt!)}>恢复这次采纳前的重点</button> : null}</div></form> : null}
  </article>;
}
