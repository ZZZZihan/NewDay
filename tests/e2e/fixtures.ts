import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test as base } from "@playwright/test";

/** Every browser context uses one isolated API database, so browser storage
 * isolation alone is no longer enough to make planner tests independent. */
export const test = base.extend<{ resetPlanner: void }>({
  resetPlanner: [async ({ request, baseURL }, use) => {
    // A replacement import is destructive. Never allow this fixture to reset
    // a manually running development or production instance.
    expect(baseURL, "E2E resets are restricted to the isolated test web server")
      .toBe("http://127.0.0.1:3100");
    const databasePath = process.env.NEWDAY_E2E_DATABASE_PATH;
    expect(databasePath, "The test runner must expose its isolated SQLite path").toBeTruthy();
    const path = resolve(databasePath!);
    expect(dirname(dirname(path))).toBe(resolve(tmpdir()));
    expect(basename(dirname(path))).toMatch(/^newday-e2e-/);
    expect(basename(path)).toBe("planner.sqlite");
    expect(existsSync(path)).toBe(true);
    const response = await request.post("/api/planner/backup", {
      headers: { "x-newday-client": "e2e-reset" },
      data: {
        source: JSON.stringify({
          format: "newday-backup",
          version: 5,
          exportedAt: new Date().toISOString(),
          tasks: [],
          recurrenceSeries: [],
          focusRecords: [],
          inboxItems: [],
          folders: [],
          resources: [],
          resourceTaskLinks: [],
        }),
      },
    });
    expect(response.ok(), `Could not reset test API: ${await response.text()}`).toBe(true);

    // Real restores intentionally keep the migration marker to stop stale
    // browsers from resurrecting an earlier snapshot. Clear it only inside
    // the temporary E2E database, so each test also starts with a fresh server.
    const database = new DatabaseSync(path);
    try {
      database.prepare("DELETE FROM metadata WHERE key = 'browser_import_hash'").run();
      // Planner imports intentionally preserve Agent history and the lifetime
      // execution ledger. Each E2E case is a fresh installation, so reset all
      // Agent tables only after the path/origin checks above prove isolation.
      database.exec("DELETE FROM agent_records; DELETE FROM planner_events; DELETE FROM execution_ledger;");
    } finally {
      database.close();
    }
    await use();
  }, { auto: true }],
});

export { expect } from "@playwright/test";
