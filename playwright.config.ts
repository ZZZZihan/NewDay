import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Inherited by test workers; fixtures can reset migration metadata only in
// this disposable database, never in the user's development store.
const databasePath = process.env.NEWDAY_E2E_DATABASE_PATH ??=
  join(mkdtempSync(join(tmpdir(), "newday-e2e-")), "planner.sqlite");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
      },
    },
    {
      name: "safari-webkit",
      use: {
        ...devices["Desktop Safari"],
      },
    },
  ],
  webServer: {
    command: "node tooling/run-services.mjs dev",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    env: {
      NEWDAY_TEST_RUN: "1",
      NEWDAY_AGENT_PROVIDER: "scripted",
      NEWDAY_DATABASE_PATH: databasePath,
      NEWDAY_E2E_DATABASE_PATH: databasePath,
      NEWDAY_WEB_PORT: "3100",
      NEWDAY_API_PORT: "3002",
      NEWDAY_API_ORIGIN: "http://127.0.0.1:3002",
      NEWDAY_WEB_ORIGIN: "http://127.0.0.1:3100",
      // E2E always uses fake HTTP responses; a developer's real .env must not
      // open their Notion credential vault or permit live OAuth calls.
      NEWDAY_NOTION_WORKER_ORIGIN: "",
      NEWDAY_NOTION_WORKER_API_KEY: "",
      NEWDAY_NOTION_CREDENTIAL_KEY: "",
    },
    timeout: 120_000,
  },
});
