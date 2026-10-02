import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function absolutePath(value, flag) {
  if (!value || !isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  return value;
}

export async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
}

export async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a directory: ${path}`);
}

export function verifySnapshot(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw new Error("SQLite integrity_check failed");
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("SQLite foreign_key_check failed");
    }
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!tables.has("metadata") || !tables.has("tasks")) throw new Error("Not a NewDay database");
    const keys = new Set(database.prepare("SELECT key FROM metadata WHERE key IN ('dataset_epoch', 'planner_revision')").all().map((row) => row.key));
    if (keys.size !== 2) throw new Error("NewDay metadata is incomplete");
  } finally {
    database.close();
  }
}

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function syncFile(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
