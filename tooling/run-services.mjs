import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One command starts two independent processes; either can also run on its own.
const root = fileURLToPath(new URL("../", import.meta.url));
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const mode = process.argv[2] ?? "dev";
if (mode !== "dev" && mode !== "start") {
  throw new Error("Expected dev or start");
}

let temporaryData;
if (process.env.NEWDAY_TEST_RUN === "1") {
  const configured = process.env.NEWDAY_E2E_DATABASE_PATH;
  temporaryData = configured ? dirname(configured) : mkdtempSync(join(tmpdir(), "newday-e2e-"));
  if (dirname(resolve(temporaryData)) !== resolve(tmpdir()) || !temporaryData.split(/[\\/]/).at(-1)?.startsWith("newday-e2e-")) {
    throw new Error("E2E database must be in a disposable newday-e2e-* temporary directory");
  }
}
const env = {
  ...process.env,
  ...(temporaryData ? {
    NEWDAY_DATABASE_PATH: join(temporaryData, "planner.sqlite"),
    NEWDAY_NOTION_WORKER_ORIGIN: "",
    NEWDAY_NOTION_WORKER_API_KEY: "",
    NEWDAY_NOTION_CREDENTIAL_KEY: "",
  } : {}),
};
const children = [
  spawn("pnpm", ["--filter", "@newday/api", mode], { cwd: root, env, stdio: "inherit" }),
  spawn("pnpm", [
    "--filter", "@newday/web", mode,
    "--hostname", env.NEWDAY_WEB_HOST ?? "127.0.0.1",
    "--port", env.NEWDAY_WEB_PORT ?? "3000",
  ], { cwd: root, env, stdio: "inherit" }),
];

let stopping = false;
let exitCode = 0;
let remaining = children.length;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) child.kill("SIGTERM");
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("close", (code) => {
    if (!stopping) stop(code ?? 1);
    remaining -= 1;
    if (remaining === 0) {
      if (temporaryData) rmSync(temporaryData, { recursive: true, force: true });
      process.exitCode = exitCode;
    }
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
