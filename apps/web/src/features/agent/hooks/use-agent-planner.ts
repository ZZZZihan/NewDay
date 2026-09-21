import { useEffect, useMemo, useSyncExternalStore } from "react";
import { agentApi, type AgentApi } from "../api/agent-api";
import { AgentController } from "./agent-controller";
import { browserSessionStore, type SessionStore } from "./agent-session";

export function useAgentPlanner(
  date: string,
  callbacks: { onApplied: () => void | Promise<void>; onPreferencesChanged?: () => void },
  api: AgentApi = agentApi,
  store: SessionStore = browserSessionStore,
  enabled = true,
) {
  // Callback changes do not reset an in-flight operation. The enclosing date
  // component is keyed, and the callbacks only refresh authoritative data.
  const controller = useMemo(() => new AgentController(date, api, store, () => undefined), [date, api, store]);
  useEffect(() => {
    controller.setCallbacks(callbacks.onApplied, () => {
      window.dispatchEvent(new CustomEvent("newday:planning-clock-changed"));
      callbacks.onPreferencesChanged?.();
    });
  }, [controller, callbacks]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    if (!enabled) return;
    void controller.initialize();
    return () => controller.dispose();
  }, [controller, enabled]);
  return { state, controller };
}
