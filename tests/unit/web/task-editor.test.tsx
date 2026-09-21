import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DatedTask, RecurrenceSeries } from "@newday/core/domain/planner-model";
import { TaskEditor } from "@/features/planner/components/task-editor";

const NOW = "2026-09-01T08:00:00.000Z";

const task: DatedTask = {
  id: "task-1",
  title: "单项标题",
  notes: "单项备注",
  startDate: "2026-09-05",
  endDate: "2026-09-05",
  status: "open",
  createdAt: NOW,
  updatedAt: NOW,
  completedAt: null,
  completedOn: null,
  seriesId: "series-segment-1",
  logicalSeriesId: "logical-series-1",
  occurrenceDate: "2026-09-02",
  occurrenceKey: "logical-series-1:2026-09-02",
  isSeriesException: true,
};

const series: RecurrenceSeries = {
  id: "series-segment-1",
  logicalSeriesId: "logical-series-1",
  title: "系列标题",
  notes: "系列备注",
  startDate: "2026-09-01",
  effectiveEndDate: null,
  pattern: { kind: "daily" },
  end: { kind: "never" },
  excludedDates: [],
  createdAt: NOW,
  updatedAt: NOW,
};

describe("TaskEditor", () => {
  it("keeps occurrence and series drafts isolated across scope changes", async () => {
    const user = userEvent.setup();
    render(
      <TaskEditor
        task={task}
        series={series}
        busy={false}
        onClose={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        onToggleComplete={vi.fn(async () => undefined)}
        onDelete={vi.fn(async () => undefined)}
        onStopRecurrence={vi.fn(async () => undefined)}
      />,
    );

    const editor = await screen.findByRole("dialog", { name: "编辑任务" });
    const scope = within(editor).getByLabelText("编辑范围");
    const title = within(editor).getByLabelText("标题");
    const notes = within(editor).getByLabelText("备注");
    const startDate = within(editor).getByLabelText("开始日期");
    const endDate = within(editor).getByLabelText("截止日期");

    await user.clear(title);
    await user.type(title, "修改后的单项标题");
    await user.clear(notes);
    await user.type(notes, "修改后的单项备注");
    fireEvent.change(startDate, { target: { value: "2026-09-06" } });

    await user.selectOptions(scope, "series");
    expect(title).toHaveValue("系列标题");
    expect(notes).toHaveValue("系列备注");
    expect(startDate).toHaveValue("2026-09-02");
    expect(endDate).toHaveValue("2026-09-02");
    expect(startDate).toBeDisabled();
    expect(endDate).toBeDisabled();

    await user.clear(title);
    await user.type(title, "修改后的系列标题");
    await user.clear(notes);
    await user.type(notes, "修改后的系列备注");

    await user.selectOptions(scope, "occurrence");
    expect(title).toHaveValue("修改后的单项标题");
    expect(notes).toHaveValue("修改后的单项备注");
    expect(startDate).toHaveValue("2026-09-06");
    expect(endDate).toHaveValue("2026-09-06");
    expect(startDate).toBeEnabled();
    expect(endDate).toBeEnabled();

    await user.selectOptions(scope, "series");
    expect(title).toHaveValue("修改后的系列标题");
    expect(notes).toHaveValue("修改后的系列备注");
  });

  it("hides tail actions for an occurrence beyond the stopped cutoff", async () => {
    render(
      <TaskEditor
        task={task}
        series={{
          ...series,
          end: { kind: "onDate", date: "2026-09-03" },
        }}
        allowSeriesActions={false}
        busy={false}
        onClose={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        onToggleComplete={vi.fn(async () => undefined)}
        onDelete={vi.fn(async () => undefined)}
        onStopRecurrence={vi.fn(async () => undefined)}
      />,
    );

    const editor = await screen.findByRole("dialog", { name: "编辑任务" });
    expect(within(editor).queryByLabelText("编辑范围")).not.toBeInTheDocument();
    expect(
      within(editor).queryByRole("button", { name: "停止后续重复" }),
    ).not.toBeInTheDocument();
    expect(within(editor).getByLabelText("重复", { exact: true })).toBeDisabled();
    expect(within(editor).getByLabelText("标题")).toHaveValue(task.title);
  });

  it("validates only the active occurrence scope", async () => {
    const onSave = vi.fn(async () => undefined);
    render(
      <TaskEditor
        task={task}
        series={{
          ...series,
          end: { kind: "onDate", date: "2026-09-03" },
        }}
        busy={false}
        onClose={vi.fn()}
        onSave={onSave}
        onToggleComplete={vi.fn(async () => undefined)}
        onDelete={vi.fn(async () => undefined)}
        onStopRecurrence={vi.fn(async () => undefined)}
      />,
    );

    const editor = await screen.findByRole("dialog", { name: "编辑任务" });
    fireEvent.submit(editor.querySelector("form")!);

    expect(within(editor).queryByRole("alert")).not.toBeInTheDocument();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "occurrence",
        startDate: task.startDate,
        endDate: task.endDate,
      }),
    );
  });
});
