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
