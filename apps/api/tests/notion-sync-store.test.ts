import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { notionClientKey, type NotionConnection, type NotionOutboxOperation, type NotionTaskMapping } from "@newday/core/contracts/notion-sync";
import { createPlannerBackup, parsePlannerBackup, restorePlannerBackup } from "@newday/core/application/planner-backup";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";
import { task } from "./fixtures.js";

const at = "2026-09-21T00:00:00.000Z";
const fields = { title: "整理项目", date: ["2026-09-08", "2026-09-08"] as [string, string], completed: false };

function connection(status: NotionConnection["status"] = "active"): NotionConnection {
  return { workspaceId: "workspace-1", installationId: "install-1", rootPageId: "root-1", dataSources: {}, status, updatedAt: at };
}

function mapping(localTaskId = "task-1", remotePageId: string | null = null): NotionTaskMapping {
  return {
    localTaskId, workspaceId: "workspace-1", dataSourceId: "tasks-source-1", remotePageId,
    clientKey: notionClientKey("install-1", localTaskId), baseline: remotePageId ? fields : null,
    status: remotePageId ? "active" : "pending_create", updatedAt: at,
  };
}

async function operation(store: SQLitePlannerStore, operationId = "operation-1", localTaskId = "task-1", baseline: NotionOutboxOperation["baseline"] = null): Promise<NotionOutboxOperation> {
  return {
    operationId, localTaskId, workspaceId: "workspace-1",
    datasetEpoch: (await store.getPlanningVersion()).datasetEpoch,
    desired: fields, baseline, status: "pending", attemptCount: 0,
    createdAt: at, lastAttemptAt: null, confirmedAt: null,
  };
}

test("task change and matching outbox either commit together or both roll back", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await store.putTask(task());
    await store.putNotionConnection(connection());
    await store.putNotionTaskMapping(mapping());
    const before = await store.getPlanningVersion();
    await assert.rejects(store.transaction(async () => {
      await store.putTask({ ...task(), title: "Changed" });
      await store.enqueueNotionOutbox({ ...await operation(store), desired: { ...fields, title: "Changed" } });
      throw new Error("abort business transaction");
    }), /abort business transaction/);
    assert.deepEqual(await store.getTask("task-1"), task());
    assert.deepEqual(await store.listNotionOutboxOperations(), []);
    assert.deepEqual(await store.getPlanningVersion(), before);

    await store.transaction(async () => {
      await store.putTask({ ...task(), title: "Changed" });
      await store.enqueueNotionOutbox({ ...await operation(store), desired: { ...fields, title: "Changed" } });
    });
    assert.equal((await store.getTask("task-1"))?.title, "Changed");
    assert.equal((await store.listNotionOutboxOperations()).length, 1);
    assert.equal((await store.getPlanningVersion()).plannerRevision, before.plannerRevision + 1);
  } finally { store.close(); }
});

