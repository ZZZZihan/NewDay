#!/usr/bin/env node

// Run locally on CarryZ. Every probe reads files or runs an inspection command;
// this program does not create files, invoke a shell, or manage services.
import { spawnSync } from "node:child_process";
import { constants, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const MIB = 1024 * 1024;
const RELEASE_PREFIX = "/opt/newday/releases/";
const UNIT_NAMES = ["newday-api.service", "newday-web.service", "newday-backup.service", "newday-backup.timer"];
const UNIT_PATHS = UNIT_NAMES.map((name) => `/etc/systemd/system/${name}`);
const NGINX_CONFIG = "/etc/nginx/conf.d/newday.conf";
const OFF_HOST_CONFIG = "/etc/newday/off-host-backup.json";
const PROFILE_DIR = dirname(fileURLToPath(import.meta.url));
const BIN = Object.freeze({
  uname: "/usr/bin/uname", getent: "/usr/bin/getent", findmnt: "/usr/bin/findmnt",
  df: "/usr/bin/df", ss: "/usr/bin/ss", systemctl: "/usr/bin/systemctl",
  systemdAnalyze: "/usr/bin/systemd-analyze",
});

export const EXPECTED_BINDINGS = Object.freeze({
  api: "127.0.0.1:3001",
  web: "127.0.0.1:3100",
  nginx: "172.23.1.127:8443",
});

function readText(path, maxBytes = 256 * 1024) {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > maxBytes) return null;
    return readFileSync(path, "utf8");
  } catch { return null; }
}

function fileInfo(path) {
  try {
    const info = lstatSync(path);
    return {
      kind: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      uid: info.uid, gid: info.gid, mode: info.mode & 0o7777, size: info.size,
    };
  } catch { return null; }
}

function releaseTreeSafe(root, cache) {
  const stack = [root];
  let scanned = 0;
  try {
    while (stack.length) {
      const path = stack.pop();
      if (path === cache) continue;
      const info = lstatSync(path);
      scanned += 1;
      if (scanned > 500_000 || info.uid !== 0 || (!info.isSymbolicLink() && (info.mode & 0o022))) return false;
      if (info.isSymbolicLink()) {
        const target = realpathSync.native(path);
        if (!target.startsWith(`${root}/`)) return false;
      } else if (info.isDirectory()) {
        for (const name of readdirSync(path)) stack.push(join(path, name));
      }
    }
    return true;
  } catch { return false; }
}

function readableReleaseFile(root, path) {
  try {
    const target = realpathSync.native(path);
    if (!target.startsWith(`${root}/`)) return false;
    const info = statSync(target);
    if (!info.isFile() || info.uid !== 0 || !(info.mode & 0o004)) return false;
    let directory = dirname(target);
    while (directory.startsWith(root)) {
      const parent = statSync(directory);
      if (!parent.isDirectory() || parent.uid !== 0 || !(parent.mode & 0o001)) return false;
      if (directory === root) break;
      directory = dirname(directory);
    }
    return true;
  } catch { return false; }
}

export function rootOwnedExecutable(path) {
  try {
    if (typeof path !== "string" || !path.startsWith("/")) return false;
    let pending = path.split("/").filter(Boolean);
    let parents = [];
    let links = 0;
    const root = lstatSync("/");
    if (!root.isDirectory() || root.uid !== 0 || (root.mode & 0o022) || !(root.mode & 0o001)) return false;
    while (pending.length) {
      const part = pending.shift();
      if (part === ".") continue;
      if (part === "..") { parents.pop(); continue; }
      const current = join("/", ...parents, part);
      const info = lstatSync(current);
      if (info.uid !== 0) return false;
      if (info.isSymbolicLink()) {
        if (++links > 40) return false;
        const target = readlinkSync(current);
        if (target.startsWith("/")) parents = [];
        // Expand links before interpreting '..', as the kernel does. Lexical
        // normalization here could skip a writable intermediate target.
        pending = [...target.split("/").filter(Boolean), ...pending];
        continue;
      }
      if ((info.mode & 0o022) || !(info.mode & 0o001)) return false;
      if (!pending.length) return info.isFile();
      if (!info.isDirectory()) return false;
      parents.push(part);
    }
    return false;
  } catch { return false; }
}

