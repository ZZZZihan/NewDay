// @vitest-environment node

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { architectureConfig } from "../../tooling/eslint/architecture.mjs";

const require = createRequire(import.meta.url);
const nextTypeScript = require("eslint-config-next/typescript") as Linter.Config[];
const parser = nextTypeScript.find((config) => config.languageOptions?.parser)?.languageOptions?.parser;
const root = fileURLToPath(new URL("../../", import.meta.url));
const linter = new Linter({ cwd: root });

function lint(filename: string, source: string) {
  return linter.verify(source, [
    { files: ["**/*.{ts,tsx}"], languageOptions: { parser, parserOptions: { ecmaVersion: "latest", sourceType: "module" } } },
    architectureConfig,
  ], { filename: path.join(root, filename) });
}

const web = "apps/web/src/features/planner/api/planner-client.ts";
const api = "apps/api/src/routes/planner.ts";
const domain = "packages/core/src/domain/planner-model.ts";
const application = "packages/core/src/application/planner-command.ts";

describe("production import boundaries", () => {
  it.each([
    [application, 'import type { Task } from "../domain/planner-model";'],
    [domain, 'import { z } from "zod";'],
    [web, 'import { taskSchema } from "@newday/core/domain/planner-model";'],
    [web, 'import type { PlannerCommand } from "@newday/core/application/planner-command";'],
    [web, 'import { type PlannerCommand } from "@newday/core/application/planner-command";'],
    [web, 'export type { PlannerCommand } from "@newday/core/application/planner-command";'],
    [web, 'type Command = import("@newday/core/application/planner-command").PlannerCommand;'],
    [web, 'import type { PlannerCommand } from "../../../../../../packages/core/src/application/planner-command";'],
    [api, 'import { executePlannerCommand } from "@newday/core/application/planner-command";'],
    [api, 'import { plannerService } from "@/services/planner-service";'],
    ["apps/api/src/services/planner-service.ts", 'import { store } from "../storage/sqlite-planner-store";'],
    ["apps/web/src/features/planner/migration/legacy-backup.ts", 'import { parsePlannerBackup } from "@newday/core/contracts/planner-backup";'],
    ["tests/support/example.ts", 'import { executePlannerCommand } from "../../packages/core/src/application/planner-command";'],
  ])("allows the intended dependency from %s: %s", (filename, source) => {
    // No filtering: a parser error or unmatched ESLint config must also fail.
    expect(lint(filename, source)).toEqual([]);
  });

  it.each([
    [domain, 'import { executePlannerCommand } from "../application/planner-command";', "Domain must not"],
    [domain, 'export type { PlannerCommand } from "@newday/core/application/planner-command";', "Domain must not"],
    [domain, 'type Command = import("@newday/core/application/planner-command").PlannerCommand;', "Domain must not"],
    [application, 'import { useState } from "react";', "Core must stay"],
    [application, 'import Dexie from "dexie";', "Core must stay"],
    [application, 'import { readFile } from "node:fs/promises";', "Core must stay"],
    [application, 'import { readFile } from "fs/promises";', "Core must stay"],
    [application, 'import { api } from "../../../../apps/api/src/app";', "Core must stay"],
    [web, 'import { executePlannerCommand } from "@newday/core/application/planner-command";', "application types only"],
    [web, 'import { type PlannerCommand, executePlannerCommand } from "@newday/core/application/planner-command";', "application types only"],
    [web, 'export * from "@newday/core/application/planner-command";', "application types only"],
    [web, 'const commands = import("@newday/core/application/planner-command");', "application types only"],
    [web, 'import { executePlannerCommand } from "../../../../../../packages/core/src/application/planner-command";', "application types only"],
    [web, 'import { service } from "../../../../../api/src/services/planner";', "HTTP API"],
    [web, 'import { service } from "@newday/api/services/planner";', "HTTP API"],
    [web, 'const fs = require("node:fs");', "HTTP API"],
    [web, 'type File = import("node:fs").Dirent;', "HTTP API"],
    [api, 'import { component } from "@newday/web/features/planner/components/day-planner";', "API must not"],
    [api, 'export { component } from "../../../web/src/features/planner/components/day-planner";', "API must not"],
    [api, 'const dexie = import("dexie");', "API must not"],
    [api, 'import type { Metadata } from "next";', "API must not"],
    ["apps/api/src/storage/sqlite-planner-store.ts", 'import { routes } from "@/routes/planner";', "Storage must not"],
    ["apps/api/src/storage/sqlite-planner-store.ts", 'import { routes } from "@/http/planner-routes";', "Storage must not"],
    ["apps/api/src/storage/sqlite-planner-store.ts", 'import { ApiError } from "../http/api-error";', "Storage must not"],
    ["apps/api/src/storage/sqlite-planner-store.ts", 'import { service } from "../services/planner";', "Storage must not"],
    [application, 'import { MemoryPlannerStore } from "../../../../tests/support/memory-planner-store";', "test code"],
    [web, 'import { vi } from "vitest";', "test code"],
    [api, 'import { fixture } from "@/routes/planner.test";', "test code"],
    ["apps/web/src/features/planner/components/day-planner.tsx", 'import { createPlannerBackup } from "@newday/core/application/planner-backup";', "application types only"],
    ["apps/web/src/features/planner/migration/legacy-backup.ts", 'import { createPlannerBackup } from "@newday/core/application/planner-backup";', "application types only"],
    ["apps/web/src/features/planner/migration/legacy-backup.ts", 'import { executePlannerCommand } from "@newday/core/application/planner-command";', "application types only"],
  ])("rejects a forbidden dependency from %s: %s", (filename, source, message) => {
    const messages = lint(filename, source);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ ruleId: "architecture/import-boundaries", severity: 2 });
    expect(messages[0].message).toContain(message);
  });
});

describe("core browser independence", () => {
  it.each([
    "window.location.reload();",
    'localStorage.getItem("tasks");',
    'indexedDB.open("newday");',
    'globalThis.document.createElement("a");',
    'globalThis["localStorage"].getItem("tasks");',
    'typeof window !== "undefined";',
  ])("rejects browser access: %s", (source) => {
    expect(lint(application, source)).toEqual([
      expect.objectContaining({ ruleId: "architecture/import-boundaries", message: expect.stringContaining("browser global") }),
    ]);
  });

  it("does not confuse local identifiers or object keys with browser globals", () => {
    expect(lint(domain, 'function label(window: string) { return { window, document: window }; }')).toEqual([]);
  });

  it("allows portable JavaScript globals used by business rules", () => {
    expect(lint(application, 'const id = crypto.randomUUID(); const copy = structuredClone({ at: new Date() });')).toEqual([]);
  });

  it("allows browser APIs in the frontend", () => {
    expect(lint(web, 'const theme = window.localStorage.getItem("theme");')).toEqual([]);
  });
});
