import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  EXPECTED_BINDINGS,
  classifyOffHostDeclaration,
  evaluateCarryzPreflight,
  formatHumanReport,
  parseSelectedEnv,
  parseSsListeners,
  parseSystemdShow,
  routeManifestOk,
  resolveLinuxSwc,
  staticNginxSyntax,
} from "../../../deploy/self-host/targets/carryz/preflight.mjs";

const ASSESSED_AT = "2026-09-27T00:00:00.000Z";
const MIB = 1024 * 1024;
const API_UID = 1001;
const WEB_UID = 1002;
const WWW_DATA_GID = 33;

it("runs the CLI through release and file symlinks instead of silently importing it", () => {
  const source = realpathSync.native(join(process.cwd(), "deploy/self-host/targets/carryz/preflight.mjs"));
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "newday-preflight-cli-")));
  const fileLink = join(root, "preflight.mjs");
  const directoryLink = join(root, "current");
  try {
    symlinkSync(source, fileLink);
    symlinkSync(dirname(source), directoryLink);
    for (const entry of [source, fileLink, join(directoryLink, "preflight.mjs")]) {
      const result = spawnSync(process.execPath, [entry, "--unexpected"], { encoding: "utf8", timeout: 5_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage: /usr/bin/node deploy/self-host/targets/carryz/preflight.mjs");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function file(uid: number, gid: number, mode: number, size = 0) {
  return { kind: "file", uid, gid, mode, size };
}

function directory(uid: number, gid: number, mode: number) {
  return { kind: "directory", uid, gid, mode, size: 0 };
}

function healthyFacts() {
  const release = "/opt/newday/releases/ee97877";
  const unitPaths = [
    "/etc/systemd/system/newday-api.service",
    "/etc/systemd/system/newday-web.service",
    "/etc/systemd/system/newday-backup.service",
    "/etc/systemd/system/newday-backup.timer",
  ];
  const paths: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>> = {
    "/etc/newday": directory(0, 0, 0o700),
    "/etc/newday/api.env": file(0, 0, 0o600),
    "/etc/newday/web.env": file(0, 0, 0o600),
    "/var/lib/newday": directory(API_UID, API_UID, 0o700),
    "/var/lib/newday/newday.sqlite": file(API_UID, API_UID, 0o600, 64 * MIB),
    "/var/backups/newday": directory(API_UID, API_UID, 0o700),
    "/etc/nginx/conf.d/newday.conf": file(0, 0, 0o644),
    "/etc/nginx/newday.htpasswd": file(0, WWW_DATA_GID, 0o640),
    "/etc/nginx/newday-tls/carryz.crt": file(0, 0, 0o644),
    "/etc/nginx/newday-tls/carryz.key": file(0, 0, 0o600),
    "/usr/bin/node": file(0, 0, 0o755),
    "/usr/sbin/nginx": file(0, 0, 0o755),
    "/opt": directory(0, 0, 0o755),
    "/opt/newday": directory(0, 0, 0o755),
    "/opt/newday/current": { kind: "symlink", uid: 0, gid: 0, mode: 0o777, size: 0 },
    "/opt/newday/releases": directory(0, 0, 0o755),
  };
  for (const path of unitPaths) paths[path] = file(0, 0, 0o644);

  return {
    os: { id: "debian", version: "12", arch: "x86_64", systemd: true },
    accounts: {
      "newday-api": { uid: API_UID, gid: API_UID, shell: "/usr/sbin/nologin" },
      "newday-web": { uid: WEB_UID, gid: WEB_UID, shell: "/usr/sbin/nologin" },
    },
    wwwData: { gid: WWW_DATA_GID },
    paths,
    env: {
      api: {
        NEWDAY_API_HOST: "127.0.0.1",
        NEWDAY_API_PORT: "3001",
        NEWDAY_DATABASE_PATH: "/var/lib/newday/newday.sqlite",
        NEWDAY_WEB_ORIGIN: "https://172.23.1.127:8443",
        NEWDAY_AGENT_PROVIDER: "disabled",
      },
      web: {
        NEWDAY_API_ORIGIN: "http://127.0.0.1:3001",
        NEWDAY_WEB_HOST: "127.0.0.1",
        NEWDAY_WEB_PORT: "3100",
      },
    },
    sockets: [
      { address: "0.0.0.0", port: 80, processes: ["apache2"], owners: [{ name: "apache2", pid: 20 }] },
      { address: "172.23.1.127", port: 3000, processes: ["docker-proxy"], owners: [{ name: "docker-proxy", pid: 21 }] },
      { address: "127.0.0.1", port: 3001, processes: ["node"], owners: [{ name: "node", pid: 101 }] },
      { address: "127.0.0.1", port: 3100, processes: ["node"], owners: [{ name: "node", pid: 102 }] },
      { address: "172.23.1.127", port: 8443, processes: ["nginx"], owners: [{ name: "nginx", pid: 24 }] },
    ],
    units: {
      valid: true,
      profile: true,
      effective: true,
      mainPids: { api: 101 as number | null, web: 102 as number | null },
      nodeProcesses: { api: true, web: true },
      active: {
        "newday-api.service": true,
        "newday-web.service": true,
        "newday-backup.timer": true,
        "nginx.service": true,
      },
    },
    nginx: { staticSyntax: true, profile: true },
    runtime: { nodeVersion: "v24.8.0", nodeTrusted: true, pnpmFound: true, pnpmVersion: "10.29.1" as string | null },
    releaseTarget: release,
    releasePaths: {
      release: directory(0, 0, 0o755),
      apiEntry: file(0, 0, 0o644),
      nextCli: file(0, 0, 0o644),
      buildId: "build-id",
      swc: file(0, 0, 0o644),
      packageManager: "pnpm@10.29.1",
      routes: true,
      cache: directory(WEB_UID, WEB_UID, 0o700),
      treeSafe: true,
      artifactsReadable: true,
    },
    storage: {
      data: {
        mount: { type: "ext4", source: "/dev/sda1", options: ["rw", "relatime"] },
        freeBytes: 2 * 1024 * MIB,
      },
      backup: {
        mount: { type: "ext4", source: "/dev/sdb1", options: ["rw", "relatime"] },
        freeBytes: 2 * 1024 * MIB,
      },
    },
    offHost: { state: "declared" },
  };
}

function check(report: ReturnType<typeof evaluateCarryzPreflight>, id: string) {
  const result = report.checks.find((item: { id: string }) => item.id === id);
  expect(result, `missing check ${id}`).toBeDefined();
  return result;
}

describe("CarryZ target-host preflight", () => {
  it("resolves SWC in a pnpm layout and refuses a dependency outside the release", () => {
    const temp = mkdtempSync(join(tmpdir(), "newday-swc-"));
    try {
      for (const escaped of [false, true]) {
        const root = join(temp, escaped ? "escaped" : "valid");
        const next = join(root, "node_modules/.pnpm/next/node_modules/next");
        const swc = join(escaped ? temp : root, "node_modules/.pnpm/swc/node_modules/@next/swc-linux-x64-gnu");
        mkdirSync(next, { recursive: true }); mkdirSync(swc, { recursive: true });
        mkdirSync(join(root, "apps/web/node_modules"), { recursive: true });
        mkdirSync(join(root, "node_modules/.pnpm/next/node_modules/@next"), { recursive: true });
        writeFileSync(join(next, "package.json"), '{"name":"next"}');
        const binary = join(swc, "next-swc.linux-x64-gnu.node");
        writeFileSync(binary, "fixture");
        symlinkSync(next, join(root, "apps/web/node_modules/next"));
        symlinkSync(swc, join(root, "node_modules/.pnpm/next/node_modules/@next/swc-linux-x64-gnu"));
        expect(resolveLinuxSwc(root)).toBe(escaped ? null : realpathSync(binary));
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it("recognizes MainThread only at the systemd PID with a verified Node executable", () => {
    const facts = healthyFacts();
    const api = facts.sockets.find((item) => item.port === 3001)!;
    api.processes = ["MainThread"]; api.owners = [{ name: "MainThread", pid: 101 }];
    expect(check(evaluateCarryzPreflight(facts, ASSESSED_AT), "api_binding")?.status).toBe("pass");
    api.owners[0].pid = 999;
    expect(check(evaluateCarryzPreflight(facts, ASSESSED_AT), "api_binding")?.status).toBe("blocker");
    api.owners[0].pid = 101; facts.units.nodeProcesses.api = false;
    expect(check(evaluateCarryzPreflight(facts, ASSESSED_AT), "api_binding")?.status).toBe("blocker");
  });

  it("blocks an untrusted runtime despite its valid Node version", () => {
    const facts = healthyFacts(); facts.runtime.nodeTrusted = false;
    expect(check(evaluateCarryzPreflight(facts, ASSESSED_AT), "node_runtime")?.status).toBe("blocker");
  });
  it("reduces mocked env content to selected settings and rejects duplicate binding keys", () => {
    const secret = "SENTINEL_ENV_SECRET_42";
    const selected = parseSelectedEnv([
      "NEWDAY_API_HOST=127.0.0.1",
      "NEWDAY_API_PORT=3001",
      `PROVIDER_API_KEY=${secret}`,
      "# NEWDAY_WEB_PORT=9999",
    ].join("\n"));
    expect(selected).toEqual({ NEWDAY_API_HOST: "127.0.0.1", NEWDAY_API_PORT: "3001" });
    expect(JSON.stringify(selected)).not.toContain(secret);
    expect(parseSelectedEnv("NEWDAY_API_HOST=127.0.0.1\nNEWDAY_API_HOST=0.0.0.0")).toBeNull();
  });

  it("reads mocked systemctl show output and rejects stale or overridden units", () => {
    const name = "newday-api.service";
    const output = [
      `FragmentPath=/etc/systemd/system/${name}`,
      "DropInPaths=",
      "NeedDaemonReload=no",
      "MainPID=101",
    ].join("\n");
    expect(parseSystemdShow(name, output)).toEqual({ matches: true, mainPid: 101 });
    expect(parseSystemdShow(name, output.replace("NeedDaemonReload=no", "NeedDaemonReload=yes")))
      .toEqual({ matches: false, mainPid: 101 });
    expect(parseSystemdShow(name, output.replace("DropInPaths=", "DropInPaths=/etc/systemd/system/newday-api.service.d/override.conf")))
      .toEqual({ matches: false, mainPid: 101 });
    expect(parseSystemdShow(name, output.replace("MainPID=101", "MainPID=0")))
      .toEqual({ matches: true, mainPid: null });
  });

  it("rejects malformed Next route manifests without throwing", () => {
    const rewrite = { source: "/api/:path*", destination: "http://127.0.0.1:3001/api/:path*" };
    expect(routeManifestOk({ rewrites: { afterFiles: [rewrite] } })).toBe(true);
    for (const malformed of [null, {}, { rewrites: "bad" }, { rewrites: { afterFiles: {} } },
      { rewrites: [null, false, "bad"] }, { rewrites: { beforeFiles: [null, {}] } }]) {
      expect(routeManifestOk(malformed)).toBe(false);
    }
  });

  it("accepts only a private external off-host declaration and never reports its URL", () => {
    const info = file(0, 0, 0o600);
    const secret = "SENTINEL_BACKUP_DESTINATION_42";
    const destination = `ssh://backup.example.com/${secret}`;
    expect(classifyOffHostDeclaration(info, { enabled: true, destination })).toEqual({ state: "declared" });
    for (const invalid of [
      "ssh://127.0.0.2/archive",
      "ssh://[::1]/archive",
      "ssh://user:password@backup.example.com/archive",
      "/mnt/off-host/archive",
    ]) {
      expect(classifyOffHostDeclaration(info, { enabled: true, destination: invalid })).toEqual({ state: "invalid" });
    }
    expect(classifyOffHostDeclaration(file(0, 0, 0o644), { enabled: true, destination })).toEqual({ state: "unsafe" });
    const report = evaluateCarryzPreflight({ ...healthyFacts(), offHost: classifyOffHostDeclaration(info, { enabled: true, destination }) }, ASSESSED_AT);
    expect(report.offHostBackup).toEqual({ configured: true, independentlyVerified: false });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(formatHumanReport(report)).not.toContain(secret);
  });

  it("parses representative ss listeners without retaining raw command text", () => {
    const sentinel = "SENTINEL_PRIVATE_SOCKET_DETAIL";
    const output = [
      'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("apache2",pid=20,fd=4))',
      'LISTEN 0 4096 172.23.1.127:3000 0.0.0.0:* users:(("docker-proxy",pid=21,fd=5))',
      'LISTEN 0 511 127.0.0.1:3001 0.0.0.0:* users:(("node",pid=101,fd=6))',
      'LISTEN 0 511 127.0.0.1:3100 0.0.0.0:* users:(("node",pid=102,fd=7))',
      `LISTEN 0 511 172.23.1.127:8443 0.0.0.0:* users:(("nginx",pid=24,fd=8)) ${sentinel}`,
    ].join("\n");
    const sockets = parseSsListeners(output);
    expect(sockets).toEqual(healthyFacts().sockets);
    const facts = healthyFacts();
    facts.sockets = sockets!;
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    expect(report.verdict).toBe("go");
    expect(JSON.stringify(report)).not.toContain(sentinel);
    expect(formatHumanReport(report)).not.toContain(sentinel);
    expect(parseSsListeners("LISTEN malformed listener line")).toBeNull();
  });

  it("accepts the exact live profile while retaining Apache and Docker listeners", () => {
    expect(EXPECTED_BINDINGS).toEqual({
      api: "127.0.0.1:3001",
      web: "127.0.0.1:3100",
      nginx: "172.23.1.127:8443",
    });
    const report = evaluateCarryzPreflight(healthyFacts(), ASSESSED_AT);
    expect(report).toMatchObject({
      schemaVersion: 1,
      target: "carryz",
      assessedAt: ASSESSED_AT,
      verdict: "go",
      summary: { blockers: 0, warnings: 1 },
      offHostBackup: { configured: true, independentlyVerified: false },
    });
    expect(check(report, "existing_listeners")?.status).toBe("pass");
    expect(check(report, "nginx_native_syntax")?.status).toBe("warning");
    expect(formatHumanReport(report)).toContain("GO (0 blockers, 1 warnings)");
    expect(formatHumanReport(report)).toContain("does not prove backup transfer, restore, or user acceptance");
  });

  it.each([
    ["api_binding", 3001, "0.0.0.0"],
    ["web_binding", 3100, "::"],
    ["nginx_binding", 8443, "0.0.0.0"],
  ])("blocks %s when port %i binds to %s", (id, port, address) => {
    const facts = healthyFacts();
    const socket = facts.sockets.find((item) => item.port === port);
    expect(socket).toBeDefined();
    socket!.address = address;
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    expect(report.verdict).toBe("no-go");
    expect(check(report, id)?.status).toBe("blocker");
    expect(formatHumanReport(report)).toContain("Blockers:");
  });

  it("blocks duplicate or unexpected ownership on a NewDay port", () => {
    const facts = healthyFacts();
    facts.sockets.push({ address: "172.23.1.127", port: 3001, processes: ["docker-proxy"], owners: [{ name: "docker-proxy", pid: 29 }] });
    const webSocket = facts.sockets.find((item) => item.port === 3100)!;
    webSocket.processes = ["apache2"];
    webSocket.owners = [{ name: "apache2", pid: 102 }];
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    expect(check(report, "api_binding")?.status).toBe("blocker");
    expect(check(report, "web_binding")?.status).toBe("blocker");
    expect(check(report, "existing_listeners")?.status).toBe("pass");
  });

  it("blocks an unrelated Node process and an unavailable systemd MainPID", () => {
    const facts = healthyFacts();
    facts.sockets.find((item) => item.port === 3001)!.owners = [{ name: "node", pid: 999 }];
    facts.units.mainPids.web = null;
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    expect(check(report, "api_binding")?.status).toBe("blocker");
    expect(check(report, "web_binding")?.status).toBe("blocker");
  });

  it("blocks an additional nginx listener outside the CarryZ endpoint", () => {
    const facts = healthyFacts();
    facts.sockets.push({ address: "0.0.0.0", port: 443, processes: ["nginx"], owners: [{ name: "nginx", pid: 24 }] });
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    expect(report.verdict).toBe("no-go");
    expect(check(report, "nginx_only_binding")?.status).toBe("blocker");
  });

  it("recognizes the Web process name reported by Next and warns on unverifiable pnpm", () => {
    const facts = healthyFacts();
    facts.sockets.find((item) => item.port === 3100)!.processes = ["next-server"];
    facts.runtime.pnpmVersion = null;
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    expect(report.verdict).toBe("go");
    expect(check(report, "web_binding")?.status).toBe("pass");
    expect(check(report, "pnpm_build_tool")?.status).toBe("pass");
    expect(check(report, "pnpm_version")?.status).toBe("warning");
  });

  it("blocks unsafe env permissions and differing bindings without disclosing values", () => {
    const facts = healthyFacts();
    const secret = "SENTINEL_PROVIDER_PASSWORD_42";
    facts.paths["/etc/newday/api.env"] = file(0, 0, 0o644);
    facts.env.api.NEWDAY_WEB_ORIGIN = secret;
    Object.assign(facts.env.api, { PROVIDER_KEY: secret });
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    expect(check(report, "env_files")?.status).toBe("blocker");
    expect(check(report, "env_bindings")?.status).toBe("blocker");
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(formatHumanReport(report)).not.toContain(secret);
    expect(Object.keys(report)).toEqual([
      "schemaVersion", "target", "scope", "assessedAt", "verdict", "summary", "offHostBackup", "checks",
    ]);
  });

  it("blocks invalid units, nginx syntax, unsafe ownership, and missing private material", () => {
    const facts = healthyFacts();
    facts.units.valid = false;
    facts.units.effective = false;
    facts.nginx.staticSyntax = false;
    facts.paths["/var/lib/newday"] = directory(WEB_UID, WEB_UID, 0o755);
    facts.paths["/etc/nginx/newday-tls/carryz.key"] = file(0, 0, 0o644);
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    for (const id of ["systemd_units", "nginx_syntax_profile", "private_directories", "nginx_private_material"]) {
      expect(check(report, id)?.status, id).toBe("blocker");
    }
  });

  it("rejects malformed static nginx syntax without claiming a native nginx -t pass", () => {
    expect(staticNginxSyntax("server { listen 172.23.1.127:8443 ssl; }")).toBe(true);
    for (const malformed of [
      "server { listen 172.23.1.127:8443 ssl;",
      'server { auth_basic "NewDay; }',
      "server { listen 172.23.1.127:8443 ssl }",
      "server { listen 172.23.1.127:8443 ssl; }}",
    ]) {
      expect(staticNginxSyntax(malformed), malformed).toBe(false);
    }
    const report = evaluateCarryzPreflight(healthyFacts(), ASSESSED_AT);
    expect(check(report, "nginx_native_syntax")?.status).toBe("warning");
  });

  it("blocks an effective systemd unit override even when the installed files validate", () => {
    const facts = healthyFacts();
    facts.units.effective = false;
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    expect(check(report, "systemd_units")?.status).toBe("blocker");
  });

  it("blocks mismatched OS, login-capable accounts, active-service gaps, and public SQLite modes", () => {
    const facts = healthyFacts();
    facts.os.version = "11";
    facts.accounts["newday-api"].shell = "/bin/bash";
    facts.units.active["newday-backup.timer"] = false;
    facts.paths["/var/lib/newday/newday.sqlite"] = file(API_UID, API_UID, 0o644, 64 * MIB);
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    for (const id of ["os_systemd", "service_accounts", "services_active", "sqlite_file"]) {
      expect(check(report, id)?.status, id).toBe("blocker");
    }
  });

  it("blocks absent runtime or mismatched build artifacts and a writable release", () => {
    const facts = healthyFacts();
    facts.runtime.nodeVersion = "v22.16.0";
    facts.releasePaths.routes = false;
    facts.releasePaths.release = directory(0, 0, 0o777);
    facts.releasePaths.cache = directory(API_UID, API_UID, 0o700);
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    for (const id of ["node_runtime", "release_artifacts", "next_cache"]) {
      expect(check(report, id)?.status, id).toBe("blocker");
    }
  });

  it("blocks unsafe release tree permissions or unreadable service artifacts", () => {
    const facts = healthyFacts();
    facts.releasePaths.treeSafe = false;
    facts.releasePaths.artifactsReadable = false;
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    expect(check(report, "release_permissions")?.status).toBe("blocker");
  });

  it("blocks a release hidden behind a non-traversable /opt directory", () => {
    const facts = healthyFacts();
    facts.paths["/opt"] = directory(0, 0, 0o000);
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    expect(check(report, "release_artifacts")?.status).toBe("blocker");
  });

  it("blocks network or read-only storage and insufficient staging space", () => {
    const facts = healthyFacts();
    facts.storage.data.mount.type = "nfs";
    facts.storage.backup.mount.options = ["ro"];
    facts.storage.backup.freeBytes = 12 * MIB;
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    for (const id of ["sqlite_filesystem", "backup_destination", "free_space"]) {
      expect(check(report, id)?.status, id).toBe("blocker");
    }
  });

  it("accounts for SQLite WAL space and blocks unsafe auxiliary file modes", () => {
    const facts = healthyFacts();
    facts.paths["/var/lib/newday/newday.sqlite-wal"] = file(API_UID, API_UID, 0o644, 256 * MIB);
    facts.storage.backup.freeBytes = 800 * MIB;
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    expect(check(report, "sqlite_file")?.status).toBe("blocker");
    expect(check(report, "free_space")?.status).toBe("blocker");
  });

  it("reports a same-source backup and unconfigured off-host copy as warnings", () => {
    const facts = healthyFacts();
    facts.storage.backup.mount.source = facts.storage.data.mount.source;
    facts.offHost.state = "absent";
    const report = evaluateCarryzPreflight(facts, ASSESSED_AT);
    expect(report.verdict).toBe("go");
    expect(report.summary).toMatchObject({ blockers: 0, warnings: 3 });
    expect(check(report, "backup_separation")?.status).toBe("warning");
    expect(check(report, "off_host_backup")?.status).toBe("warning");
    expect(report.offHostBackup).toEqual({ configured: false, independentlyVerified: false });
    expect(formatHumanReport(report)).toContain("Warnings:");
  });

  it("fails closed when facts cannot be collected", () => {
    const report = evaluateCarryzPreflight({}, ASSESSED_AT);
    expect(report.verdict).toBe("no-go");
    expect(report.summary.blockers).toBeGreaterThan(0);
    for (const id of ["os_systemd", "api_binding", "systemd_units", "nginx_syntax_profile", "sqlite_filesystem", "free_space"]) {
      expect(check(report, id)?.status, id).toBe("blocker");
    }
  });
});