export function resolveLinuxSwc(root) {
  try {
    const actualRoot = realpathSync.native(root);
    const nextPackage = join(actualRoot, "apps/web/node_modules/next/package.json");
    const require = createRequire(realpathSync.native(nextPackage));
    const path = require.resolve("@next/swc-linux-x64-gnu/next-swc.linux-x64-gnu.node");
    return realpathSync.native(path).startsWith(`${actualRoot}/`) ? path : null;
  } catch { return null; }
}

function processUsesNode(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    const executable = `/proc/${pid}/exe`;
    const running = statSync(executable); const installed = statSync("/usr/bin/node");
    return realpathSync.native(executable) === realpathSync.native("/usr/bin/node")
      && running.dev === installed.dev && running.ino === installed.ino;
  }
  catch { return false; }
}

function inspectCommand(file, args, timeout = 5_000) {
  try {
    const result = spawnSync(file, args, {
      encoding: "utf8", timeout, maxBuffer: 256 * 1024, shell: false,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C",
        COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_AUTO_PIN: "0" },
    });
    return { ok: result.status === 0 && !result.error, output: result.stdout ?? "" };
  } catch { return { ok: false, output: "" }; }
}

function parseOsRelease(source) {
  const value = (key) => source?.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.replace(/^"|"$/g, "") ?? null;
  return { id: value("ID"), version: value("VERSION_ID") };
}

function parseAccount(output) {
  const fields = output.trim().split(":");
  if (fields.length < 7) return null;
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  return Number.isInteger(uid) && Number.isInteger(gid) ? { uid, gid, shell: fields[6] } : null;
}

function parseGroup(output) {
  const fields = output.trim().split(":");
  const gid = Number(fields[2]);
  return fields.length >= 3 && Number.isInteger(gid) ? { gid } : null;
}

export function parseSelectedEnv(contents) {
  if (typeof contents !== "string") return null;
  const allowed = new Set([
    "NEWDAY_API_HOST", "NEWDAY_API_PORT", "NEWDAY_DATABASE_PATH", "NEWDAY_WEB_ORIGIN",
    "NEWDAY_AGENT_PROVIDER", "NEWDAY_API_ORIGIN", "NEWDAY_WEB_HOST", "NEWDAY_WEB_PORT",
  ]);
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !allowed.has(match[1])) continue;
    if (Object.hasOwn(values, match[1])) return null;
    values[match[1]] = match[2];
  }
  return values;
}

function selectedEnv(path) {
  // Read only after checking metadata. Never retain or report other env keys.
  const info = fileInfo(path);
  if (!info || info.kind !== "file" || info.uid !== 0 || info.gid !== 0 || info.mode !== 0o600) return null;
  return parseSelectedEnv(readText(path, 64 * 1024));
}

function safeJson(path, maxBytes = 256 * 1024) {
  const contents = readText(path, maxBytes);
  if (contents === null) return null;
  try { return JSON.parse(contents); } catch { return null; }
}

function mountInfo(path) {
  const result = inspectCommand(BIN.findmnt, ["-n", "-T", path, "-o", "FSTYPE,SOURCE,OPTIONS"]);
  if (!result.ok) return null;
  const match = /^(\S+)\s+(\S+)\s+(\S+)/.exec(result.output.trim());
  return match ? { type: match[1], source: match[2], options: match[3].split(",") } : null;
}

function freeBytes(path) {
  const result = inspectCommand(BIN.df, ["-Pk", path]);
  if (!result.ok) return null;
  const line = result.output.trim().split("\n").at(-1);
  const fields = line?.trim().split(/\s+/) ?? [];
  const availableKiB = Number(fields[3]);
  return fields.length >= 6 && Number.isSafeInteger(availableKiB) ? availableKiB * 1024 : null;
}

function commandPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      const info = statSync(candidate);
      if (info.isFile() && (info.mode & constants.S_IXUSR)) return realpathSync.native(candidate);
    } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

function installedPnpmVersion(path) {
  if (!path) return null;
  // Running a Corepack shim may download packages or populate a cache. Read
  // an installed package manifest instead and leave shim-only versions unknown.
  let directory = resolve(path, "..");
  for (let depth = 0; depth < 5; depth += 1) {
    const pkg = safeJson(join(directory, "package.json"), 32 * 1024);
    if (pkg?.name === "pnpm" && typeof pkg.version === "string") return pkg.version;
    directory = resolve(directory, "..");
  }
  return null;
}

