import { describe, expect, it } from "vitest";
import { assertSystemdOffline, isConfirmedOffline } from "../../../deploy/self-host/systemd-offline.mjs";

const state = (changes: Record<string, string> = {}) => Object.entries({
  LoadState: "loaded", ActiveState: "inactive", SubState: "dead", MainPID: "0", ControlPID: "0", Job: "", ...changes,
}).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
const remainingWorkStates: Record<string, string>[] = [{ Job: "42" }, { MainPID: "42" }, { ControlPID: "42" }, { SubState: "start" }, { LoadState: "error" }];

describe("offline restore systemd boundary", () => {
  it("accepts confirmed inactive, failed and absent units with no job or process", () => {
    expect(isConfirmedOffline(state())).toBe(true);
    expect(isConfirmedOffline(state({ ActiveState: "failed", SubState: "failed" }))).toBe(true);
    expect(isConfirmedOffline(state({ LoadState: "not-found" }))).toBe(true);
    expect(isConfirmedOffline(state({ Job: "0" }))).toBe(true);
    expect(() => assertSystemdOffline(() => ({ status: 0, stdout: state(), error: undefined }))).not.toThrow();
  });

  it.each(["active", "activating", "deactivating", "reloading", "unknown"])("rejects %s even when an is-active-style probe would return nonzero", (ActiveState) => {
    expect(isConfirmedOffline(state({ ActiveState }))).toBe(false);
  });

  it.each(remainingWorkStates)("rejects remaining work or invalid state %j", (changes) => {
    expect(isConfirmedOffline(state(changes))).toBe(false);
  });

  it("fails closed on missing properties, duplicate fields, query failure or timeout", () => {
    expect(isConfirmedOffline(state().replace("Job=\n", ""))).toBe(false);
    expect(isConfirmedOffline(state()+"ActiveState=inactive\n")).toBe(false);
    expect(() => assertSystemdOffline(() => ({ status: 1, stdout: state(), error: undefined }))).toThrow("not confirmed offline");
    expect(() => assertSystemdOffline(() => ({ status: null, stdout: "", error: new Error("timeout") }))).toThrow("not confirmed offline");
  });

  it("checks the backup job as well as both application units", () => {
    const checked: string[] = [];
    expect(() => assertSystemdOffline((unit) => {
      checked.push(unit);
      return { status: 0, stdout: state(unit === "newday-backup.service" ? { ActiveState: "activating", SubState: "start", Job: "42" } : {}), error: undefined };
    })).toThrow("newday-backup.service");
    expect(checked).toEqual(["newday-api.service", "newday-web.service", "newday-backup.service"]);
  });
});
