import { useCallback, useEffect, useRef, useState } from "react";
import type { LifeWorkspace } from "@newday/core/domain/life-model";
import { lifeApi } from "../api/life-api";

export function useLifeWorkspace(enabled: boolean) {
  const [workspace, setWorkspace] = useState<LifeWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const next = await lifeApi.workspace();
      if (generation !== requestGeneration.current) return;
      setWorkspace(next);
      setError(null);
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      setError(cause instanceof Error ? cause.message : "无法读取生活管理数据");
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    lifeApi.workspace(controller.signal).then((next) => {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      setWorkspace(next);
      setError(null);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      setError(cause instanceof Error ? cause.message : "无法读取生活管理数据");
    });
    return () => {
      controller.abort();
      requestGeneration.current += 1;
    };
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
