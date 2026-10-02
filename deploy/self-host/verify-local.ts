import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SQLitePlannerStore } from "../../apps/api/src/storage/sqlite-planner-store.js";

const packageDir = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(tmpdir(), "newday-self-host-check-"));
const databasePath = join(root, "state", "newday.sqlite");
const backupDir = join(root, "backups");
let writer: DatabaseSync | undefined;

function run(script: string, args: string[]) {
  return JSON.parse(execFileSync(process.execPath, [join(packageDir, script), ...args], { encoding: "utf8" })) as Record<string, string | null>;
}

try {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(backupDir, { mode: 0o700 });
  const store = new SQLitePlannerStore(databasePath);
  store.close();

  // Keep the writer open so the snapshot must include a committed WAL change.
  writer = new DatabaseSync(databasePath);
  writer.exec("PRAGMA journal_mode = WAL");
  writer.prepare("INSERT INTO metadata(key, value) VALUES('self_host_probe', ?)").run("before-backup");
  const backup = run("backup.mjs", ["--database", databasePath, "--output-dir", backupDir]);
  assert.equal(backup.integrity, "ok");
  assert.match(String(backup.sha256), /^[a-f0-9]{64}$/);
  const snapshot = new DatabaseSync(String(backup.backup), { readOnly: true });
  assert.equal(snapshot.prepare("SELECT value FROM metadata WHERE key = 'self_host_probe'").get()?.value, "before-backup");
  snapshot.close();

  writer.prepare("UPDATE metadata SET value = ? WHERE key = 'self_host_probe'").run("after-backup");
  writer.close();
  writer = undefined;
  const restore = run("restore.mjs", ["--database", databasePath, "--backup", String(backup.backup), "--offline-confirmed"]);
  assert.equal(restore.restored, databasePath);
  const recovered = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(recovered.prepare("SELECT value FROM metadata WHERE key = 'self_host_probe'").get()?.value, "before-backup");
  recovered.close();
  assert.ok(restore.previousFiles);
  const previous = new DatabaseSync(join(String(restore.previousFiles), "newday.sqlite"), { readOnly: true });
  assert.equal(previous.prepare("SELECT value FROM metadata WHERE key = 'self_host_probe'").get()?.value, "after-backup");
  previous.close();

  const corrupt = join(backupDir, "corrupt.sqlite");
  await writeFile(corrupt, "not a database");
  const rejected = spawnSync(process.execPath, [join(packageDir, "restore.mjs"), "--database", databasePath, "--backup", corrupt, "--offline-confirmed"], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  const stillRecovered = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(stillRecovered.prepare("SELECT value FROM metadata WHERE key = 'self_host_probe'").get()?.value, "before-backup");
  stillRecovered.close();

  const apiUnit = await readFile(join(packageDir, "systemd/newday-api.service"), "utf8");
  const webUnit = await readFile(join(packageDir, "systemd/newday-web.service"), "utf8");
  const nginx = await readFile(join(packageDir, "nginx/newday.conf"), "utf8");
  const apiEnv = await readFile(join(packageDir, "api.env.example"), "utf8");
  const webEnv = await readFile(join(packageDir, "web.env.example"), "utf8");
  const carryzApiEnv = await readFile(join(packageDir, "targets/carryz/api.env"), "utf8");
  const carryzWebEnv = await readFile(join(packageDir, "targets/carryz/web.env"), "utf8");
  const carryzNginx = await readFile(join(packageDir, "targets/carryz/newday.nginx.conf"), "utf8");
  const webLayout = await readFile(join(packageDir, "../../apps/web/src/app/layout.tsx"), "utf8");
  assert.match(apiUnit, /^User=newday-api$/m);
  assert.match(apiUnit, /^StateDirectoryMode=0700$/m);
  assert.match(apiUnit, /^ProtectSystem=strict$/m);
  assert.match(webUnit, /^User=newday-web$/m);
  assert.match(webUnit, /--hostname \$\{NEWDAY_WEB_HOST\} --port \$\{NEWDAY_WEB_PORT\}/);
  assert.match(webUnit, /^ProtectSystem=strict$/m);
  assert.match(apiEnv, /^NEWDAY_API_HOST=127\.0\.0\.1$/m);
  assert.match(apiEnv, /^NEWDAY_DATABASE_PATH=\/var\/lib\/newday\/newday\.sqlite$/m);
  assert.match(apiEnv, /^NEWDAY_AGENT_PROVIDER=disabled$/m);
  assert.match(webEnv, /^NEWDAY_WEB_HOST=127\.0\.0\.1$/m);
  assert.match(webEnv, /^NEWDAY_WEB_PORT=3000$/m);
  assert.match(nginx, /auth_basic_user_file \/etc\/nginx\/newday\.htpasswd;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.doesNotMatch(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3001/);
  assert.match(carryzApiEnv, /^NEWDAY_WEB_ORIGIN=https:\/\/172\.23\.1\.127:8443$/m);
  assert.match(carryzWebEnv, /^NEWDAY_WEB_HOST=127\.0\.0\.1$/m);
  assert.match(carryzWebEnv, /^NEWDAY_WEB_PORT=3100$/m);
  assert.match(carryzNginx, /^\s*listen 172\.23\.1\.127:8443 ssl;$/m);
  assert.match(carryzNginx, /proxy_pass http:\/\/127\.0\.0\.1:3100;/);
  assert.doesNotMatch(carryzNginx, /^\s*listen (?:80|443)(?:\s|;)/m);
  assert.doesNotMatch(carryzNginx, /proxy_pass http:\/\/127\.0\.0\.1:3000/);
  assert.doesNotMatch(carryzNginx, /Strict-Transport-Security/);
  assert.match(webLayout, /from "geist\/font\/sans"/);
  assert.match(webLayout, /@fontsource-variable\/noto-serif-sc\/wght\.css/);
  assert.doesNotMatch(webLayout, /next\/font\/google/);

  console.log("PASS: WAL snapshot, integrity and hash, offline restore, rollback copy, corrupt-backup rejection, private service/proxy configuration, and network-independent web fonts");
} finally {
  writer?.close();
  await rm(root, { recursive: true });
}