export function parseSsListeners(output) {
  const sockets = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    const endpoint = fields[3];
    const match = /^(.+):(\d+)$/.exec(endpoint ?? "");
    if (!match) return null;
    const owners = [...line.matchAll(/"([^"\n]+)",pid=(\d+)/g)]
      .map((item) => ({ name: item[1], pid: Number(item[2]) }));
    sockets.push({ address: match[1].replace(/^\[|\]$/g, ""), port: Number(match[2]),
      processes: owners.map((owner) => owner.name), owners });
  }
  return sockets;
}

function socketFacts() {
  const result = inspectCommand(BIN.ss, ["-H", "-ltnp"]);
  return result.ok ? parseSsListeners(result.output) : null;
}

function installedProfileMatches(installed, bundled) {
  const installedText = readText(installed);
  const bundledText = readText(bundled);
  return installedText !== null && bundledText !== null && installedText === bundledText;
}

export function staticNginxSyntax(source) {
  if (typeof source !== "string" || !source.trim()) return false;
  let depth = 0;
  let token = false;
  let quote = null;
  let escaped = false;
  let comment = false;
  for (const char of source) {
    if (comment) {
      if (char === "\n") comment = false;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "#") { comment = true; continue; }
    if (char === "\"" || char === "'") { quote = char; token = true; continue; }
    if (char === "{") {
      if (!token) return false;
      depth += 1;
      token = false;
    } else if (char === ";") {
      if (!token) return false;
      token = false;
    } else if (char === "}") {
      if (token || depth === 0) return false;
      depth -= 1;
    } else if (!/\s/.test(char)) token = true;
  }
  return !quote && !token && depth === 0;
}

