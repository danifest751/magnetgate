# Private analytics admin

A read-only Russian-language dashboard for the existing personal-access service.
It uses real SQLite data, not demo statistics. The landing page and VPN clients
remain separate. Charts open period-filtered details; tables have pagination,
opaque account details, node filters and current-page CSV export.

## Security boundary

There is **no public authentication yet**. The Python service binds exclusively
to `127.0.0.1:3420`, checks Host/Origin, rejects mutations and never trusts proxy
identity headers. Access it using SSH forwarding. Do not route `/admin/` or
`/admin/api/` through the public website, Cloudflare tunnel or a reverse proxy.
Future SSO requires a separate design and server-side authorization; hiding the
link or adding a frontend login screen is not authentication.

The source database is opened read-only with explicit field projections. Codes,
device passwords, token hashes, IPs, subnet hashes, node endpoints and settings
are never returned. Opaque account IDs, quotas and node IDs remain private
operational data: protect the history database, exports and backups as well.
Keep settings, databases, keys, `.env` files, logs and generated builds outside Git.
Files under `admin-private/`, SQLite files and `dist-admin/` are ignored.

## Build and validate

From `web/`:

```sh
npm ci
npm run build:admin
python3 -m unittest discover -p 'test_*.py'
```

Python 3.10+ and the website's existing Node/Vite requirements apply. No new
Python dependencies are needed. `npm run build` still builds only the public site.

## Installation next to the existing site

First verify the target already hosts the intended website **and** its personal
access API/database. A VPN exit or downloads service alone is not the website.
If the website cannot be positively identified, stop: do not deploy on that host.
Confirm the configured hostname and inspect the existing service/ingress locally;
do not publish its private configuration or command output.

Copy these source files and `dist-admin/` into a separate admin directory:
`admin_server.py`, `admin_store.py`, `admin_metrics.py`. Keep the current site's
release untouched. Run the admin as an unprivileged service account which can
read the public service's settings and database/WAL but write only its own history
directory. Set the history directory to mode `0700`; run with umask `077`.
Avoid granting the admin write permission to the public database; SQLite WAL
read access also needs the existing SHM file (do not make it writable merely to
bypass an error). Test access using the actual service account before installing.

```sh
python3 /opt/magnetgate-admin/admin_server.py \
  --settings /etc/magnetgate-public/settings.json \
  --history /var/lib/magnetgate-admin/history.sqlite \
  --static /opt/magnetgate-admin/dist-admin
```

These are example paths, not an operator configuration. Use the verified existing
private settings (`database`, `nodes`, quota limits). The admin only consumes the
existing store schema; it does not provision nodes, credentials or public access.
Keep it out of the public ingress and firewall exposure. For access:

```sh
ssh -N -L 3420:127.0.0.1:3420 <ssh-user>@<site-host>
```

Open `http://127.0.0.1:3420/admin/`. Local and remote forwarded ports must match
for the Host check; the service also supports `localhost` on the same port.
The default service port can be changed using `--port`.

Optional HTTP telemetry requires updating the existing public service with both
`server.py` and `admin_metrics.py`, adding `analyticsDatabase` to its **untracked
private settings**, and restarting that service in an approved maintenance window.
The path must match the admin history path; both processes need appropriate
permissions. This is deliberately not enabled automatically. Telemetry is
best-effort, aggregate-only: minute, allowlisted route/result, HTTP status,
count and bounded latency histogram. It never receives request bodies, headers,
credentials, query strings, IPs or identifiers. A full queue/storage failure
drops telemetry instead of blocking key issuance. No visitors/conversion
tracking is implemented.

Roll back by stopping/removing the separate admin service and removing the
optional `analyticsDatabase` setting. Preserve the private history backup if
needed; the source database is never migrated by this admin.

## What the metrics mean

- Scope: personal public Hysteria2 access only. Not group PSK, peer TCP pilot,
  Reality transports, website visitors or all machines' network traffic.
- Issued codes and global daily traffic come from quota counters. Historical
  days present at installation are preserved before normal source cleanup.
- Hourly node traffic starts at the first admin sample. Existing cumulative
  counters establish a baseline, not fabricated historical traffic. Counters
  are persisted across admin restarts, but bytes accumulated during downtime
  land in the recovery hour. Counter resets/agent epochs can limit precision.
- All periods use UTC; history retention is 31 days. Current-state cards are
  explicitly labeled “today/now”; period charts and tables honor date filters.
- Accounts/devices are current state, not historical membership. Expired
  accounts may be removed by the source service. There is no invented issue
  timestamp or historical account-level traffic breakdown.
- Connections are reported transport sessions, not unique users/devices.
  Stale reports are unknown, never zero-capacity/healthy assertions.
- A fresh heartbeat is not an internet health check. CPU, RAM, Google/site
  probes, errors from the VPN client and speed tests are not instrumented yet.
- Request p95 is a histogram upper-bound estimate with latency capped at 60 s,
  not an exact percentile. Totals cover the whole filtered period, not only the
  visible page. Pagination exposes all retained aggregates. CSV exports only
  the visible page; it never contains credentials.
- Source failures are marked immediately, and snapshots older than 30 seconds
  are rejected. No sample numbers are substituted when the source is missing.

Development: run the Python service locally against private test settings, then
`npm run dev:admin`. Vite proxies `/admin/api` to the local Python service. Never
use live customer data in browser screenshots, fixtures or Git commits.