test("a restarted send becomes unknown and pauses its workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-outbox-"));
  const path = join(directory, "planner.sqlite");
  try {
    const first = new SQLitePlannerStore(path);
    await first.putTask(task());
    await first.putNotionConnection(connection());
    await first.putNotionTaskMapping(mapping());
    await first.enqueueNotionOutbox(await operation(first));
    const sending = await first.markNotionOutboxSending("operation-1", at);
    assert.equal(sending.status, "sending");
    assert.equal(sending.attemptCount, 1);
    first.close();

    const second = new SQLitePlannerStore(path);
    assert.equal((await second.getNotionOutboxOperation("operation-1"))?.status, "unknown");
    assert.equal((await second.getNotionConnection("workspace-1"))?.status, "paused_unknown");
    await assert.rejects(second.markNotionOutboxSending("operation-1", at), /not pending/);
    second.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("opening another store does not recover a live sender as an unknown attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-live-sender-"));
  const path = join(directory, "planner.sqlite");
  try {
    const sender = new SQLitePlannerStore(path);
    try {
      await sender.putTask(task());
      await sender.putNotionConnection(connection());
      await sender.putNotionTaskMapping(mapping());
      await sender.enqueueNotionOutbox(await operation(sender));
      const sending = await sender.markNotionOutboxSending("operation-1", at);
      assert.equal(sending.sendingOwner?.pid, process.pid);

      const observer = new SQLitePlannerStore(path);
      try {
        assert.equal((await observer.getNotionOutboxOperation("operation-1"))?.status, "sending");
        assert.equal((await observer.getNotionConnection("workspace-1"))?.status, "active");
        assert.equal(await sender.confirmNotionOutbox("operation-1", "remote-1", fields, at), "confirmed");
        assert.equal((await observer.getNotionOutboxOperation("operation-1"))?.status, "confirmed");
      } finally { observer.close(); }
    } finally { sender.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a second process recovers a sender that exits between recovery and claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-process-sender-"));
  const path = join(directory, "planner.sqlite");
  try {
    const seed = new SQLitePlannerStore(path);
    try {
      await seed.putTask(task());
      await seed.putNotionConnection(connection());
      await seed.putNotionTaskMapping(mapping());
      await seed.enqueueNotionOutbox(await operation(seed));
    } finally { seed.close(); }

    const moduleUrl = new URL("../src/storage/sqlite-planner-store.ts", import.meta.url).href;
    const childCode = `import { SQLitePlannerStore } from ${JSON.stringify(moduleUrl)};
      const store = new SQLitePlannerStore(process.argv[1]);
      await store.markNotionOutboxSending("operation-1", ${JSON.stringify(at)});
      process.stdout.write("READY\\n");
      process.stdin.resume();
      await new Promise((resolve) => process.stdin.once("end", resolve));
      store.close();`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode, path], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const [ready] = await once(child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
      assert.equal((ready as Buffer).toString(), "READY\n", stderr);
      const observer = new SQLitePlannerStore(path);
      try {
        assert.equal((await observer.getNotionOutboxOperation("operation-1"))?.status, "sending");
        assert.equal((await observer.getNotionConnection("workspace-1"))?.status, "active");
        await observer.enqueueNotionOutbox(await operation(observer, "operation-2"));
        const originalTransaction = observer.transaction.bind(observer);
        let transactions = 0;
        observer.transaction = (<T>(work: () => Promise<T>) => {
          const result = originalTransaction(work);
          if (++transactions !== 1) return result;
          return result.then(async (value) => {
            // The first committed recovery saw a live process. It exits before
            // the claim transaction starts, exercising the second check.
            assert.equal((await observer.getNotionOutboxOperation("operation-1"))?.status, "sending");
            child.stdin.end();
            if (child.exitCode === null) await once(child, "exit", { signal: AbortSignal.timeout(5_000) });
            assert.equal(child.exitCode, 0, stderr);
            return value;
          });
        }) as typeof observer.transaction;
        await assert.rejects(observer.markNotionOutboxSending("operation-2", at), /connection is paused/);
        assert.equal((await observer.getNotionOutboxOperation("operation-1"))?.status, "unknown");
        assert.equal((await observer.getNotionOutboxOperation("operation-2"))?.status, "pending");
        assert.equal((await observer.getNotionConnection("workspace-1"))?.status, "paused_unknown");
      } finally { observer.close(); }
      const recovered = new SQLitePlannerStore(path);
      try {
        assert.equal((await recovered.getNotionOutboxOperation("operation-1"))?.status, "unknown");
        assert.equal((await recovered.getNotionConnection("workspace-1"))?.status, "paused_unknown");
      } finally { recovered.close(); }
    } finally {
      if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("closing a sender store pauses its workspace even while its process remains alive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-closed-sender-"));
  const path = join(directory, "planner.sqlite");
  try {
    const seed = new SQLitePlannerStore(path);
    try {
      await seed.putTask(task());
      await seed.putNotionConnection(connection());
      await seed.putNotionTaskMapping(mapping());
      await seed.enqueueNotionOutbox(await operation(seed));
    } finally { seed.close(); }

    const moduleUrl = new URL("../src/storage/sqlite-planner-store.ts", import.meta.url).href;
    const childCode = `import { SQLitePlannerStore } from ${JSON.stringify(moduleUrl)};
      const store = new SQLitePlannerStore(process.argv[1]);
      await store.markNotionOutboxSending("operation-1", ${JSON.stringify(at)});
      process.stdout.write("READY\\n");
      process.stdin.once("data", () => {
        store.close();
        process.stdout.write("CLOSED\\n");
        process.stdin.resume();
      });`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode, path], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const [ready] = await once(child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
      assert.equal((ready as Buffer).toString(), "READY\n", stderr);
      const observer = new SQLitePlannerStore(path);
      try {
        assert.equal((await observer.getNotionOutboxOperation("operation-1"))?.status, "sending");
        await observer.enqueueNotionOutbox(await operation(observer, "operation-2"));
        child.stdin.write("CLOSE\n");
        const [closed] = await once(child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
        assert.equal((closed as Buffer).toString(), "CLOSED\n", stderr);
        assert.equal(child.exitCode, null, "the owner process is still alive");
        assert.equal((await observer.getNotionOutboxOperation("operation-1"))?.status, "unknown");
        assert.equal((await observer.getNotionConnection("workspace-1"))?.status, "paused_unknown");
        await assert.rejects(observer.markNotionOutboxSending("operation-2", at), /connection is paused/);
      } finally { observer.close(); }
    } finally {
      child.stdin.end();
      if (child.exitCode === null) await once(child, "exit", { signal: AbortSignal.timeout(5_000) });
      assert.equal(child.exitCode, 0, stderr);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("mapping uniqueness and queued intent replacement cannot overwrite a send in progress", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await store.putTask(task());
    await store.putTask(task("task-2"));
    await store.putNotionConnection(connection());
    await store.putNotionTaskMapping(mapping("task-1", "remote-1"));
    await assert.rejects(store.putNotionTaskMapping(mapping("task-2", "remote-1")), /UNIQUE/);
    await store.enqueueNotionOutbox(await operation(store, "operation-1", "task-1", fields));
    await store.enqueueNotionOutbox(await operation(store, "operation-2", "task-1", fields));
    assert.equal((await store.getNotionOutboxOperation("operation-1"))?.status, "superseded");
    assert.equal((await store.getNotionOutboxOperation("operation-2"))?.status, "pending");
    await store.markNotionOutboxSending("operation-2", at);
    await store.enqueueNotionOutbox(await operation(store, "operation-3", "task-1", fields));
    await assert.rejects(store.markNotionOutboxSending("operation-3", at), /unresolved send/);
  } finally { store.close(); }
});

test("read-back confirmation advances metadata without changing the planner revision", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await store.putTask(task());
    await store.putNotionConnection(connection());
    await store.putNotionTaskMapping(mapping());
    await store.enqueueNotionOutbox(await operation(store));
    const version = await store.getPlanningVersion();
    await store.markNotionOutboxSending("operation-1", at);
    assert.equal(await store.confirmNotionOutbox("operation-1", "remote-1", { ...fields, title: "Different" }, at), "unknown");
    assert.equal((await store.getNotionConnection("workspace-1"))?.status, "paused_unknown");
    assert.equal(await store.confirmNotionOutbox("operation-1", "remote-1", fields, at), "confirmed");
    assert.equal((await store.getNotionTaskMapping("task-1"))?.remotePageId, "remote-1");
    assert.deepEqual((await store.getNotionTaskMapping("task-1"))?.baseline, fields);
    assert.equal((await store.getNotionOutboxOperation("operation-1"))?.status, "confirmed");
    assert.deepEqual(await store.getPlanningVersion(), version);
  } finally { store.close(); }
});

