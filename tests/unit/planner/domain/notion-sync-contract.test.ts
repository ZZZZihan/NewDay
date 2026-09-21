import { describe, expect, it } from "vitest";

import { notionReadTaskContextSchema } from "../../../../packages/core/src/contracts/notion-sync";

const context = (url: string) => ({
  localTaskId: "local-task",
  workspaceId: "workspace",
  remotePageId: "remote-page",
  url,
  projectPageId: null,
  areaPageId: null,
  updatedAt: "2026-09-21T05:00:00.000Z",
});

describe("Notion page URL contract", () => {
  it("accepts the current app.notion.com page URL and legacy notion.so URLs", () => {
    expect(notionReadTaskContextSchema.safeParse(context("https://app.notion.com/p/Task-abc")).success).toBe(true);
    expect(notionReadTaskContextSchema.safeParse(context("https://www.notion.so/Task-abc")).success).toBe(true);
  });

  it("rejects insecure and lookalike hosts", () => {
    expect(notionReadTaskContextSchema.safeParse(context("http://app.notion.com/p/Task-abc")).success).toBe(false);
    expect(notionReadTaskContextSchema.safeParse(context("https://app.notion.com.evil.test/p/Task-abc")).success).toBe(false);
  });
});
