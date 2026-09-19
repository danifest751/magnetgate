# Linux exit deployment

[Overview](README.md) · [Обзор на русском](README.ru.md) · [Client guides](README.md#documentation)

These instructions describe the tracked scripts on `main`. The systemd deployment uses
`/opt/magnetgate`, a dedicated `magnetgate` runtime user and a separate `magnetgate-build` user
for candidate validation. The sing-box installer currently downloads **Linux amd64** only.

## Prerequisites and ports

Use a Linux amd64 VPS with systemd, a public IPv4 address and administrative access. Install
Node.js **20.19+** with `/usr/bin/node`, npm, Git, Bash, `flock`, `runuser`, OpenSSL, curl, tar,
CA certificates and standard user-management utilities. The scripts assume these are already
available; they do not provision the OS or install Node. Review existing services before assigning
these ports.

| Incoming port | Purpose |
|---|---|
| TCP 443 | Reality through sing-box |
| UDP 443 | hysteria2 through sing-box |
| TCP 49001 | Default native magnetgate transport |
| UDP 20001 | Optional self-hosted DHT bootstrap (`magnetgate-dht`) |
| UDP 20002 | Example fixed DHT port for the exit publisher |

If selecting experimental native UDP, allow its configured UDP port instead of the native TCP
port. Bootstrap and publisher are separate DHT nodes and cannot bind the same UDP port. Allow
required outbound DNS, DHT UDP, HTTPS and Nostr WSS traffic, including server egress to the
destinations clients use. Apply rules in both host and provider firewalls. The sing-box setup
script attempts to allow TCP/UDP 443 through UFW; it does not configure the other ports or the
provider firewall.

## First installation

Run the following **as root**, on a new installation. Replace placeholders locally. Generate a
random shared key with at least 128 bits of entropy, for example with `openssl rand -hex 32`,
and distribute it privately. Publishers sharing this key must have different slots. Do not put
the key in a Git commit or a process command-line argument.

```bash
git clone https://github.com/danifest751/magnetgate.git /opt/magnetgate
cd /opt/magnetgate
id -u magnetgate >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin magnetgate
install -d -o magnetgate -g magnetgate -m 750 /var/lib/magnetgate
install -o root -g magnetgate -m 640 /dev/null /etc/magnetgate.env
# Edit /etc/magnetgate.env using the example below before continuing.
```

Example `/etc/magnetgate.env` (use the real address, key and country for this node):

```ini
MAGNETGATE_PSK=<random-shared-key>
MAGNETGATE_PUBLIC_HOST=<PUBLIC_IP>
MAGNETGATE_PORT=49001
MAGNETGATE_DHT_PORT=20002
MAGNETGATE_NODE_SLOT=0
MAGNETGATE_NODE_NAME=exit-0
MAGNETGATE_NODE_COUNTRY=NL
DHT_BOOTSTRAP=127.0.0.1:20001,router.bittorrent.com:6881,dht.transmissionbt.com:6881
```

The Nostr relay pool has defaults; override `MAGNETGATE_NOSTR_RELAYS` if required. The runtime
unit sets durable sequence and health paths in `/var/lib/magnetgate`. Keep the environment file
root-owned and group-readable by `magnetgate`.

```bash
cp systemd/*.service systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
# Enable without starting: deploy.sh installs dependencies and then starts these services.
systemctl enable magnetgate-exit.service magnetgate-dht.service
bash /opt/magnetgate/scripts/deploy.sh

# Configure Reality/hysteria2, certificate, credentials and rotation timer.
MAGNETGATE_PUBLIC_HOST='<PUBLIC_IP>' bash /opt/magnetgate/scripts/setup-singbox.sh

systemctl enable --now magnetgate-health.timer
# Optional unattended updates from origin/main:
systemctl enable --now magnetgate-deploy.timer
```

On an exit-only host, enable only `magnetgate-exit.service` and replace `127.0.0.1:20001` with
reachable external bootstraps. The updater manages only enabled or active exit/DHT services;
it refuses to run if neither is selected.

`setup-singbox.sh` installs a checksum-pinned binary if `sing-box` is absent. An existing binary
is not replaced or checksum-verified by that step. The generated unit uses
`/usr/local/bin/sing-box`, so verify that path/version when supplying a binary yourself. The
script creates a pinned self-signed hysteria2 certificate, stable Reality identity, configuration,
`/etc/magnetgate-dp.json` and a daily rotation timer, and starts the engine. Set
`MAGNETGATE_REALITY_SNI` during setup if using a different Reality handshake site.

## Verify the installation

```bash
systemctl status magnetgate-exit magnetgate-dht sing-box --no-pager
journalctl -u magnetgate-exit -n 60 --no-pager
systemctl start magnetgate-health.service
journalctl -u magnetgate-health -n 20 --no-pager
systemctl list-timers 'magnetgate-*'
```

Omit `magnetgate-dht` on an exit-only host. An active unit does not prove client reachability:
verify discovery and an HTTPS request from a client on another network. Check both discovery
channels and the desired transports. A DHT-only offer omits hysteria2 certificate material.

The health checker detects stale/failed publication and a small DHT routing table after warmup
(defaults: 100 nodes, 30 minutes). Investigate publisher-port reachability and bootstrap access;
successful outgoing publication alone does not prove inbound reachability. Optional webhook or
Telegram alerts use the `MAGNETGATE_ALERT_*` variables in the
[README](README.md#environment-variables); keep credentials in the private environment file.

## Multiple nodes

Give nodes the same PSK and unique `MAGNETGATE_NODE_SLOT` values in **0..15**. Set a useful
`MAGNETGATE_NODE_NAME` and the correct optional two-letter `MAGNETGATE_NODE_COUNTRY`. For two nodes:

```ini
# Add on both nodes; the second node uses MAGNETGATE_NODE_SLOT=1.
MAGNETGATE_PEER_SLOTS=0,1
MAGNETGATE_EXPECT_PEERS=1
MAGNETGATE_PEER_ALERT_AFTER=3
```

Restart the exit after changing its environment. Clients can start with slots `[0, 1]` and learn
additional slots from peer advertisements; allocation is manual. Every publisher needs its own
sequence state and process lock. Fail-over selects a node/transport for new connections; it does
not migrate established streams or hide exit addresses. Country preference can fall back when
no discovered node matches.

## Updates and rollback

`magnetgate-deploy.timer` checks every three minutes, with a small randomized delay. For an
attended update, stop the timer while invoking the same updater:

```bash
systemctl stop magnetgate-deploy.timer
bash /opt/magnetgate/scripts/deploy.sh
# Resume only if this host uses unattended updates:
systemctl start magnetgate-deploy.timer
```

The updater fetches `origin/main` and refuses tracked local changes. It archives the candidate
into a temporary checkout and runs `npm ci --omit=dev --ignore-scripts` plus `npm test` as
`magnetgate-build`. Root then activates dependencies, code and units, restarts the selected
exit/DHT services and checks that they remain active. Failed activation triggers an attempt to
restore the previous revision, dependencies and units. Incomplete rollback preserves recovery
files and reports their location. `/var/lib/magnetgate-deploy/revision` is recorded only after
success; the deployment log is `/var/log/magnetgate-deploy.log`.

The activation check is service liveness, not end-to-end network acceptance. The updater does
not update sing-box, rotate keys, build or distribute clients, or reverse data/schema migrations.
Plan those steps separately.

Creating `/opt/magnetgate/.deploy-verify` enables `git verify-commit` on the fetched commit. First
establish trusted signing keys and a signed-commit workflow; otherwise updates will fail. HTTPS
Git access does not enable this gate. Install/tests are unprivileged, but trusted candidate code
and systemd units are still activated on the server.

## Credential and rule-list updates

The rotation timer changes Reality shortId/UUID and the hysteria2 password daily, allowing the
previous generation for one interval. Stable keys, obfuscation secret and certificate are retained.
Trigger a rotation with `systemctl start magnetgate-rotate.service`. Rotation restarts sing-box,
interrupting its existing connections. The exit watches the data-plane file and republishes
promptly. This rotates credentials, not the server IP or group PSK.

To prepare the rule-list manifest advertised to Android:

```bash
cd /opt/magnetgate
node scripts/update-rulesets.mjs
# If existing checksums changed, review them before accepting:
node scripts/update-rulesets.mjs --accept
```

The default output is `/etc/magnetgate-rulesets.json`; override `MAGNETGATE_RULESETS_FILE`
consistently in the update command and exit environment if using another location. First
publication writes downloaded checksums; later changes require `--accept`. The script checks
SRS format and caps each file at 8 MiB. Ensure the exit user can read the manifest. Android obtains
it in the sealed offer, downloads through the tunnel and verifies hashes. This operator process
is separate from checksum pins used to package desktop/Android assets.

## State, backup and recovery

Privately back up `/etc/magnetgate.env`, `/var/lib/magnetgate/seq`, `/etc/sing-box/`,
`/etc/magnetgate-dp.json`, the rule-list manifest and systemd overrides. These include credentials
and private keys; keep them outside Git with restricted permissions. Stop the publisher for a
consistent state backup. Never run two publishers for one PSK/slot from copied sequence state.
Restoring an old sequence can leave offers stale until the counter exceeds the published value;
preserve the latest state when moving hosts.

Changing the public host also requires updating the rotation service environment and regenerating
advertised data-plane endpoints, not just changing the native exit environment. Review client
bootstrap lists when retiring an old bootstrap address. Keep the PSK/slot stable if clients should
discover a replacement without new access settings. Existing connections still need to reconnect.

For failed updates, hold the deploy timer, inspect its journal and recovery directory, restore
matching code/dependencies/units and verify client traffic before resuming updates. Do not remove
sequence files, private keys or firewall access blindly as a recovery step.
