import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Client } from "@notionhq/client";
import type { NotionConnection, NotionTaskMapping } from "@newday/core/contracts/notion-sync";

import type { NotionReadGateway, ReadRow, ReadTable } from "../src/services/notion-read-gateway.js";
import { NotionReadService } from "../src/services/notion-read-service.js";
import { NotionSdkTaskTransport } from "../src/services/notion-task-transport.js";
import { NotionCredentialVault } from "../src/storage/notion-credential-vault.js";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";

const workspaceId = "credential-revision-workspace";
const credentialKey = Buffer.alloc(32, 44);
const observedAt = "2026-09-21T00:00:00.000Z";

function claim(vault: NotionCredentialVault, stateCharacter: string, token: string): void {
  const state = stateCharacter.repeat(43);
  vault.putPending(state, "verifier", Date.parse(observedAt) + 60_000, Date.parse(observedAt));
  assert.ok(vault.storeClaimed(state, {
    access_token: token,
    refresh_token: `refresh-${token}`,
    bot_id: "bot",
    workspace_id: workspaceId,
    workspace_name: "Credential revision test",
  }, observedAt));
}

function connection(credentialRevision: number): NotionConnection {
  const source = (name: string, propertyIds: Record<string, string> = {}) => ({
    databaseId: `database-${name}`,
    dataSourceId: `source-${name}`,
    propertyIds,
    schemaFingerprint: `fingerprint-${name}`,
  });
  return {
    workspaceId,
    installationId: "install",
    rootPageId: "root",
    credentialRevision,
    status: "active",
    updatedAt: observedAt,
    dataSources: {
      areas: source("areas", { Name: "area-name" }),
      projects: source("projects", { Name: "project-name", Area: "project-area" }),
      tasks: source("tasks", {
        Name: "task-name",
        "Plan Date": "task-date",
        Completed: "task-done",
        "NewDay Key": "task-key",
        Project: "task-project",
        "Direct Area": "task-area",
        Rule: "task-rule",
      }),
      rules: source("rules", { Name: "rule-name" }),
    },
  };
}

test("read scan rejects rows when another process replaces the credential during a remote request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-read-credential-revision-"));
  const vaultPath = join(directory, "vault.sqlite");
  const vault = new NotionCredentialVault(vaultPath, credentialKey);
  const store = new SQLitePlannerStore(":memory:");
  try {
    claim(vault, "a", "old-token");
    const revision = vault.getCredentialLease(workspaceId)!.revision;
    await store.putNotionConnection(connection(revision));
    let replaced = false;
    const gateway: NotionReadGateway = {
      async scan(token: string, _connection: NotionConnection, table: ReadTable): Promise<ReadRow[]> {
        assert.equal(token, "old-token");
        if (!replaced) {
          replaced = true;
          const replacement = new NotionCredentialVault(vaultPath, credentialKey);
          try { claim(replacement, "b", "new-token"); } finally { replacement.close(); }
        }
        return table === "areas" ? [{
          id: "area-remote",
          url: "https://www.notion.so/area-remote",
          createdAt: observedAt,
          editedAt: observedAt,
          inTrash: false,
          kind: "area",
          title: "Area",
        }] : [];
      },
      async readKnownPage() { return null; },
    };
    const service = new NotionReadService(store, vault, gateway, () => Date.parse(observedAt));

    await assert.rejects(service.scan(workspaceId), /授权或本地数据在扫描期间改变/);
    assert.deepEqual(await store.listNotionReadNodes(workspaceId), []);
    const watermark = (await store.listNotionScanWatermarks())
      .find((item) => item.dataSourceId === "source-areas");
    assert.equal(watermark?.lastSuccessAt, null);
  } finally {
    store.close();
    vault.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("default create isolates an uncertain result and blocks the next stale credential before HTTP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-write-credential-revision-"));
  const vaultPath = join(directory, "vault.sqlite");
  const vault = new NotionCredentialVault(vaultPath, credentialKey);
  try {
    claim(vault, "c", "old-token");
    const revision = vault.getCredentialLease(workspaceId)!.revision;
    const current = connection(revision);
    let creates = 0;
    const fakeClient = { pages: { create: async () => {
      creates += 1;
      const replacement = new NotionCredentialVault(vaultPath, credentialKey);
      try { claim(replacement, "d", "new-token"); } finally { replacement.close(); }
      return { id: "remote-page" };
    } } } as unknown as Client;
    const transport = new NotionSdkTaskTransport(vault, () => fakeClient);
    const mapping: NotionTaskMapping = {
      localTaskId: "task",
      workspaceId,
      dataSourceId: "source-tasks",
      remotePageId: null,
      clientKey: "newday:install:task",
      baseline: null,
      status: "pending_create",
      updatedAt: observedAt,
    };

    await assert.rejects(transport.createPage(current, mapping,
      { title: "Task", date: ["2026-09-21", "2026-09-21"], completed: false }),
    /credential changed during remote request/);
    assert.equal(creates, 1);
    await assert.rejects(transport.createPage(current, mapping,
      { title: "Task", date: ["2026-09-21", "2026-09-21"], completed: false }),
    /create setup failed before sending HTTP/);
    assert.equal(creates, 1);
  } finally {
    vault.close();
    await rm(directory, { recursive: true, force: true });
  }
});