test("an old-epoch response is quarantined instead of accepted as current", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await store.putTask(task());
    await store.putNotionConnection(connection());
    await store.putNotionTaskMapping(mapping());
    await store.enqueueNotionOutbox(await operation(store));
    await store.markNotionOutboxSending("operation-1", at);
    await store.rotateDatasetEpoch();

    assert.equal(await store.confirmNotionOutbox("operation-1", "remote-1", fields, at), "quarantined");
    assert.equal((await store.getNotionOutboxOperation("operation-1"))?.status, "quarantined");
    assert.equal((await store.getNotionConnection("workspace-1"))?.status, "paused_unknown");
    assert.equal((await store.getNotionTaskMapping("task-1"))?.remotePageId, null);
  } finally { store.close(); }
});

test("a newer queued intent rebases on the prior confirmed read-back", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await store.putTask(task());
    await store.putNotionConnection(connection());
    await store.putNotionTaskMapping(mapping());
    await store.enqueueNotionOutbox(await operation(store));
    await store.markNotionOutboxSending("operation-1", at);
    await store.putTask(task("task-1", { title: "更新后的标题" }));
    await store.enqueueNotionOutbox({
      ...await operation(store, "operation-2"),
      desired: { ...fields, title: "更新后的标题" },
    });
    assert.equal(await store.confirmNotionOutbox("operation-1", "remote-1", fields, at), "confirmed");
    assert.deepEqual((await store.getNotionOutboxOperation("operation-2"))?.baseline, fields);
    assert.equal((await store.markNotionOutboxSending("operation-2", at)).status, "sending");
  } finally { store.close(); }
});

test("a queued intent already satisfied by read-back needs no duplicate send", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await store.putTask(task());
    await store.putNotionConnection(connection());
    await store.putNotionTaskMapping(mapping());
    await store.enqueueNotionOutbox(await operation(store));
    await store.markNotionOutboxSending("operation-1", at);
    await store.enqueueNotionOutbox(await operation(store, "operation-2"));
    assert.equal(await store.confirmNotionOutbox("operation-1", "remote-1", fields, at), "confirmed");
    assert.equal((await store.getNotionOutboxOperation("operation-2"))?.status, "confirmed");
    await assert.rejects(store.markNotionOutboxSending("operation-2", at), /not pending/);
  } finally { store.close(); }
});

