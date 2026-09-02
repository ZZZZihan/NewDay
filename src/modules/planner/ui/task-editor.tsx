import { getISODay } from "date-fns";
import { Check, RotateCcw, Trash2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@heroui/react/button";
import { Input } from "@heroui/react/input";
import { Label } from "@heroui/react/label";
import { Modal } from "@heroui/react/modal";
import { TextArea } from "@heroui/react/textarea";
import { TextField } from "@heroui/react/textfield";

import { parseLocalDate } from "../domain/planner-date";
import type {
  IsoWeekday,
  RecurrenceEnd,
  RecurrencePattern,
  RecurrenceSeries,
  Task,
} from "../domain/planner-model";

const WEEKDAYS: { value: IsoWeekday; label: string }[] = [
  { value: 1, label: "星期一" },
  { value: 2, label: "星期二" },
  { value: 3, label: "星期三" },
  { value: 4, label: "星期四" },
  { value: 5, label: "星期五" },
  { value: 6, label: "星期六" },
  { value: 7, label: "星期日" },
];

type RecurrenceKind = "none" | RecurrencePattern["kind"];
export type RecurrenceEditScope = "occurrence" | "series";

export type TaskEditorValues = {
  title: string;
  notes: string;
  startDate: string;
  endDate: string;
  recurrenceKind: RecurrenceKind;
  pattern?: RecurrencePattern;
  end?: RecurrenceEnd;
  scope: RecurrenceEditScope;
};

export function TaskEditor({
  task,
  series,
  busy,
  onClose,
  onSave,
  onToggleComplete,
  onDelete,
  onStopRecurrence,
}: {
  task: Task;
  series?: RecurrenceSeries;
  busy: boolean;
  onClose: () => void;
  onSave: (values: TaskEditorValues) => Promise<void>;
  onToggleComplete: () => Promise<void>;
  onDelete: () => Promise<void>;
  onStopRecurrence?: () => Promise<void>;
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [startDate, setStartDate] = useState(task.startDate);
  const [endDate, setEndDate] = useState(task.endDate);
  const [scope, setScope] = useState<RecurrenceEditScope>("occurrence");
  const [recurrenceKind, setRecurrenceKind] = useState<RecurrenceKind>(
    series?.pattern.kind ?? "none",
  );
  const [weeklyDays, setWeeklyDays] = useState<IsoWeekday[]>(
    series?.pattern.kind === "weekly"
      ? series.pattern.weekdays
      : [getISODay(parseLocalDate(task.startDate)) as IsoWeekday],
  );
  const [endKind, setEndKind] = useState<RecurrenceEnd["kind"]>(
    series?.end.kind ?? "never",
  );
  const [recurrenceEndDate, setRecurrenceEndDate] = useState(
    series?.end.kind === "onDate" ? series.end.date : task.startDate,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const seriesWide = Boolean(series && scope === "series");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    if (endDate < startDate) {
      setFormError("截止日期不能早于开始日期");
      return;
    }

    if (recurrenceKind !== "none" && startDate !== endDate) {
      setFormError("重复任务必须把开始日期和截止日期设为同一天");
      return;
    }

    if (recurrenceKind === "weekly" && weeklyDays.length === 0) {
      setFormError("每周重复至少选择一天");
      return;
    }

    if (
      recurrenceKind === "weekdays" &&
      getISODay(parseLocalDate(startDate)) > 5 &&
      !seriesWide
    ) {
      setFormError("工作日重复的首次任务必须在星期一到星期五");
      return;
    }

    if (endKind === "onDate" && recurrenceEndDate < startDate) {
      setFormError("重复截止日期不能早于开始日期");
      return;
    }

    await onSave({
      title: title.trim(),
      notes: notes.trim(),
      startDate,
      endDate,
      recurrenceKind,
      pattern: buildPattern(
        recurrenceKind,
        weeklyDays,
        startDate,
        series?.pattern,
      ),
      end:
        recurrenceKind === "none"
          ? undefined
          : endKind === "never"
            ? { kind: "never" }
            : { kind: "onDate", date: recurrenceEndDate },
      scope,
    });
  }

  return (
    <Modal isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Backdrop variant="blur">
        <Modal.Container placement="center" scroll="inside" size="md">
          <Modal.Dialog className="task-dialog" aria-labelledby="task-dialog-title">
            <Modal.Header className="task-dialog__header">
              <div>
                <p className="section-kicker">任务详情</p>
                <Modal.Heading id="task-dialog-title">编辑任务</Modal.Heading>
              </div>
              <Modal.CloseTrigger className="dialog-close" aria-label="关闭">
                <X size={19} />
              </Modal.CloseTrigger>
            </Modal.Header>

            <Modal.Body className="task-dialog__body">
              <form id="task-editor-form" noValidate onSubmit={handleSubmit}>
                <TextField className="editor-field">
                  <Label>标题</Label>
                  <Input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    required
                    maxLength={200}
                    autoFocus
                  />
                </TextField>

                <div className="date-fields">
                  <TextField className="editor-field">
                    <Label>开始日期</Label>
                    <Input
                      type="date"
                      value={startDate}
                      disabled={seriesWide}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (!value) return;
                        setStartDate(value);
                        if (endDate < value || task.seriesId) setEndDate(value);
                        setFormError(null);
                      }}
                    />
                  </TextField>

                  <TextField className="editor-field">
                    <Label>截止日期</Label>
                    <Input
                      type="date"
                      min={startDate}
                      value={endDate}
                      disabled={seriesWide}
                      onChange={(event) => {
                        if (!event.target.value) return;
                        setEndDate(event.target.value);
                        setFormError(null);
                      }}
                    />
                  </TextField>
                </div>

                <p className="date-hint">
                  {seriesWide
                    ? "“此项及以后”会保留较早的实例，只更新后续重复规则。"
                    : task.seriesId
                      ? "重复任务实例只能改期到另一个单独日期。"
                      : "任务会显示在开始日期到截止日期之间的每一天。"}
                </p>

                <fieldset className="recurrence-fields">
                  <legend>重复</legend>

                  {series ? (
                    <label className="editor-select-field">
                      <span>编辑范围</span>
                      <select
                        aria-label="编辑范围"
                        value={scope}
                        onChange={(event) => {
                          const value = event.target.value as RecurrenceEditScope;
                          setScope(value);
                          if (value === "series") {
                            setStartDate(task.startDate);
                            setEndDate(task.endDate);
                          }
                          setFormError(null);
                        }}
                      >
                        <option value="occurrence">仅此项</option>
                        <option value="series">此项及以后</option>
                      </select>
                    </label>
                  ) : null}

                  <label className="editor-select-field">
                    <span>重复规则</span>
                    <select
                      aria-label="重复"
                      value={recurrenceKind}
                      disabled={Boolean(series && !seriesWide)}
                      onChange={(event) => {
                        setRecurrenceKind(event.target.value as RecurrenceKind);
                        setFormError(null);
                      }}
                    >
                      <option value="none" disabled={Boolean(series)}>
                        不重复
                      </option>
                      <option value="daily">每天</option>
                      <option value="weekdays">工作日</option>
                      <option value="weekly">每周</option>
                      <option value="monthly">每月</option>
                    </select>
                  </label>

                  {recurrenceKind === "weekly" ? (
                    <fieldset className="weekly-options" disabled={Boolean(series && !seriesWide)}>
                      <legend>每周重复日期</legend>
                      <div>
                        {WEEKDAYS.map((weekday) => (
                          <label key={weekday.value}>
                            <input
                              type="checkbox"
                              checked={weeklyDays.includes(weekday.value)}
                              onChange={(event) => {
                                setWeeklyDays((current) =>
                                  event.target.checked
                                    ? [...new Set([...current, weekday.value])].sort()
                                    : current.filter((value) => value !== weekday.value),
                                );
                                setFormError(null);
                              }}
                            />
                            <span>{weekday.label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}

                  {recurrenceKind === "monthly" ? (
                    <p className="recurrence-hint">
                      每月按开始日期重复；遇到 29、30、31 日会独立夹到当月月末。
                    </p>
                  ) : null}

                  {recurrenceKind !== "none" ? (
                    <div className="recurrence-end-fields">
                      <label className="editor-select-field">
                        <span>结束方式</span>
                        <select
                          aria-label="重复结束"
                          value={endKind}
                          disabled={Boolean(series && !seriesWide)}
                          onChange={(event) =>
                            setEndKind(event.target.value as RecurrenceEnd["kind"])
                          }
                        >
                          <option value="never">永不结束</option>
                          <option value="onDate">截止日期</option>
                        </select>
                      </label>

                      {endKind === "onDate" ? (
                        <label className="editor-native-field">
                          <span>重复截止日期</span>
                          <input
                            aria-label="重复截止日期"
                            type="date"
                            min={startDate}
                            value={recurrenceEndDate}
                            disabled={Boolean(series && !seriesWide)}
                            onChange={(event) => {
                              if (event.target.value) {
                                setRecurrenceEndDate(event.target.value);
                              }
                            }}
                          />
                        </label>
                      ) : null}
                    </div>
                  ) : null}
                </fieldset>

                {formError ? (
                  <p className="form-error" role="alert">
                    {formError}
                  </p>
                ) : null}

                <TextField className="editor-field">
                  <Label>备注</Label>
                  <TextArea
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    rows={5}
                    placeholder="补充必要的信息…"
                  />
                </TextField>
              </form>
            </Modal.Body>

            <Modal.Footer className="task-dialog__actions">
              <div>
                <Button
                  variant="danger-soft"
                  type="button"
                  isDisabled={busy}
                  onPress={() => void onDelete()}
                >
                  <Trash2 size={16} />
                  删除
                </Button>
                <Button
                  variant="secondary"
                  type="button"
                  isDisabled={busy}
                  onPress={() => void onToggleComplete()}
                >
                  {task.status === "completed" ? <RotateCcw size={16} /> : <Check size={16} />}
                  {task.status === "completed" ? "恢复任务" : "标记完成"}
                </Button>
                {series && onStopRecurrence ? (
                  <Button
                    variant="ghost"
                    type="button"
                    isDisabled={busy}
                    onPress={() => void onStopRecurrence()}
                  >
                    停止后续重复
                  </Button>
                ) : null}
              </div>
              <div>
                <Button variant="ghost" type="button" onPress={onClose}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  form="task-editor-form"
                  isDisabled={busy || !title.trim()}
                >
                  保存
                </Button>
              </div>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function buildPattern(
  kind: RecurrenceKind,
  weeklyDays: IsoWeekday[],
  startDate: string,
  existingPattern?: RecurrencePattern,
): RecurrencePattern | undefined {
  switch (kind) {
    case "none":
      return undefined;
    case "daily":
    case "weekdays":
      return { kind };
    case "weekly":
      return { kind, weekdays: [...weeklyDays].sort() };
    case "monthly":
      return {
        kind,
        dayOfMonth:
          existingPattern?.kind === "monthly"
            ? existingPattern.dayOfMonth
            : Number(startDate.slice(8, 10)),
      };
  }
}
