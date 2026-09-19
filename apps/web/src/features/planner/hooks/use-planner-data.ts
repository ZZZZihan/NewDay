import { useCallback, useEffect, useRef, useState } from "react";
import type { DayPlan, RecurrenceSeries } from "@newday/core/domain/planner-model";

import { plannerApi } from "../api/planner-api";

const POLL_INTERVAL_MS = 15_000;

export function usePlannerData(
  selectedDate: string | null,
  today: string,
  enabled: boolean,
) {
  const [result, setResult] = useState<{ key: string; plan: DayPlan }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [refreshing, setRefreshing] = useState(false);
  const requests = useRef<{ latestId: number; controller: AbortController | null }>({
    latestId: 0,
    controller: null,
  });
  const key = `${selectedDate}:${today}`;

  const fetchPlan = useCallback(() => {
    if (!selectedDate || !enabled) return Promise.resolve();
    const lifecycle = requests.current;
    const requestId = ++lifecycle.latestId;
    lifecycle.controller?.abort();
    const pending = new AbortController();
    lifecycle.controller = pending;
    return plannerApi.day(selectedDate, today, pending.signal).then((plan) => {
      if (requestId !== lifecycle.latestId) return;
      setResult({ key: `${selectedDate}:${today}`, plan });
      setFailure(undefined);
    }).catch((failure: unknown) => {
      if (pending.signal.aborted || requestId !== lifecycle.latestId) return;
      setFailure({ key: `${selectedDate}:${today}`, message: failure instanceof Error ? failure.message : "无法读取任务，请重试" });
    }).finally(() => {
      if (requestId === lifecycle.latestId) setRefreshing(false);
    });
  }, [enabled, selectedDate, today]);

  const currentRefresh = useRef<() => Promise<void>>(async () => undefined);
  // Mutations can finish after date navigation. Their refresh always targets
  // the currently selected date instead of the handler's captured old date.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await currentRefresh.current();
  }, []);

  useEffect(() => {
    const lifecycle = requests.current;
    currentRefresh.current = fetchPlan;
    void fetchPlan();
    const revalidateVisible = () => {
      if (document.visibilityState === "visible") void fetchPlan();
    };
    const interval = window.setInterval(revalidateVisible, POLL_INTERVAL_MS);
    window.addEventListener("focus", revalidateVisible);
    document.addEventListener("visibilitychange", revalidateVisible);
    return () => {
      ++lifecycle.latestId;
      currentRefresh.current = async () => undefined;
      lifecycle.controller?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", revalidateVisible);
      document.removeEventListener("visibilitychange", revalidateVisible);
    };
  }, [fetchPlan]);

  return {
    dayPlan: enabled && result?.key === key ? result.plan : undefined,
    error: failure?.key === key ? failure.message : null,
    refreshing: refreshing || (enabled && selectedDate !== null && result?.key !== key && failure?.key !== key),
    refresh,
  };
}

export function usePlannerSeries(
  seriesId: string | undefined,
  taskRevision: string | undefined,
  refreshRevision?: DayPlan,
) {
  const key = `${seriesId}:${taskRevision}`;
  const [result, setResult] = useState<{ key: string; series: RecurrenceSeries | null }>();
  const [settled, setSettled] = useState<{
    key: string;
    refreshRevision?: DayPlan;
    retry: number;
    error: string | null;
  }>();
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!seriesId) return;
    const controller = new AbortController();
    let active = true;
    void plannerApi.series(seriesId, controller.signal).then((series) => {
      if (active) {
        setResult({ key, series });
        setSettled({ key, refreshRevision, retry, error: series ? null : "该重复规则已不存在，请刷新任务列表" });
      }
    }).catch((failure: unknown) => {
      if (!active || controller.signal.aborted) return;
      setSettled({ key, refreshRevision, retry, error: failure instanceof Error ? failure.message : "无法读取重复规则" });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, refreshRevision, retry, seriesId]);

  const current = settled?.key === key && settled?.refreshRevision === refreshRevision && settled?.retry === retry;

  return {
    series: result?.key === key ? result?.series ?? undefined : undefined,
    error: seriesId && current ? settled.error : null,
    loading: Boolean(seriesId && !current),
    retry: () => setRetry((value) => value + 1),
  };
}
