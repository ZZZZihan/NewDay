# CarryZ Debian 12 deployment profile

This profile records the non-secret configuration used for the first LAN deployment at `172.23.1.127`. It is intentionally separate from the public-DNS example.

## Port and service boundary

| Listener | Binding | Reason |
| --- | --- | --- |
| Apache | existing TCP 80 | untouched |
| Existing Docker service | existing `172.23.1.127:3000` | untouched |
| NewDay API | `127.0.0.1:3001` | loopback only |
| NewDay Web | `127.0.0.1:3100` | loopback only |
| NewDay nginx | `172.23.1.127:8443` | LAN TLS and Basic Auth entry point |

Install `api.env` and `web.env` as root-owned mode `0600` files under `/etc/newday`. Install `newday.nginx.conf` as `/etc/nginx/conf.d/newday.conf`. The generic systemd units read the target Web host and port from `web.env`.

The Web build uses repository-locked, locally bundled Geist and Noto Serif SC packages. CarryZ does not need Google Fonts access during the production build; install the packages from the selected npm registry with the frozen lockfile.

The initial acceptance certificate is self-signed with an IP subjectAltName. It encrypts LAN traffic but does not establish a browser-trusted identity; clients must verify its fingerprint out of band or install the certificate as a trusted local CA decision. This profile deliberately omits HSTS. Replace it with a trusted certificate and stable name before treating the service as a normal trusted HTTPS site.

Basic Auth credentials are generated on the target, never committed. During initial handoff the one-time plaintext is held in `/root/newday-initial-credentials.txt` with mode `0600`; copy it into a password manager and delete that file. The bcrypt htpasswd file remains `/etc/nginx/newday.htpasswd` as `root:www-data` mode `0640`.

The target still follows the main package's release, systemd, backup, restore, and rollback procedures. A successful LAN deployment does not prove off-host disaster recovery until a verified backup copy is stored and restored independently.

## Read-only target-host preflight

After staging the package on CarryZ, run this **on that host** as root so private file metadata and socket owners can be inspected. The command has no SSH client, does not call `sudo`, and does not install, write, reload, restart, or enable anything:

```bash
/usr/bin/node /opt/newday/current/deploy/self-host/targets/carryz/preflight.mjs
```

The command writes only to stdout (redacted JSON) and stderr (short human report). Exit status is `0` for local-host GO, `1` for NO-GO blockers, and `2` for incorrect command usage. A missing or unreadable probe fails closed as a blocker. Expected Apache `:80` and Docker `:3000` listeners are inventory checks; their absence is a warning, while any wrong or extra listener on the three NewDay ports is a blocker. No env contents, command output, certificate material, passwords, or backup destination string appear in either report.

The checks cover Debian 12 x86_64 and systemd; the two service accounts; exact installed env metadata and allowlisted non-secret bindings; API and Web sockets linked to their systemd MainPIDs, and nginx sockets; installed unit profile, reload state, and `systemd-analyze verify`; installed nginx file byte identity against the reviewed CarryZ profile and a static brace/directive syntax check; private auth/TLS files; Node 24+, an installed pnpm tool and discoverable version; the root-owned release's API/Next/Linux SWC artifacts and built `/api` rewrite; SQLite and backup filesystem types, ownership, and free space. Native `nginx -t` is deliberately **not run** because it can create PID/log/temp files or bind sockets even in test mode. Its absence is an explicit warning and requires a separate host acceptance step. pnpm is also **not executed** because a Corepack shim can download packages or populate a cache. Unknown pnpm version is reported as a warning when the reviewed build artifacts are already present. The free-space floor is at least 512 MiB on each mount, or twice the SQLite plus WAL/SHM size for data and three times for backups; if both directories share a mount, the combined floor is five times that size. These are conservative staging checks, not a write/fsync or restore rehearsal.

There is no off-host copy job in this package. The optional root-owned mode `0600` `/etc/newday/off-host-backup.json` declaration lets the preflight identify an operator-configured destination without reading credentials or executing a transfer. Its entire format is:

```json
{"enabled":true,"destination":"ssh://backup.example.invalid/newday"}
```

The destination must use an `ssh`, `s3`, `https`, `b2`, or `gs` URL with a non-loopback host and no embedded credentials. This is only a syntactic declaration; DNS aliases and actual remote storage are not contacted or verified. Its value is never printed. A declaration still leaves independent copy, hash verification, and restore acceptance unverified; JSON reports `offHostBackup.independentlyVerified: false`. Missing or invalid declarations are warnings in this **local-host** GO/NO-GO report and remain a disaster-recovery gap. The command never creates this file.

Node may be installed through a symlink at `/usr/bin/node`. The preflight requires the reference, every intermediate link and directory, and the executable to be root-owned; directories and the executable must be executable by the service accounts and not writable by group or others. Verify this installation boundary before starting the preflight as root. Node 24's Linux `MainThread` socket name is recognized only with the exact systemd MainPID and a `/proc/<pid>/exe` path and device/inode matching that trusted Node executable. Linux SWC is resolved from the installed Next package, including pnpm's dependency layout, and must remain inside the protected release.

For local development, `pnpm exec vitest run tests/unit/self-host/carryz-preflight.test.ts` evaluates synthetic host facts, mocked `ss` output, and isolated dependency layouts. This validates the command's decisions without running it on CarryZ or changing the target.
