import { useEffect, useState } from "react";
import { agentStatusSchema, type AgentStatus } from "@newday/core/contracts/agent-planning";
import { request } from "@/shared/http/request";

/** The API samples today from the saved user time zone and its own clock.
 * Polling on the existing minute tick also invalidates the UI across midnight. */
export function usePlanningClock(clockMinute: number | null) {
  const [status, setStatus] = useState<AgentStatus>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (clockMinute === null) return;
    let generation = 0;
    let active = true;
    let controller: AbortController | undefined;
    const refresh = () => {
      const current = ++generation;
      controller?.abort();
      controller = new AbortController();
      void request<unknown>("/api/agent/status", { signal: controller.signal }).then(agentStatusSchema.parse).then((next) => {
        if (!active || current !== generation) return;
        setStatus(next);
        setUnavailable(false);
      }).catch(() => {
        if (active && current === generation) setUnavailable(true);
      });
    };
    refresh();
    window.addEventListener("newday:planning-clock-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      controller?.abort();
      window.removeEventListener("newday:planning-clock-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [clockMinute]);
  return { status, ready: status !== undefined || unavailable };
}
