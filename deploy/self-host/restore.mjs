import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { absolutePath, directory, regularFile, sha256, syncDirectory, syncFile, verifySnapshot } from "./sqlite-utils.mjs";

function options(argv) {
  if (argv.length !== 5 || argv[0] !== "--database" || argv[2] !== "--backup" || argv[4] !== "--offline-confirmed") {
    throw new Error("Usage: restore.mjs --database ABSOLUTE_PATH --backup ABSOLUTE_PATH --offline-confirmed");
  }
  return { databasePath: absolutePath(argv[1], "--database"), backupPath: absolutePath(argv[3], "--backup") };
}

function checkSystemd() {
  if (process.platform !== "linux") return;
  for (const unit of ["newday-api.service", "newday-web.service", "newday-backup.service"]) {
    const result = spawnSync("systemctl", ["is-active", "--quiet", unit], { stdio: "ignore" });
    if (result.error) throw new Error(`Cannot check ${unit}: ${result.error.message}`);
    if (result.status === 0) throw new Error(`${unit} is active; stop the app services and wait for backup work before restore`);
  }
}

async function existingRegularFile(path) {
  try {
    await regularFile(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function main() {
  const { databasePath, backupPath } = options(process.argv.slice(2));
  if (resolve(databasePath) === resolve(backupPath)) throw new Error("The backup and destination must differ");
  checkSystemd();
  await regularFile(backupPath);
  await directory(dirname(databasePath));
  verifySnapshot(backupPath);
  const expectedHash = await sha256(backupPath);

  const stageDir = await mkdtemp(join(dirname(databasePath), ".newday-restore-stage-"));
  const previousDir = await mkdtemp(join(dirname(databasePath), ".newday-pre-restore-"));
  await chmod(stageDir, 0o700);
  await chmod(previousDir, 0o700);
  const staged = join(stageDir, basename(databasePath));
  const moved = [];
  let installed = false;
  let succeeded = false;
  let rollbackComplete = false;
  try {
    await copyFile(backupPath, staged, constants.COPYFILE_EXCL);
    await chmod(staged, 0o600);
    verifySnapshot(staged);
    if (await sha256(staged) !== expectedHash) throw new Error("Backup changed while being copied");
    await syncFile(staged);

    for (const suffix of ["", "-wal", "-shm"]) {
      const original = `${databasePath}${suffix}`;
      if (!(await existingRegularFile(original))) continue;
      const saved = join(previousDir, `${basename(databasePath)}${suffix}`);
      await rename(original, saved);
      moved.push({ original, saved });
    }
    await rename(staged, databasePath);
    installed = true;
    await syncDirectory(dirname(databasePath));
    console.log(JSON.stringify({ restored: databasePath, sha256: expectedHash, previousFiles: moved.length ? previousDir : null }));
    succeeded = true;
  } catch (error) {
    try {
      if (installed) await rename(databasePath, staged);
      for (const item of moved.reverse()) await rename(item.saved, item.original);
      await syncDirectory(dirname(databasePath));
      rollbackComplete = true;
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Restore failed; inspect ${stageDir} and ${previousDir} before restarting`);
    }
    throw error;
  } finally {
    if (succeeded || rollbackComplete) await rm(stageDir, { recursive: true });
    if (rollbackComplete || (succeeded && moved.length === 0)) await rm(previousDir, { recursive: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