test("v5 replacement clears mappings but fences a prior remote structure", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await store.putTask(task());
    await store.putNotionConnection(connection());
    await store.putNotionTaskMapping(mapping());
    const before = await store.getPlanningVersion();
    await store.replaceAllData({ tasks: [task()] });
    assert.deepEqual(await store.getTask("task-1"), task());
    assert.notEqual((await store.getPlanningVersion()).datasetEpoch, before.datasetEpoch);
    assert.equal(await store.getNotionTaskMapping("task-1"), undefined);
    const [guard] = await store.listNotionConnections();
    assert.equal(guard.workspaceId, "workspace-1");
    assert.equal(guard.rootPageId, "root-1");
    assert.equal(guard.status, "paused_after_restore");
  } finally { store.close(); }
});

test("v6 backup preserves mappings but restores every unfinished send in quarantine", async () => {
  const source = new SQLitePlannerStore(":memory:");
  const target = new SQLitePlannerStore(":memory:");
  try {
    await source.putTask(task());
    await source.putNotionConnection(connection());
    await source.putNotionTaskMapping(mapping("task-1", "remote-1"));
    await source.enqueueNotionOutbox(await operation(source, "operation-1", "task-1", fields));
    const backup = await createPlannerBackup(source, at);
    assert.equal(backup.version, 6);
    await restorePlannerBackup(target, JSON.stringify(backup));

    assert.equal((await target.getNotionConnection("workspace-1"))?.status, "paused_after_restore");
    assert.equal((await target.getNotionTaskMapping("task-1"))?.remotePageId, "remote-1");
    assert.equal((await target.getNotionOutboxOperation("operation-1"))?.status, "quarantined");
    assert.notEqual((await target.getPlanningVersion()).datasetEpoch,
      (await source.getPlanningVersion()).datasetEpoch);
    await assert.rejects(target.markNotionOutboxSending("operation-1", at), /not pending/);
  } finally { source.close(); target.close(); }
});

test("an earlier v6 conflict export without a winner remains importable", async () => {
  const source = new SQLitePlannerStore(":memory:");
  const target = new SQLitePlannerStore(":memory:");
  try {
    await source.putTask(task());
    await source.putNotionConnection(connection());
    await source.putNotionTaskMapping(mapping("task-1", "remote-1"));
    await source.appendNotionConflict({ id: "conflict-1", localTaskId: "task-1", workspaceId: "workspace-1",
      field: "title", baseline: "原始", local: "本地", remote: "Notion", winner: "notion", recordedAt: at });
    const exported = await createPlannerBackup(source, at);
    if (exported.version !== 6) throw new Error("expected v6 backup");
    const earlier = structuredClone(exported);
    delete (earlier.notionSync.conflicts[0] as Partial<typeof earlier.notionSync.conflicts[number]>).winner;
    const normalized = parsePlannerBackup(JSON.stringify(earlier));
    if (normalized.version !== 6) throw new Error("expected normalized v6 backup");
    assert.equal(normalized.notionSync.conflicts[0]?.winner, "notion");
    await restorePlannerBackup(target, JSON.stringify(earlier));
    assert.equal((await target.listNotionConflicts())[0]?.winner, "notion");
  } finally { source.close(); target.close(); }
});