export function parseSystemdShow(name, output) {
  if (typeof output !== "string") return { matches: false, mainPid: null };
  const properties = Object.fromEntries(output.trim().split("\n").map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  const mainPid = Number(properties.MainPID);
  return {
    matches: properties.FragmentPath === `/etc/systemd/system/${name}`
      && properties.DropInPaths === "" && properties.NeedDaemonReload === "no",
    mainPid: Number.isSafeInteger(mainPid) && mainPid > 0 ? mainPid : null,
  };
}

function loadedUnit(name) {
  const result = inspectCommand(BIN.systemctl, ["show", "--property=FragmentPath",
    "--property=DropInPaths", "--property=NeedDaemonReload", "--property=MainPID", name]);
  return result.ok ? parseSystemdShow(name, result.output) : { matches: false, mainPid: null };
}

export function routeManifestOk(manifest) {
  if (!manifest || typeof manifest !== "object") return false;
  const rewrites = manifest.rewrites;
  const entries = Array.isArray(rewrites) ? rewrites : ["beforeFiles", "afterFiles", "fallback"]
    .flatMap((key) => Array.isArray(rewrites?.[key]) ? rewrites[key] : []);
  return entries.some((entry) => entry && typeof entry === "object" && entry.source === "/api/:path*"
    && entry.destination === "http://127.0.0.1:3001/api/:path*");
}

export function classifyOffHostDeclaration(info, parsed) {
  if (!info) return { state: "absent" };
  if (info.kind !== "file" || info.uid !== 0 || info.gid !== 0 || info.mode !== 0o600) return { state: "unsafe" };
  if (parsed?.enabled === true && typeof parsed.destination === "string") {
    try {
      const destination = new URL(parsed.destination);
      const host = destination.hostname.toLowerCase();
      const local = host === "localhost" || host === "0.0.0.0" || host === "[::]"
        || host === "[::1]" || /^127\./.test(host) || host === "172.23.1.127";
      if (["s3:", "ssh:", "https:", "b2:", "gs:"].includes(destination.protocol)
        && host && !local && !destination.username && !destination.password) {
        return { state: "declared" };
      }
    } catch { /* Local paths and invalid URLs are not off-host declarations. */ }
  }
  return { state: "invalid" };
}

function offHostDeclaration() {
  const info = fileInfo(OFF_HOST_CONFIG);
  const canRead = info?.kind === "file" && info.uid === 0 && info.gid === 0 && info.mode === 0o600;
  return classifyOffHostDeclaration(info, canRead ? safeJson(OFF_HOST_CONFIG, 32 * 1024) : null);
}

export function collectCarryzFacts() {
  const os = parseOsRelease(readText("/etc/os-release", 16 * 1024));
  const arch = inspectCommand(BIN.uname, ["-m"]);
  const accounts = {};
  for (const name of ["newday-api", "newday-web"]) {
    const result = inspectCommand(BIN.getent, ["passwd", name]);
    accounts[name] = result.ok ? parseAccount(result.output) : null;
  }
  const groupResult = inspectCommand(BIN.getent, ["group", "www-data"]);
  const wwwData = groupResult.ok ? parseGroup(groupResult.output) : null;
  const paths = {};
  for (const path of [
    "/etc/newday", "/etc/newday/api.env", "/etc/newday/web.env", "/var/lib/newday",
    "/var/lib/newday/newday.sqlite", "/var/lib/newday/newday.sqlite-wal",
    "/var/lib/newday/newday.sqlite-shm", "/var/backups/newday", "/opt", "/opt/newday", "/opt/newday/current",
    "/opt/newday/releases", "/usr/bin/node", "/usr/sbin/nginx", "/etc/nginx/newday.htpasswd", "/etc/nginx/newday-tls/carryz.crt",
    "/etc/nginx/newday-tls/carryz.key", NGINX_CONFIG, ...UNIT_PATHS,
  ]) paths[path] = fileInfo(path);
  let releaseTarget = null;
  try { releaseTarget = realpathSync.native("/opt/newday/current"); } catch { /* No release. */ }
  const swcPath = releaseTarget ? resolveLinuxSwc(releaseTarget) : null;
  const releasePaths = releaseTarget && releaseTarget.startsWith(RELEASE_PREFIX) ? {
    release: fileInfo(releaseTarget),
    apiEntry: fileInfo(join(releaseTarget, "apps/api/dist/server.js")),
    nextCli: fileInfo(join(releaseTarget, "apps/web/node_modules/next/dist/bin/next")),
    buildId: readText(join(releaseTarget, "apps/web/.next/BUILD_ID"), 256),
    cache: fileInfo(join(releaseTarget, "apps/web/.next/cache")),
    swc: swcPath ? fileInfo(swcPath) : null,
    routes: routeManifestOk(safeJson(join(releaseTarget, "apps/web/.next/routes-manifest.json"))),
    packageManager: safeJson(join(releaseTarget, "package.json"), 64 * 1024)?.packageManager ?? null,
    treeSafe: releaseTreeSafe(releaseTarget, join(releaseTarget, "apps/web/.next/cache")),
    artifactsReadable: swcPath !== null && readableReleaseFile(releaseTarget, swcPath)
      && ["apps/api/dist/server.js", "apps/web/node_modules/next/dist/bin/next",
      "apps/web/.next/BUILD_ID", "apps/web/.next/routes-manifest.json",
      "deploy/self-host/backup.mjs"].every((path) => readableReleaseFile(releaseTarget, join(releaseTarget, path))),
  } : null;
  const nodeTrusted = rootOwnedExecutable("/usr/bin/node");
  const nodeVersion = nodeTrusted ? inspectCommand("/usr/bin/node", ["--version"]) : { ok: false };
  const pnpmPath = commandPath("pnpm");
  const unitsPresent = UNIT_PATHS.every((path) => paths[path]?.kind === "file");
  const unitsValid = unitsPresent ? inspectCommand(BIN.systemdAnalyze, ["verify", ...UNIT_PATHS], 15_000).ok : false;
  const unitProfiles = UNIT_NAMES.every((name) => installedProfileMatches(
    `/etc/systemd/system/${name}`, resolve(PROFILE_DIR, "../../systemd", name)));
  const loadedUnits = Object.fromEntries(UNIT_NAMES.map((name) => [name, loadedUnit(name)]));
  const effectiveUnits = UNIT_NAMES.every((name) => loadedUnits[name].matches);
  const unitActive = {};
  for (const name of ["newday-api.service", "newday-web.service", "newday-backup.timer", "nginx.service"]) {
    const result = inspectCommand(BIN.systemctl, ["is-active", name]);
    unitActive[name] = result.ok && result.output.trim() === "active";
  }
  const installedNginx = readText(NGINX_CONFIG);
  return {
    os: { ...os, arch: arch.ok ? arch.output.trim() : null, systemd: fileInfo("/run/systemd/system")?.kind === "directory" },
    accounts, wwwData, paths, releaseTarget, releasePaths,
    env: { api: selectedEnv("/etc/newday/api.env"), web: selectedEnv("/etc/newday/web.env") },
    units: { valid: unitsValid, profile: unitProfiles, effective: effectiveUnits, active: unitActive,
      mainPids: { api: loadedUnits["newday-api.service"].mainPid,
        web: loadedUnits["newday-web.service"].mainPid },
      nodeProcesses: { api: nodeTrusted && processUsesNode(loadedUnits["newday-api.service"].mainPid),
        web: nodeTrusted && processUsesNode(loadedUnits["newday-web.service"].mainPid) } },
    nginx: { staticSyntax: staticNginxSyntax(installedNginx),
      profile: installedProfileMatches(NGINX_CONFIG, join(PROFILE_DIR, "newday.nginx.conf")) },
    sockets: socketFacts(),
    runtime: { nodeVersion: nodeVersion.ok ? nodeVersion.output.trim() : null,
      nodeTrusted,
      pnpmFound: pnpmPath !== null, pnpmVersion: installedPnpmVersion(pnpmPath) },
    storage: {
      data: { mount: mountInfo("/var/lib/newday"), freeBytes: freeBytes("/var/lib/newday") },
      backup: { mount: mountInfo("/var/backups/newday"), freeBytes: freeBytes("/var/backups/newday") },
    },
    offHost: offHostDeclaration(),
  };
}

function privatePath(info, kind, uid, gid, mode) {
  return info?.kind === kind && info.uid === uid && info.gid === gid && info.mode === mode;
}

function localWritableMount(mount) {
  return !!mount && ["ext4", "xfs", "btrfs", "zfs"].includes(mount.type)
    && mount.options.includes("rw") && !mount.options.includes("ro");
}

function listener(sockets, port, address, processNames, mainPid = null) {
  if (!Array.isArray(sockets)) return false;
  const matching = sockets.filter((item) => item.port === port);
  return matching.length === 1 && matching[0].address === address
    && (mainPid === null
      ? matching[0].processes.some((name) => processNames.some((expected) => name === expected || name.startsWith(`${expected} (`)))
      : Number.isSafeInteger(mainPid) && mainPid > 0 && matching[0].owners?.some((owner) =>
        owner.pid === mainPid && processNames.some((expected) =>
          owner.name === expected || owner.name.startsWith(`${expected} (`))));
}

function legacyListener(sockets, port, processes) {
  if (!Array.isArray(sockets)) return false;
  return sockets.filter((item) => item.port === port).some((item) =>
    item.processes.some((name) => processes.includes(name)));
}

function onlyCarryzNginxListener(sockets) {
  if (!Array.isArray(sockets)) return false;
  const nginxSockets = sockets.filter((item) => item.processes.some((name) => name === "nginx" || name.startsWith("nginx (")));
  return nginxSockets.length === 1 && nginxSockets[0].port === 8443
    && nginxSockets[0].address === "172.23.1.127";
}

export function evaluateCarryzPreflight(facts, assessedAt = new Date().toISOString()) {
  const checks = [];
  const add = (id, condition, pass, fail, severity = "blocker") => {
    checks.push({ id, status: condition ? "pass" : severity, summary: condition ? pass : fail });
  };
  add("os_systemd", facts.os?.id === "debian" && facts.os?.version === "12"
    && facts.os?.arch === "x86_64" && facts.os?.systemd === true,
  "Debian 12 x86_64 with systemd is present.", "Debian 12 x86_64 or systemd prerequisite is missing or unverified.");

  const api = facts.accounts?.["newday-api"];
  const web = facts.accounts?.["newday-web"];
  const nologin = (account) => account && account.uid > 0 && account.gid > 0
    && /\/(?:nologin|false)$/.test(account.shell);
  add("service_accounts", nologin(api) && nologin(web) && api.uid !== web.uid,
    "Separate non-login service accounts are present.", "Service accounts are missing, shared, or have login shells.");

  const paths = facts.paths ?? {};
  add("private_directories", !!api && privatePath(paths["/etc/newday"], "directory", 0, 0, 0o700)
    && privatePath(paths["/var/lib/newday"], "directory", api.uid, api.gid, 0o700)
    && privatePath(paths["/var/backups/newday"], "directory", api.uid, api.gid, 0o700),
  "Configuration, data, and backup directories have private ownership and modes.",
  "Configuration, data, or backup directory ownership/mode is unsafe or unverified.");
  add("env_files", privatePath(paths["/etc/newday/api.env"], "file", 0, 0, 0o600)
    && privatePath(paths["/etc/newday/web.env"], "file", 0, 0, 0o600),
  "Both env files exist with root:root 0600 permissions.",
  "An env file is absent or lacks root:root 0600 permissions.");
  const apiEnv = facts.env?.api;
  const webEnv = facts.env?.web;
  add("env_bindings", apiEnv?.NEWDAY_API_HOST === "127.0.0.1"
    && apiEnv?.NEWDAY_API_PORT === "3001"
    && apiEnv?.NEWDAY_DATABASE_PATH === "/var/lib/newday/newday.sqlite"
    && apiEnv?.NEWDAY_WEB_ORIGIN === "https://172.23.1.127:8443"
    && apiEnv?.NEWDAY_AGENT_PROVIDER === "disabled"
    && webEnv?.NEWDAY_WEB_HOST === "127.0.0.1"
    && webEnv?.NEWDAY_WEB_PORT === "3100"
    && webEnv?.NEWDAY_API_ORIGIN === "http://127.0.0.1:3001",
  "Selected non-secret env settings match the CarryZ profile.",
  "A required env setting is missing or differs from the CarryZ profile.");

  add("api_binding", facts.units?.nodeProcesses?.api === true
    && listener(facts.sockets, 3001, "127.0.0.1", ["node", "MainThread"], facts.units?.mainPids?.api ?? -1),
    "API has one node listener at 127.0.0.1:3001.",
    "API port 3001 is absent, non-loopback, duplicated, or owned by another process.");
  add("web_binding", facts.units?.nodeProcesses?.web === true
    && listener(facts.sockets, 3100, "127.0.0.1", ["node", "MainThread", "next-server"], facts.units?.mainPids?.web ?? -1),
    "Web has one node listener at 127.0.0.1:3100.",
    "Web port 3100 is absent, non-loopback, duplicated, or owned by another process.");
  add("nginx_binding", listener(facts.sockets, 8443, "172.23.1.127", ["nginx"]),
    "nginx has one listener at 172.23.1.127:8443.",
    "nginx port 8443 is absent, wildcard-bound, duplicated, or owned by another process.");
  add("nginx_only_binding", onlyCarryzNginxListener(facts.sockets),
    "nginx has no listener outside the CarryZ 8443 entry point.",
    "nginx also listens on another address or port, which may conflict with existing services.");
  add("existing_listeners", legacyListener(facts.sockets, 80, ["apache2", "httpd"])
    && legacyListener(facts.sockets, 3000, ["docker-proxy", "dockerd"]),
    "Existing Apache :80 and Docker :3000 listeners remain visible.",
    "Existing Apache :80 or Docker :3000 listener is not confirmed; review the host inventory.", "warning");

  add("systemd_units", facts.units?.valid === true && facts.units?.profile === true
    && facts.units?.effective === true
    && UNIT_PATHS.every((path) => paths[path]?.kind === "file"
      && paths[path].uid === 0 && !(paths[path].mode & 0o022)),
    "Installed NewDay units match the profile and pass systemd-analyze verify.",
    "Installed NewDay units are absent, differ from the profile, or fail systemd-analyze verify.");
  const active = facts.units?.active ?? {};
  add("services_active", active["newday-api.service"] === true && active["newday-web.service"] === true
    && active["newday-backup.timer"] === true && active["nginx.service"] === true,
  "API, Web, backup timer, and nginx are active.", "A required service or backup timer is inactive or unverified.");
  add("nginx_syntax_profile", facts.nginx?.staticSyntax === true && facts.nginx?.profile === true
    && paths[NGINX_CONFIG]?.kind === "file" && paths[NGINX_CONFIG].uid === 0
    && !(paths[NGINX_CONFIG].mode & 0o022) && paths["/usr/sbin/nginx"]?.kind === "file"
    && paths["/usr/sbin/nginx"].uid === 0 && !!(paths["/usr/sbin/nginx"].mode & 0o100)
    && !(paths["/usr/sbin/nginx"].mode & 0o022),
  "Installed nginx file passes static syntax and byte-for-byte CarryZ profile checks.",
  "Installed nginx file is absent, differs from the profile, or fails static syntax validation.");
  add("nginx_native_syntax", false,
    "Native nginx syntax was verified.",
    "Native nginx -t was not run because it can create host files; it remains a separate acceptance check.", "warning");
  add("nginx_private_material", !!facts.wwwData
    && privatePath(paths["/etc/nginx/newday.htpasswd"], "file", 0, facts.wwwData.gid, 0o640)
    && paths["/etc/nginx/newday-tls/carryz.crt"]?.kind === "file"
    && !!(paths["/etc/nginx/newday-tls/carryz.crt"].mode & 0o400)
    && !(paths["/etc/nginx/newday-tls/carryz.crt"].mode & 0o022)
    && paths["/etc/nginx/newday-tls/carryz.key"]?.kind === "file"
    && paths["/etc/nginx/newday-tls/carryz.key"].uid === 0
    && !!(paths["/etc/nginx/newday-tls/carryz.key"].mode & 0o400)
    && !(paths["/etc/nginx/newday-tls/carryz.key"].mode & 0o077),
  "Basic Auth file and TLS material are present with private key permissions.",
  "Basic Auth file or TLS material is missing or has unsafe permissions.");

  const nodeMajor = Number(/^v?(\d+)\./.exec(facts.runtime?.nodeVersion ?? "")?.[1]);
  add("node_runtime", Number.isInteger(nodeMajor) && nodeMajor >= 24
    && facts.runtime?.nodeTrusted === true,
  "Node 24+ is available at /usr/bin/node.", "Node 24+ at /usr/bin/node is missing or unverified.");
  add("pnpm_build_tool", facts.runtime?.pnpmFound === true
    && (facts.runtime?.pnpmVersion === null || facts.runtime?.pnpmVersion === "10.29.1"),
  "pnpm is installed; the pinned version is checked when discoverable without running a shim.",
  "pnpm is absent or a discoverable installed version differs from 10.29.1.", "warning");
  add("pnpm_version", facts.runtime?.pnpmVersion === "10.29.1",
    "Installed pnpm version is 10.29.1.",
    "pnpm version could not be proven without running a possible Corepack shim, or differs.", "warning");

  const release = facts.releasePaths;
  add("release_artifacts", paths["/opt/newday/current"]?.kind === "symlink"
    && paths["/opt/newday/current"].uid === 0
    && paths["/opt"]?.kind === "directory"
    && paths["/opt"].uid === 0 && !!(paths["/opt"].mode & 0o001)
    && !(paths["/opt"].mode & 0o022)
    && paths["/opt/newday"]?.kind === "directory"
    && paths["/opt/newday"].uid === 0
    && !!(paths["/opt/newday"].mode & 0o001)
    && !(paths["/opt/newday"].mode & 0o022)
    && paths["/opt/newday/releases"]?.kind === "directory"
    && paths["/opt/newday/releases"].uid === 0
    && !!(paths["/opt/newday/releases"].mode & 0o001)
    && !(paths["/opt/newday/releases"].mode & 0o022)
    && facts.releaseTarget?.startsWith(RELEASE_PREFIX)
    && release?.release?.kind === "directory" && release?.release?.uid === 0
    && !(release?.release?.mode & 0o022)
    && release?.apiEntry?.kind === "file" && release?.nextCli?.kind === "file"
    && typeof release?.buildId === "string" && release.buildId.trim().length > 0
    && release?.swc?.kind === "file" && release?.packageManager === "pnpm@10.29.1"
    && release?.routes === true,
  "Root-owned target release has API, Linux Web, pinned package, and built API rewrite artifacts.",
  "Target release, architecture-specific artifact, or build-time API rewrite is missing or unverified.");
  add("release_permissions", release?.treeSafe === true && release?.artifactsReadable === true,
    "Release tree is root-owned and read-only, and service entry points are readable.",
    "Release tree has unsafe ownership/modes or a service entry point is not readable.");
  add("next_cache", !!web && release?.cache?.kind === "directory"
    && release.cache.uid === web.uid && release.cache.gid === web.gid
    && (release.cache.mode & 0o700) === 0o700 && !(release.cache.mode & 0o022),
  "Next cache is privately writable by the Web account.",
  "Next cache owner or mode is unsafe or unwritable.");

  const db = paths["/var/lib/newday/newday.sqlite"];
  const wal = paths["/var/lib/newday/newday.sqlite-wal"];
  const shm = paths["/var/lib/newday/newday.sqlite-shm"];
  const safeAuxiliary = (info) => !info || (!!api && info.kind === "file" && info.uid === api.uid
    && info.gid === api.gid && (info.mode & 0o600) === 0o600 && !(info.mode & 0o077));
  add("sqlite_file", !!api && db?.kind === "file" && db.uid === api.uid
    && db.gid === api.gid && (db.mode & 0o600) === 0o600 && !(db.mode & 0o077)
    && safeAuxiliary(wal) && safeAuxiliary(shm),
  "SQLite database is a private regular file owned by the API account.",
  "SQLite database is absent, is not regular, or has unsafe ownership/mode.");
  const dataStorage = facts.storage?.data;
  const backupStorage = facts.storage?.backup;
  add("sqlite_filesystem", localWritableMount(dataStorage?.mount),
    "SQLite directory is on a known local writable filesystem.",
    "SQLite filesystem is network, ephemeral, read-only, unsupported, or unverified.");
  add("backup_destination", localWritableMount(backupStorage?.mount)
    && paths["/var/backups/newday"]?.kind === "directory"
    && dataStorage?.mount?.source !== undefined && backupStorage?.mount?.source !== undefined,
  "Backup directory is private and on a known local writable filesystem.",
  "Backup destination is missing, unsafe, read-only, unsupported, or unverified.");
  add("backup_separation", !!dataStorage?.mount && !!backupStorage?.mount
    && dataStorage.mount.source !== backupStorage.mount.source,
  "Backup destination is on a different mount source from SQLite.",
  "Local backup shares a mount source with SQLite; a disk failure can remove both.", "warning");
  const dbSize = [db, wal, shm].reduce((sum, info) => sum + (Number.isSafeInteger(info?.size) ? info.size : 0), 0);
  const sameMount = dataStorage?.mount?.source && dataStorage.mount.source === backupStorage?.mount?.source;
  add("free_space", Number.isSafeInteger(dataStorage?.freeBytes)
    && Number.isSafeInteger(backupStorage?.freeBytes)
    && dataStorage.freeBytes >= Math.max(512 * MIB, 2 * dbSize)
    && backupStorage.freeBytes >= Math.max(512 * MIB, 3 * dbSize)
    && (!sameMount || dataStorage.freeBytes >= Math.max(512 * MIB, 5 * dbSize)),
  "Data and backup mounts meet the conservative free-space floor.",
  "Data or backup mount lacks verified free space for snapshot/restore staging.");

  const offHostState = facts.offHost?.state ?? "unknown";
  add("off_host_backup", offHostState === "declared",
    "An operator-managed off-host destination is declared; copy and restore remain unverified.",
    offHostState === "unsafe" ? "Off-host declaration has unsafe ownership or mode."
      : "No valid off-host backup destination declaration is configured.", "warning");
  const blockers = checks.filter((check) => check.status === "blocker").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  return {
    schemaVersion: 1, target: "carryz", scope: "local-host-configuration", assessedAt,
    verdict: blockers === 0 ? "go" : "no-go",
    summary: { blockers, warnings, passed: checks.length - blockers - warnings },
    offHostBackup: { configured: offHostState === "declared", independentlyVerified: false },
    checks,
  };
}

export function formatHumanReport(report) {
  const lines = [
    `CarryZ NewDay local-host preflight: ${report.verdict.toUpperCase()} (${report.summary.blockers} blockers, ${report.summary.warnings} warnings)`,
  ];
  for (const status of ["blocker", "warning"]) {
    const items = report.checks.filter((check) => check.status === status);
    if (!items.length) continue;
    lines.push(`${status === "blocker" ? "Blockers" : "Warnings"}:`);
    for (const item of items) lines.push(`- ${item.id}: ${item.summary}`);
  }
  if (!report.summary.blockers) lines.push("Host checks pass; this does not prove backup transfer, restore, or user acceptance.");
  return lines.join("\n");
}

function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  if (process.argv.length !== 2) {
    console.error("Usage: /usr/bin/node deploy/self-host/targets/carryz/preflight.mjs");
    process.exitCode = 2;
  } else {
    const report = evaluateCarryzPreflight(collectCarryzFacts());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`${formatHumanReport(report)}\n`);
    process.exitCode = report.verdict === "go" ? 0 : 1;
  }
}
