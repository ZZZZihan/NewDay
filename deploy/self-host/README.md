# NewDay single-host package

This directory is a **template**, not an installation. It assumes one trusted Linux host running one NewDay instance for one person. NewDay itself has no login or tenant boundary. The nginx Basic Auth gate protects every browser route, including `/api/*`; the web and API processes listen on loopback only. Other local users or workloads on the host could reach those loopback ports, so use a dedicated host or otherwise trusted local accounts. Do not put a CDN or another proxy in front without reviewing its authentication and caching behavior.

## Exact target assumptions

- Debian 12 or Ubuntu 24.04 style host with systemd, nginx, `www-data`, `htpasswd` (from `apache2-utils`), and an already provisioned, renewed TLS certificate. The example uses `newday.example.com`; replace **every** occurrence with the real DNS name and certificate paths before activation. Only TCP 443 needs external ingress. The example does not configure ACME or HTTP port 80.
- Node.js 24+ is at `/usr/bin/node`. pnpm 10.29.1 is used for the build. Build on the target Linux architecture, or transfer a build made for the same OS and architecture. Run `pnpm install --frozen-lockfile`, `pnpm check`, and `NEWDAY_API_ORIGIN=http://127.0.0.1:3001 pnpm build` in a clean checkout of the reviewed Git SHA. This build value is fixed in Next's `/api` rewrite; a runtime-only change does not update it.
- Web fonts are installed as locked npm dependencies and bundled locally. Production builds must not depend on reaching Google Fonts; this keeps target-host and offline rebuilds reproducible on networks where `fonts.gstatic.com` is unavailable.
- Install each reviewed build in `/opt/newday/releases/<sha>` and switch `/opt/newday/current` to that release. The release tree is root-owned and read-only to both services, except `apps/web/.next/cache`, owned by `newday-web`. Keep the previous release for rollback. Do not copy a developer `.env`, local `data/`, `.test-data/`, logs, or credentials into a release.
- The API owns `/var/lib/newday/newday.sqlite` and its `-wal`/`-shm` files through the `newday-api` account. Use a local POSIX filesystem for SQLite, not NFS or an object-store mount. `/var/lib/newday` is `0700`; API files are created under `UMask=0077`. The web account cannot read that directory. `/var/backups/newday` is a separate private directory owned by `newday-api` on a filesystem that supports file and directory sync. Put it on separately managed storage when possible, and copy verified backups to encrypted off-host storage. A backup on the same disk alone does not cover disk loss.
- `/etc/newday/api.env` and `/etc/newday/web.env` are root-owned `0600` files made from the two examples. Keep provider generation disabled unless its separate data, key, and cost decisions are made. Do not put a key in the web environment. The root `pnpm start` launcher reads a repository `.env`; these units deliberately start each built service directly.

## Files and privilege boundary

| File / path | Purpose and owner |
| --- | --- |
| `systemd/newday-api.service` | `newday-api` process, loopback `127.0.0.1:3001`, only `/var/lib/newday` writable |
| `systemd/newday-web.service` | `newday-web` process, loopback host/port from `web.env` (default `127.0.0.1:3000`), only Next cache writable |
| `systemd/newday-backup.service` and `.timer` | Daily online SQLite snapshot as `newday-api`, with integrity check; writable state directory permits WAL shared-memory updates |
| `nginx/newday.conf` | TLS and Basic Auth before proxying all routes to Web; no direct API upstream |
| `api.env.example`, `web.env.example` | Non-secret configuration templates; API has the persistent DB path |
| `backup.mjs`, `restore.mjs` | Node 24 built-in SQLite backup and guarded offline restore |

The proxy consumes the Basic Auth header and removes it before forwarding. API `NEWDAY_WEB_ORIGIN` must equal the public HTTPS origin. Browser Origin checking is an additional check, not authentication. Deny external access to the configured Web/API ports in the host firewall and check both processes actually bind only `127.0.0.1`. When changing `NEWDAY_WEB_PORT`, update nginx's Web upstream to the same loopback port.

`targets/carryz` is the reviewed non-secret profile for the first Debian 12 LAN deployment. It avoids that host's existing Apache TCP 80 and Docker-published TCP 3000 listeners by using API 3001, Web 3100, and nginx `172.23.1.127:8443`. Its self-signed certificate is only a LAN acceptance measure, not public or browser-trusted TLS.

