import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SQLitePlannerStore } from "../src/storage/sqlite-planner-store.js";
import { task } from "./fixtures.js";

test("file store persists records after closing and reopening the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-sqlite-"));
  const path = join(directory, "planner.sqlite");
  try {
    const first = new SQLitePlannerStore(path);
    await first.putTask(task());
    first.close();
    const second = new SQLitePlannerStore(path);
    assert.deepEqual(await second.getTask("task-1"), task());
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed transactions roll back writes, including a nested archive replacement", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    await store.putTask(task("original"));
    await assert.rejects(store.transaction(async () => {
      await store.replaceAllData({ tasks: [task("replacement")] });
      throw new Error("abort the whole operation");
    }), /abort/);
    assert.deepEqual(await store.listAllTasks(), [task("original")]);
  } finally {
    store.close();
  }
});

test("independent async transactions serialize instead of joining each other's transaction", async () => {
  const store = new SQLitePlannerStore(":memory:");
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const rejected = store.transaction(async () => {
      await store.putTask(task("rolled-back"));
      entered();
      await gate;
      throw new Error("abort first");
    });
    await firstEntered;
    const committed = store.transaction(async () => { await store.putTask(task("committed")); });
    release();
    await assert.rejects(rejected, /abort first/);
    await committed;
    assert.deepEqual((await store.listAllTasks()).map((value) => value.id), ["committed"]);
  } finally {
    store.close();
  }
});

test("SQLite enforces unique recurrence occurrence keys and preserves the first record", async () => {
  const store = new SQLitePlannerStore(":memory:");
  try {
    const first = task("one", { occurrenceKey: "series:2026-09-08" });
    await store.putTask(first);
    await assert.rejects(store.putTask({ ...first, id: "two" }), /UNIQUE/);
    assert.deepEqual(await store.getTaskByOccurrenceKey("series:2026-09-08"), first);
    assert.equal((await store.listAllTasks()).length, 1);
  } finally {
    store.close();
  }
});

test("migration marker survives reopen and archive replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newday-migration-"));
  const path = join(directory, "planner.sqlite");
  try {
    const first = new SQLitePlannerStore(path);
    assert.equal(await first.importBrowserData({ tasks: [task()] }, "hash"), "imported");
    await first.replaceAllData({ tasks: [] });
    first.close();
    const second = new SQLitePlannerStore(path);
    assert.equal(await second.importBrowserData({ tasks: [task()] }, "hash"), "already-imported");
    assert.equal(await second.importBrowserData({ tasks: [task("another-browser")] }, "new-hash"), "server-not-empty");
    assert.deepEqual(await second.listAllTasks(), []);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