test("conflicts persisted by the earlier v4 database read with the Notion decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-legacy-conflict-"));
  const path = join(directory, "planner.sqlite");
  try {
    const initial = new SQLitePlannerStore(path);
    try {
      await initial.putTask(task());
      await initial.putNotionConnection(connection());
      await initial.putNotionTaskMapping(mapping("task-1", "remote-1"));
      await initial.appendNotionConflict({ id: "conflict-1", localTaskId: "task-1", workspaceId: "workspace-1",
        field: "title", baseline: "原始", local: "本地", remote: "Notion", winner: "notion", recordedAt: at });
    } finally { initial.close(); }
    const legacy = new DatabaseSync(path);
    try { legacy.exec("UPDATE notion_conflicts SET payload=json_remove(payload, '$.winner')"); }
    finally { legacy.close(); }
    const reopened = new SQLitePlannerStore(path);
    try {
      assert.equal((await reopened.listNotionConflicts())[0]?.winner, "notion");
      const exported = await createPlannerBackup(reopened, at);
      if (exported.version !== 6) throw new Error("expected v6 backup");
      assert.equal(exported.notionSync.conflicts[0]?.winner, "notion");
    } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("v6 duplicate remote mappings reject before replacing any data", async () => {
  const source = new SQLitePlannerStore(":memory:");
  const target = new SQLitePlannerStore(":memory:");
  try {
    await source.putTask(task());
    await source.putNotionConnection(connection());
    await source.putNotionTaskMapping(mapping("task-1", "remote-1"));
    const valid = await createPlannerBackup(source, at);
    assert.equal(valid.version, 6);
    if (valid.version !== 6) throw new Error("expected v6 backup");
    const invalid = {
      ...valid,
      tasks: [...valid.tasks, task("task-2")],
      notionSync: {
        ...valid.notionSync,
        taskMappings: [...valid.notionSync.taskMappings, mapping("task-2", "remote-1")],
      },
    };
    await target.putTask(task("existing"));
    const before = await target.getPlanningVersion();
    assert.throws(() => parsePlannerBackup(JSON.stringify(invalid)), /远端映射重复/);
    await assert.rejects(restorePlannerBackup(target, JSON.stringify(invalid)), /远端映射重复/);
    assert.deepEqual(await target.listAllTasks(), [task("existing")]);
    assert.deepEqual(await target.getPlanningVersion(), before);
  } finally { source.close(); target.close(); }
});

test("v6 business backup rejects credential-shaped fields", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await store.putTask(task());
    await store.putNotionConnection(connection());
    const backup = await createPlannerBackup(store, at);
    if (backup.version !== 6) throw new Error("expected v6 backup");
    const withSecret = {
      ...backup,
      notionSync: {
        ...backup.notionSync,
        connections: [{ ...backup.notionSync.connections[0], accessToken: "must-not-be-imported" }],
      },
    };
    assert.throws(() => parsePlannerBackup(JSON.stringify(withSecret)), /Unrecognized key/);
    assert.equal(JSON.stringify(backup).includes("accessToken"), false);
  } finally { store.close(); }
});

test("restore keeps an earlier in-flight send outside the replaced dataset", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await store.putTask(task());
    await store.putNotionConnection(connection());
    await store.putNotionTaskMapping(mapping());
    await store.enqueueNotionOutbox(await operation(store));
    await store.markNotionOutboxSending("operation-1", at);
    await store.pauseNotionForRestore();
    assert.equal((await store.getNotionConnection("workspace-1"))?.status, "paused_after_restore");
    await store.replaceAllData({ tasks: [task()] });

    const quarantined = await store.listNotionRestoreQuarantine();
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0]?.operation.operationId, "operation-1");
    assert.deepEqual(await store.listNotionOutboxOperations(), []);
    await store.putNotionConnection(connection());
    await store.putNotionTaskMapping(mapping());
    await store.enqueueNotionOutbox(await operation(store, "operation-2"));
    await assert.rejects(store.markNotionOutboxSending("operation-2", at), /unresolved pre-restore send/);
  } finally { store.close(); }
});

test("a version 3 database gains sync tables without changing existing planner data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-notion-migration-"));
  const path = join(directory, "planner.sqlite");
  try {
    const before = new SQLitePlannerStore(path);
    await before.putTask(task());
    const planningVersion = await before.getPlanningVersion();
    before.close();

    // A synthetic v3 fixture keeps the previous planner tables and metadata.
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE notion_read_task_contexts;
        DROP TABLE notion_read_nodes;
        DROP TABLE notion_restore_quarantine;
        DROP TABLE notion_scan_watermarks;
        DROP TABLE notion_conflicts;
        DROP TABLE notion_outbox;
        DROP TABLE notion_task_mappings;
        DROP TABLE notion_rule_mappings;
        DROP TABLE notion_initialization_steps;
        DROP TABLE notion_connections;
        PRAGMA user_version=3;
        COMMIT;
      `);
      assert.equal(legacy.prepare("PRAGMA user_version").get()?.user_version, 3);
    } finally { legacy.close(); }

    const migrated = new SQLitePlannerStore(path);
    try {
      assert.deepEqual(await migrated.getTask("task-1"), task());
      assert.deepEqual(await migrated.getPlanningVersion(), planningVersion);
      assert.deepEqual(await migrated.listNotionConnections(), []);
      await migrated.putNotionConnection(connection());
      await migrated.putNotionTaskMapping(mapping());
    } finally { migrated.close(); }

    const reopened = new DatabaseSync(path);
    try { assert.equal(reopened.prepare("PRAGMA user_version").get()?.user_version, 7); }
    finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