## Future installation sequence (not run by this package)

1. Create system accounts with no login shell: `newday-api` and `newday-web`. Create `/var/lib/newday` and `/var/backups/newday` as `newday-api:newday-api` mode `0700`; create `/etc/newday` as `root:root` mode `0700`. Place edited env files there as `root:root` mode `0600`. Keep `NEWDAY_API_HOST=127.0.0.1`, `NEWDAY_API_PORT=3001`, `NEWDAY_DATABASE_PATH=/var/lib/newday/newday.sqlite`, and `NEWDAY_AGENT_PROVIDER=disabled` as shown. On an otherwise clean Debian/Ubuntu target, the account and directory setup is:

   ```bash
   sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin newday-api
   sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin newday-web
   sudo install -d -m 0700 -o newday-api -g newday-api /var/lib/newday /var/backups/newday
   sudo install -d -m 0700 -o root -g root /etc/newday
   # After editing the two examples for the target, install each with:
   sudo install -m 0600 -o root -g root api.env /etc/newday/api.env
   sudo install -m 0600 -o root -g root web.env /etc/newday/web.env
   ```

2. Build a clean reviewed revision as above. Make `/opt/newday/releases/<sha>` root-owned and readable by the service accounts. Ensure only its `apps/web/.next/cache` directory is writable by `newday-web`; it must exist before `newday-web.service` starts. Confirm `/usr/bin/node` and the Next CLI path in the unit exist in that release. Record the previous `/opt/newday/current` target, then atomically switch the symlink to the new release. On this assumed GNU/Linux host, use an owned temporary link and `mv -T` after the build and DB snapshot are ready:

   ```bash
   readlink -f /opt/newday/current  # record this exact old path outside the shell
   sudo ln -s /opt/newday/releases/<new-sha> /opt/newday/.current-next
   sudo mv -Tf /opt/newday/.current-next /opt/newday/current
   ```
3. Install the unit files under `/etc/systemd/system/`; run `systemd-analyze verify` on them, then `systemctl daemon-reload`. Install the edited nginx file within nginx's `http` context. With `umask 077`, create `/etc/nginx/newday.htpasswd` interactively using `htpasswd -c -B /etc/nginx/newday.htpasswd <username>`; then set `root:www-data` and mode `0640`. Never place the password in a shell argument, env template, Git, or a test fixture. Validate with `nginx -t` before reload. Ensure the certificate is valid and renews independently.
4. Start `newday-api.service`, then `newday-web.service`, then reload nginx. Enable `newday-backup.timer` only after checking `/var/backups/newday` permissions and free space. Check `systemctl status` for all three units and the timer. Check `ss -ltnp` for the configured loopback Web/API ports and nginx TLS listener; no app listener should bind a public address.
5. From a separate client, unauthenticated `https://<domain>/` and `https://<domain>/api/health` must each return `401`. Authenticated health must return `200` with `{"status":"ok"}`. `curl -u <username> https://<domain>/api/health` prompts for the password without placing it in the command line. Confirm the browser can read and write a disposable task and still see it after an API restart. These are deployment acceptance checks, not results claimed by this local package.

Do not expose the API directly, create an unauthenticated `/api` nginx location, or test replacement imports against existing data. If public access, multiple users, untrusted host workloads, or a CDN is required, revisit the authentication and storage design first.

## Backup, verification, and restore

`newday-backup.timer` runs daily at 02:00 host time with up to 15 minutes of jitter and catches missed runs. `backup.mjs` uses SQLite's online backup API, so committed WAL transactions are included while the API stays up. It writes a private temporary file, checks SQLite integrity and foreign keys plus NewDay metadata, hashes it, syncs it, and renames it to a unique `.sqlite` file under `/var/backups/newday`. A failed check does not publish a backup. The JSON output includes its absolute path and SHA-256. Monitor timer failures and backup age; copy to encrypted off-host storage and verify the copied hash. Set retention after the off-host copy is proven; this package never deletes older published backups automatically.

Manual backup, under the API account:

