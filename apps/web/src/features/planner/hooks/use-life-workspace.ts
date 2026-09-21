import { useCallback, useEffect, useState } from "react";
import type { LifeWorkspace } from "@newday/core/domain/life-model";
import { lifeApi } from "../api/life-api";

export function useLifeWorkspace(enabled: boolean) {
  const [workspace, setWorkspace] = useState<LifeWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await lifeApi.workspace();
      setWorkspace(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取生活管理数据");
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    lifeApi.workspace(controller.signal).then((next) => {
      setWorkspace(next);
      setError(null);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取生活管理数据");
    });
    return () => controller.abort();
  }, [enabled]);

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
