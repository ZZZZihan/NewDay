import { request as httpRequest } from "@/shared/http/request";
import type { PlannerBackup } from "@newday/core/contracts/planner-backup";
import type {
  PlannerCommand,
  StopRecurrenceImpact,
} from "@newday/core/application/planner-command";
import type { DayPlan, RecurrenceSeries, Task } from "@newday/core/domain/planner-model";

export type CommandReceipt = { token: string };
export type MigrationResult = {
  status: "imported" | "already-imported" | "server-not-empty";
};

// A module belongs to one browser tab. Unlike localStorage (and copied
// sessionStorage), this identifier cannot give a second tab the same undo owner.
let clientId: string | undefined;

function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("x-newday-client", (clientId ??= crypto.randomUUID()));
  return httpRequest<T>(`/api/planner${path}`, { ...options, headers });
}

function post<T>(path: string, body: unknown) {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export const plannerApi = {
  day(selectedDate: string, asOfDate: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ selectedDate, asOfDate });
    return request<DayPlan>(`/day?${query}`, { signal });
  },
  series(id: string, signal?: AbortSignal) {
    return request<RecurrenceSeries | null>(`/series/${encodeURIComponent(id)}`, { signal });
  },
  commands(commands: readonly PlannerCommand[], expectedTask?: Task) {
    return post<{ receipt: CommandReceipt | null }>("/commands", {
      commands,
      ...(expectedTask ? { expectedTask } : {}),
    });
  },
  undo(receipt: CommandReceipt) {
    return post<{ ok: true }>("/undo", { receipt });
  },
  backup() {
    return request<PlannerBackup>("/backup");
  },
  restore(source: string) {
    return post<{ ok: true }>("/backup", { source });
  },
  stopPreview(seriesId: string, endDate: string) {
    return post<StopRecurrenceImpact>("/stop-preview", { seriesId, endDate });
  },
  migrate(source: string) {
    return post<MigrationResult>("/migrate", { source });
  },
};