```bash
sudo -u newday-api /usr/bin/node /opt/newday/current/deploy/self-host/backup.mjs \
  --database /var/lib/newday/newday.sqlite --output-dir /var/backups/newday
```

For a restore, record the current release SHA and selected backup hash. Make a fresh backup first if the current DB is readable. Stop the backup timer, let any active backup job finish, then stop **both** `newday-web.service` and `newday-api.service`; verify all three services are inactive. The restore command requires an explicit offline flag and rejects active named units on Linux. It checks the input before touching the database, rechecks a private copy, then moves the old DB and any WAL/SHM files into a private `.newday-pre-restore-*` directory beside the DB. It installs only the checked copy. The JSON result names that retained directory. Do not delete it until post-restore checks pass. Run as `newday-api` so the restored file remains private:

```bash
sudo systemctl stop newday-backup.timer
systemctl is-active newday-backup.service  # wait until inactive
sudo systemctl stop newday-web.service newday-api.service
systemctl is-active newday-web.service newday-api.service newday-backup.service  # all inactive
sudo -u newday-api /usr/bin/node /opt/newday/current/deploy/self-host/restore.mjs \
  --database /var/lib/newday/newday.sqlite \
  --backup /var/backups/newday/<verified-backup>.sqlite --offline-confirmed
sudo systemctl start newday-api.service newday-web.service
sudo systemctl start newday-backup.timer
```

Check API health on loopback, then authenticated health through nginx, then actual planner and Agent history in the browser. A physical SQLite snapshot includes tasks, life workspace, Agent records, preferences, and execution ledger in one database; the planner and Agent JSON backup endpoints cover different scopes and are not a substitute for this full-file snapshot. The 10-second in-memory manual undo state does not survive process restart.

To rehearse without touching production, run `pnpm exec tsx deploy/self-host/verify-local.ts` in the source checkout. It creates a disposable NewDay schema, commits a WAL change while a writer stays open, takes a backup, changes the data, closes the writer, restores the backup, confirms both restored data and retained previous data, and rejects a corrupt backup without changing the destination.

## Release rollback

Before changing a release, record the old `current` symlink target. In a maintenance window, stop the timer and app services, wait for any running backup, then take a verified pre-change SQLite snapshot while no app can accept writes. After switching to the new release, validate it before resuming normal use. If it fails, stop the timer and app units again and confirm they are inactive. If the new release accepted writes, take and retain a separate snapshot of that current database before restoring the pre-change snapshot; the old release will then show the earlier state. Restore the pre-change snapshot using the **new release's explicit script path** while that release is still available. Then atomically point `current` to the recorded old release and start API followed by Web:

```bash
sudo systemctl stop newday-backup.timer
systemctl is-active newday-backup.service  # wait until inactive
sudo systemctl stop newday-web.service newday-api.service
systemctl is-active newday-web.service newday-api.service newday-backup.service  # all inactive
# If the failed release accepted writes, preserve that state first:
sudo -u newday-api /usr/bin/node /opt/newday/releases/<new-sha>/deploy/self-host/backup.mjs \
  --database /var/lib/newday/newday.sqlite --output-dir /var/backups/newday
sudo -u newday-api /usr/bin/node /opt/newday/releases/<new-sha>/deploy/self-host/restore.mjs \
  --database /var/lib/newday/newday.sqlite \
  --backup /var/backups/newday/<pre-change-backup>.sqlite --offline-confirmed
sudo ln -s /opt/newday/releases/<recorded-old-sha> /opt/newday/.current-rollback
sudo mv -Tf /opt/newday/.current-rollback /opt/newday/current
sudo systemctl start newday-api.service newday-web.service
sudo systemctl start newday-backup.timer
```

New code may have changed the SQLite schema; starting old code against a newer database is not an accepted rollback. Repeat health, authentication, task read/write, and persistence checks. Keep the failed release and the restore's `.newday-pre-restore-*` copy until the cause is understood. Repointing the symlink alone does not roll back data written after the snapshot.

Local checks prove the scripts and repository build on the development machine. The target host still needs `systemd-analyze verify`, `nginx -t`, real TLS/auth checks, backup timer observation, and a restore rehearsal on disposable target-host data before calling an installation accepted.
