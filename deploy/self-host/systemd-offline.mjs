import { spawnSync } from "node:child_process";

const properties = ["LoadState", "ActiveState", "SubState", "MainPID", "ControlPID", "Job"];
const units = ["newday-api.service", "newday-web.service", "newday-backup.service"];

export function isConfirmedOffline(stdout) {
  const fields = new Map();
  for (const line of stdout.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) return false;
    const key = line.slice(0, separator);
    if (!properties.includes(key) || fields.has(key)) return false;
    fields.set(key, line.slice(separator + 1));
  }
  if (fields.size !== properties.length) return false;
  return ["loaded", "not-found", "masked"].includes(fields.get("LoadState"))
    && ((fields.get("ActiveState") === "inactive" && fields.get("SubState") === "dead")
      || (fields.get("ActiveState") === "failed" && fields.get("SubState") === "failed"))
    && fields.get("MainPID") === "0" && fields.get("ControlPID") === "0"
    && ["", "0"].includes(fields.get("Job"));
}

function queryUnit(unit) {
  const result = spawnSync("systemctl", ["show", ...properties.map((property) => `--property=${property}`), "--", unit],
    { encoding: "utf8", timeout: 5_000 });
  return { status: result.status, stdout: result.stdout ?? "", error: result.error };
}

export function assertSystemdOffline(query = queryUnit) {
  for (const unit of units) {
    const result = query(unit);
    if (result.error || result.status !== 0 || !isConfirmedOffline(result.stdout))
      throw new Error(`${unit} is not confirmed offline; stop the app services, wait for all jobs and processes, and verify systemd before restore`);
  }
}
