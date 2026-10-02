import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { absolutePath, directory, regularFile, sha256, syncDirectory, syncFile, verifySnapshot } from "./sqlite-utils.mjs";

function options(argv) {
  if (argv.length !== 4 || argv[0] !== "--database" || argv[2] !== "--output-dir") {
    throw new Error("Usage: backup.mjs --database ABSOLUTE_PATH --output-dir ABSOLUTE_DIRECTORY");
  }
  return { databasePath: absolutePath(argv[1], "--database"), outputDir: absolutePath(argv[3], "--output-dir") };
}

async function main() {
  const { databasePath, outputDir } = options(process.argv.slice(2));
  await regularFile(databasePath);
  await directory(outputDir);
  const workDir = await mkdtemp(join(outputDir, ".newday-backup-"));
  await chmod(workDir, 0o700);
  const staged = join(workDir, "snapshot.sqlite");
  try {
    const source = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
    try { await backup(source, staged); } finally { source.close(); }
    await chmod(staged, 0o600);
    verifySnapshot(staged);
    const digest = await sha256(staged);
    await syncFile(staged);
    const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
    const output = join(outputDir, `newday-${timestamp}-${randomUUID()}.sqlite`);
    await rename(staged, output);
    await syncDirectory(outputDir);
    console.log(JSON.stringify({ backup: output, sha256: digest, integrity: "ok", source: basename(databasePath) }));
  } finally {
    await rm(workDir, { recursive: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
