"use client";

import { applyCaptureRequestSchema } from "@newday/core/contracts/task-capture";
import type { TaskCaptureApi } from "../api/task-capture-api";
import type { CaptureSessionStore } from "../hooks/task-capture-session";
import { useTaskCapture } from "../hooks/use-task-capture";
import styles from "./task-capture.module.css";

export type TaskCaptureProps = {
  timeZone: string | null; preferencesLoading?: boolean;
  disabled?: boolean; disabledReason?: string;
  onConfigureTimeZone: () => void; onApplied: () => void | Promise<void>;
  api?: TaskCaptureApi; sessionStore?: CaptureSessionStore;
};

export function TaskCapture({ timeZone, preferencesLoading = false, disabled = false, disabledReason, onConfigureTimeZone, onApplied, api, sessionStore }: TaskCaptureProps) {
  const { state, controller } = useTaskCapture(onApplied, !disabled && !disabledReason && Boolean(timeZone), !disabledReason, api, sessionStore);
  const run = state.run;
  const locked = Boolean(state.request || state.captureId);
  const busy = Boolean(state.busy) || disabled || Boolean(disabledReason);
  const unavailable = busy || state.loading || preferencesLoading || !state.status?.configured || !timeZone;
  const selected = state.edits.filter((edit) => edit.selected);
  const validSelection = applyCaptureRequestSchema.safeParse({ operationId: "preview", tasks: selected.map(({ draftId, title, notes, startDate, endDate }) => ({ draftId, title, notes, startDate, endDate })) }).success;
  const receipt = run?.status === "applied" ? run.receipt : null;
  const ready = run?.status === "ready";
  const canReset = locked && run?.status !== "running" && !state.uncertainty && !state.pendingApply;
  const failed = run?.status === "failed" || run?.status === "interrupted";

  return <section className={styles.panel} aria-label="对话加入待办" data-testid="task-capture">
    <div className={styles.header}><div><p className={styles.kicker}>✦ &nbsp; CONVERSATION TO TASKS</p><h2>对话加入待办</h2><p className={styles.muted}>说出一个或多个安排，或从已有对话中提取待办。</p></div></div>
    <div className={styles.modes} aria-label="输入方式">
      <button type="button" aria-pressed={state.mode === "direct"} className={state.mode === "direct" ? styles.activeMode : styles.mode} disabled={busy || locked} onClick={() => controller.updateInput({ mode: "direct" })}>直接告诉我</button>
      <button type="button" aria-pressed={state.mode === "transcript"} className={state.mode === "transcript" ? styles.activeMode : styles.mode} disabled={busy || locked} onClick={() => controller.updateInput({ mode: "transcript" })}>粘贴已有对话</button>
    </div>
    {disabledReason ? <p role="status" className={styles.muted}>{disabledReason}</p> : state.loading || preferencesLoading ? <p role="status" className={styles.muted}>正在读取待办提取设置…</p> : null}
    {!state.loading && state.status && !state.status.configured ? <p className={styles.warning}>尚未配置待办提取模型，配置后即可使用。</p> : null}
    {!timeZone && !preferencesLoading && !disabledReason ? <div className={styles.warning}><p>先保存规划时区，助手才能正确理解“今天”和“明天”。</p><button type="button" className={styles.secondary} disabled={busy} onClick={onConfigureTimeZone}>设置规划时区</button></div> : null}
    {timeZone ? <p className={styles.muted}>按 {timeZone} 理解相对日期{run ? ` · 本轮今天是 ${run.today}` : ""}。</p> : null}
    {state.status?.modelId?.includes("scripted") ? <p className={styles.muted}>当前为测试模型，用于验证提取与创建流程。</p> : null}
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void controller.start(); }}>
      <label>{state.mode === "direct" ? "安排或待办内容" : "粘贴对话内容"}<textarea data-testid="capture-input" rows={4} maxLength={20000} value={state.text} readOnly={locked} disabled={busy && !locked} onChange={(event) => controller.updateInput({ text: event.target.value })} placeholder={state.mode === "direct" ? "例如：明天整理项目汇报，周五核对报销材料。" : "粘贴聊天记录，助手会提取其中明确属于你的安排。"} /></label>
      {!locked ? <><p className={styles.muted}>{state.mode === "direct" ? "发送即同意将明确的安排加入本地待办；日期或含义不清楚时，会先请你补充。" : "先提取和预览，你可以编辑并勾选要加入的待办。"} 输入内容会发送给已配置的模型。</p><button type="submit" className={styles.primary} disabled={unavailable || !state.text.trim()}>{state.mode === "direct" ? "发送并加入待办" : "提取待办"}</button></> : <p className={styles.muted}>本轮原文已保留，可在同一标签页刷新后继续查看。</p>}
      <p className={styles.muted}>按日期创建一次性待办；具体时刻保留在备注中，不设置提醒或重复规则。</p>
    </form>

    {state.busy === "starting" || run?.status === "running" ? <div role="status" className={styles.notice}><p>正在提取安排{state.mode === "direct" ? "，明确的待办会自动加入" : ""}…</p>{run?.status === "running" ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => void controller.cancel()}>停止本轮提取</button> : null}</div> : null}
    {run?.status === "interrupted" ? <p role="status" className={styles.warning}>本轮已中断，没有新的创建回执。原文已保留，可以重新发起。</p> : null}
    {run?.status === "details_deleted" ? <p role="status" className={styles.notice}>这轮记录已清理，已创建的待办仍保留在清单中。</p> : null}

    {ready ? <div className={styles.drafts} aria-label="提取的待办">
      <h3>确认要加入的待办</h3>
      {run.message ? <p className={styles.muted}>助手说明：{run.message}</p> : null}
      {run.drafts.length ? <><p className={styles.muted}>请核对原文、日期和归属。具体时刻与重复要求保存在备注中；本次创建按日期展示的一次性待办，不设置提醒或重复规则。</p>
        {run.drafts.map((draft, index) => {
          const edit = state.edits.find((entry) => entry.draftId === draft.id);
          if (!edit) return null;
          return <article className={styles.draft} data-testid="capture-draft" key={draft.id}>
            <label className={styles.selection}><input type="checkbox" checked={edit.selected} aria-label={`选择待办 ${index + 1}`} disabled={busy || Boolean(state.pendingApply)} onChange={(event) => controller.updateEdit(draft.id, { selected: event.target.checked })} /><strong>待办 {index + 1}</strong></label>
            {draft.needsReview ? <p className={styles.warning}>需要你确认：原文中的日期、归属或安排细节不够明确。</p> : null}
            <fieldset className={styles.fields} disabled={busy || Boolean(state.pendingApply)}>
              <label>标题 {index + 1}<input value={edit.title} maxLength={200} onChange={(event) => controller.updateEdit(draft.id, { title: event.target.value })} /></label>
              <label>备注 {index + 1}<textarea rows={2} value={edit.notes} maxLength={10000} onChange={(event) => controller.updateEdit(draft.id, { notes: event.target.value })} /></label>
              <div className={styles.dates}>
                <label>开始日期 {index + 1}<input type="date" value={edit.startDate} onChange={(event) => controller.updateEdit(draft.id, { startDate: event.target.value })} /></label>
                <label>结束日期 {index + 1}<input type="date" value={edit.endDate} min={edit.startDate || undefined} onChange={(event) => controller.updateEdit(draft.id, { endDate: event.target.value })} /></label>
              </div>
            </fieldset>
            <p className={styles.source}>原文：{draft.sourceText}</p>
          </article>;
        })}
        {!validSelection ? <p className={styles.warning}>请为选中的每条待办填写标题、开始日期和结束日期，结束日期不能早于开始日期。</p> : null}
        <button type="button" className={styles.primary} disabled={unavailable || !validSelection || Boolean(state.pendingApply)} onClick={() => void controller.apply()}>{state.busy === "applying" ? "正在加入待办…" : `加入 ${selected.length} 条待办`}</button>
      </> : <p data-testid="capture-empty" className={styles.notice}>没有提取到可加入的待办。请新建一轮并补充明确的安排。</p>}
    </div> : null}

    {state.uncertainty || state.pendingApply ? <div className={styles.warning} role="status"><strong>执行结果待确认</strong><p>已保留本轮原请求，请先确认结果，避免重复加入。</p><div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy} onClick={() => void controller.confirm()}>确认提交结果</button>{state.canRetry ? <button type="button" className={styles.secondary} disabled={unavailable} onClick={() => void controller.retryOriginal()}>按原请求重试</button> : null}</div></div> : null}
    {receipt ? <div className={styles.receipt} data-testid="capture-receipt"><p role="status"><strong>已加入 {receipt.tasks.length} 条待办</strong></p><ul className={styles.taskList}>{receipt.tasks.map((task) => <li key={task.id}><strong>{task.title}</strong><p>{task.startDate === task.endDate ? task.startDate : `${task.startDate} 至 ${task.endDate}`}</p>{task.notes ? <details><summary>查看保存的备注</summary><p className={styles.source}>{task.notes}</p></details> : null}</li>)}</ul><p className={styles.muted}>已保存到本地待办，切换到对应日期即可查看。</p></div> : null}
    {state.statusError ? <div className={styles.error} role="alert"><p>无法读取模型配置：{state.statusError}</p><button type="button" className={styles.secondary} disabled={busy || state.loading} onClick={() => void controller.retryStatus()}>重试连接</button></div> : null}
    {state.error ? <div className={styles.error} role="alert"><p>{state.error}</p></div> : null}
    {canReset ? <div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy || state.loading} onClick={() => controller.newCapture()}>新建一轮</button>{failed ? <button type="button" className={styles.secondary} disabled={unavailable} onClick={() => { controller.newCapture(false); void controller.start(); }}>{state.mode === "direct" ? "重新发送并加入待办" : "重新提取"}</button> : null}</div> : null}
  </section>;
}
