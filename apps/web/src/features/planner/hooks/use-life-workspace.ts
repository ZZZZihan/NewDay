import { useCallback, useEffect, useRef, useState } from "react";
import type { LifeWorkspace } from "@newday/core/domain/life-model";
import { lifeApi } from "../api/life-api";

const LIFE_WORKSPACE_POLL_INTERVAL_MS = 30_000;

export function useLifeWorkspace(enabled: boolean) {
  const [workspace, setWorkspace] = useState<LifeWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requests = useRef<{ latestId: number; controller: AbortController | null }>({
    latestId: 0,
    controller: null,
  });

  const fetchWorkspace = useCallback(async () => {
    if (!enabled) return;
    const lifecycle = requests.current;
    const requestId = ++lifecycle.latestId;
    lifecycle.controller?.abort();
    const controller = new AbortController();
    lifecycle.controller = controller;
    try {
      const next = await lifeApi.workspace(controller.signal);
      if (controller.signal.aborted || requestId !== lifecycle.latestId) return;
      setWorkspace(next);
      setError(null);
    } catch (cause) {
      if (controller.signal.aborted || requestId !== lifecycle.latestId) return;
      setError(cause instanceof Error ? cause.message : "无法读取生活管理数据");
    }
  }, [enabled]);

  const currentRefresh = useRef<() => Promise<void>>(async () => undefined);
  const refresh = useCallback(() => currentRefresh.current(), []);

  useEffect(() => {
    const lifecycle = requests.current;
    currentRefresh.current = fetchWorkspace;
    if (!enabled) return () => { currentRefresh.current = async () => undefined; };

    let interval: number | null = null;
    const stopPolling = () => {
      if (interval !== null) window.clearInterval(interval);
      interval = null;
    };
    const startPolling = () => {
      stopPolling();
      if (document.visibilityState === "visible") {
        interval = window.setInterval(() => { void fetchWorkspace(); }, LIFE_WORKSPACE_POLL_INTERVAL_MS);
      }
    };
    const revalidateVisible = () => {
      if (document.visibilityState === "visible") void fetchWorkspace();
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "visible") {
        void fetchWorkspace();
        startPolling();
      } else {
        stopPolling();
      }
    };

    const initial = window.setTimeout(() => { void fetchWorkspace(); }, 0);
    startPolling();
    window.addEventListener("focus", revalidateVisible);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      ++lifecycle.latestId;
      currentRefresh.current = async () => undefined;
      lifecycle.controller?.abort();
      window.clearTimeout(initial);
      stopPolling();
      window.removeEventListener("focus", revalidateVisible);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [enabled, fetchWorkspace]);

  async function mutate(operation: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(true);
    try {
      await operation();
      await refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { workspace, error, busy, refresh, mutate };
}
