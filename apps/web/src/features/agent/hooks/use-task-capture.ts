import { useEffect, useMemo, useSyncExternalStore } from "react";
import { taskCaptureApi, type TaskCaptureApi } from "../api/task-capture-api";
import { TaskCaptureController } from "./task-capture-controller";
import { browserCaptureSessionStore, type CaptureSessionStore } from "./task-capture-session";

export function useTaskCapture(onApplied: () => void | Promise<void>, writable: boolean, enabled: boolean, api: TaskCaptureApi = taskCaptureApi, store: CaptureSessionStore = browserCaptureSessionStore) {
  const controller = useMemo(() => new TaskCaptureController(api, store), [api, store]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { controller.setCallback(onApplied); }, [controller, onApplied]);
  useEffect(() => { controller.setWritable(writable && Boolean(state.status?.configured)); }, [controller, writable, state.status]);
  useEffect(() => {
    if (!enabled) return;
    void controller.initialize();
    return () => controller.dispose();
  }, [controller, enabled]);
  return { state, controller };
}
