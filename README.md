# MagnetGate

**Free, open-source VPN access for websites, video and calls.**

[Get the app and a personal code](https://magnet.norma.so/#start) · [Connection guide](https://magnet.norma.so/#guide) · [Русский](README.ru.md)

MagnetGate connects your device to ready-to-use nodes in Finland and the Netherlands.
You can also run your own nodes for a trusted group. These are separate access modes:
ordinary users do not need a server, a shared group key or command-line tools.

## Get connected

1. Open **[magnet.norma.so](https://magnet.norma.so/#start)** and download the app for your device.
2. Complete the human verification on the website and save your personal `MG1-…` code.
   Codes are issued automatically when capacity is available; no payment card is needed.
3. With the VPN disconnected, open the app's settings and activate the code in
   **«Личный доступ MagnetGate»**. On Android this is inside **Настройки → Доступ к группе**.
   On desktop use **«Подключить личный доступ»**.
4. Return to the connection screen, choose full or selective routing, and connect.
   Accept the operating system's VPN/administrator prompt when requested.

Keep the code private. It grants access to your devices and can be revoked on the
[website](https://magnet.norma.so/#questions). Revocation disconnects its active sessions
when the node next checks access. Public access does not require entering the node owner's PSK.

## Downloads and platforms

Use the current download links on the **[official website](https://magnet.norma.so/#start)**.
Installers are served there; a GitHub tag alone does not indicate a current installer.

| Platform | Download / installation | Status |
|---|---|---|
| Windows x64 | ZIP: extract all files, run `magnetgate.exe` | Desktop 0.3.4; administrator access for VPN |
| macOS, Apple Silicon | ARM64 DMG: move the app to Applications | Desktop 0.3.4; experimental, unsigned and unnotarized |
| macOS, Intel | x64 DMG: move the app to Applications | Desktop 0.3.4; experimental, unsigned and unnotarized |
| Android 8+ | ARM64 APK: allow installation from the browser/file manager | Native client; build identifier is shown in Settings |
| Linux | Node.js CLI / self-hosted exit from source | No public-code desktop installer |
| iOS | — | No app available |

**Which Mac build?** Apple menu → About This Mac: an Apple M-series chip means Apple Silicon;
an Intel processor means Intel. Both builds contain the same personal-code functionality.
macOS CI builds and automated checks pass on both architectures; interactive installation,
VPN authorization, real TUN connectivity and sleep/wake still need testing on real Macs.
Only authorize an unsigned build after verifying its source.

Desktop currently uses Russian labels. Android has RU/EN, with the new personal-access panel
currently in Russian. Windows/macOS and Android have separate interfaces.

## What public access includes

- **TCP and UDP**, including the transport needed by voice and video calls. There is no
  separate call ban. Actual call quality depends on the network and the calling application.
- Full-device routing or selective routing; app-specific exclusions are available on Android.
- Nodes in **Finland and the Netherlands**, with country selection.
- An individual access code and separate device credentials; the owner's group PSK is never
  included in the public app, page or issued connection profile.

On Android, reconnect after changing the country for an active public connection.

| Initial public beta limit | Value |
|---|---|
| Price | Free |
| Code lifetime | 30 days |
| Devices | Up to 2 per code |
| Daily traffic | 5 GiB total across those devices, reset at 00:00 UTC |
| Connection bandwidth | Up to 20 Mbit/s in each direction; not a guaranteed speed |

Capacity is shared. Human verification, registration limits, per-node connection limits and a
global traffic budget prevent mass registrations and overload. New codes may temporarily be
unavailable. A large shared network can reach its registration limit before you request a code.
Traffic accounting is periodic, so quota enforcement is approximate rather than byte-exact.

**Network requirement:** public access uses Hysteria2 over UDP/4443. It carries both TCP and
UDP application traffic, but it cannot connect when the underlying network blocks this UDP
transport entirely. The public mode does not currently fall back to Reality/native TCP.

## How personal access protects the owner's key

```text
Website + human verification → personal code
App + code + device ID       → HTTPS profile service → device credentials + pinned certificate
App                         → Hysteria2 public listener → Internet (TCP + UDP)
Node                        → access and quota service → allow / reject / disconnect
```

This mode uses a centralized HTTPS control service and a separate public listener on each node.
It does not use PSK discovery through DHT/Nostr. Revoking one code does not rotate the owner's
private key or interrupt other accounts. Codes are stored server-side as keyed digests;
device credentials are separate from the owner's PSK.

A user's own code and connection credentials necessarily exist on that user's device and can
be copied by its owner. This is individual, revocable access, not a way to hide a shared secret
inside an app. Desktop uses Electron's OS-backed secure storage; Android uses encrypted settings.
The access service stores account/device identifiers, expiry and traffic totals; the issuer
uses a daily keyed network identifier for registration limits. It does not collect browsing
history in its access database. Cloudflare processes website/control requests and human verification;
VPN traffic travels to the nodes. This is not an anonymity service or a guarantee against all leaks.

## Three distinct modes

| Mode | Credentials and discovery | Traffic |
|---|---|---|
| **Personal public access** | Website code; centralized HTTPS profiles | TCP + UDP through public Hysteria2 nodes |
| **Your own trusted group** | Shared PSK; Mainline DHT + Nostr | Reality / Hysteria2 / native fallback according to client and transport |
| **Peer pilot** | Separate authenticated WSS catalogue/relay and roles | Experimental TCP web traffic on ports 80/443; not the public-code service |

See [PEER-PILOT.md](PEER-PILOT.md) for peer sharing. Peer restrictions do not apply to personal
access to the public nodes. Do not distribute an owner-configured private build as a public installer.

## Self-hosting: trusted-group architecture

The following architecture, data-plane, CLI, discovery and rotation sections describe **your own
PSK-based group**. They are not required to connect using a website code.

The Node core/exit version is **0.11.1**, desktop is **0.3.4**, and Android uses a separate
git-derived build identifier. Node.js 20.19+ is required for the core; desktop builds need 22.12+.
Native sessions and sealed rendezvous envelopes use **wire v4**, and offer JSON uses schema v3.
Update private clients and exits together when migrating from older wire versions.

In this mode an exit publishes a signed, encrypted offer to Mainline DHT and Nostr; clients find
it with the shared PSK. There is no central discovery broker for this mode. Bootstrap nodes,
relays and exit addresses can still be blocked, and key rotation does not change server IPs.
Use a strong random PSK for a small trusted group. The proposed entry/egress overlay is not implemented.

## Private mode: how it works

```
Application ─▶ SOCKS5 127.0.0.1:1080  (magnetgate client, split-tunnel rules: direct vs proxy)
                    │
                    ▼   data plane, chosen per connection with automatic fail-over:
   ┌─ Reality (VLESS+Reality, TCP/443)  ─┐
   ├─ hysteria2 (QUIC, UDP/443)          ─┼─▶ sing-box ─▶ exit ─▶ CONNECT host:port ─▶ target
   └─ native mgt (forward-secret mux)    ─┘   (native rides exit :49001)

Rendezvous — how the client learns the exit + its current endpoints — over TWO independent channels:
   Mainline DHT (BEP 44, mutable, ed25519)   +   Nostr relays (kind 30078, secp256k1)
   the exit publishes one signed+encrypted offer (a list of data-plane endpoints) to both
```

Discovery keys are derived deterministically from the PSK (`mgt-sig:` / `mgt-salt:` / `mgt-box:` /
`mgt-nostr:`), so the group does not need its own discovery domain, tracker or broker.
Transport-specific TLS material is separate. The offer is sealed
with a secretbox under the PSK (only PSK holders can read or forge it). magnetgate's **native**
channel adds a forward-secret handshake (ephemeral X25519 authenticated under the PSK, replay-
protected), so a later PSK compromise does not decrypt past recorded native traffic; Reality and
hysteria2 bring their own well-studied camouflage and transport.

## Private mode: data planes

The offer advertises a list (`dp`) of data-plane endpoints. The client picks by preference and
fails over on error:

| Plane | Transport | Role | Notes |
|---|---|---|---|
| **Reality** | VLESS+Reality over TLS 1.3 (TCP/443) | primary | borrows a real site's TLS handshake (SNI); TLS camouflage; effectiveness depends on the network |
| **hysteria2** | QUIC (UDP/443) + salamander obfs | alternative | QUIC alternative; server cert pinned via the Nostr offer |
| **native `mgt`** | AEAD-framed mux over TCP (or reliable-UDP) on :49001 | fallback | forward-secret fallback; can also be blocked |

On Windows, Reality and hysteria2 run in **sing-box** fetched by `scripts/get-singbox.ps1`
with pinned SHA-256 checksums; magnetgate generates its configuration and supervises the process.
Android embeds the core and engine in one AAR managed by its VPN service.
`MAGNETGATE_DATA_PLANE=mgt` forces the Node client to use the native channel only.

## Private mode: CLI quick start

**Exit (a VPS with a public IPv4):**
```bash
# 1) magnetgate rendezvous + native channel (unprivileged, systemd units in systemd/)
npm ci
mkdir -p "$HOME/.local/state/magnetgate"
MAGNETGATE_PSK='<psk>' MAGNETGATE_PORT=49001 MAGNETGATE_PUBLIC_HOST='<PUBLIC_IP>' \
MAGNETGATE_SEQ_FILE="$HOME/.local/state/magnetgate/seq" MAGNETGATE_DHT_PORT=20002 \
DHT_BOOTSTRAP=127.0.0.1:20001,router.bittorrent.com:6881 node src/exit.js

# 2) On a provisioned Linux server, as root; see DEPLOYMENT.md first
MAGNETGATE_PUBLIC_HOST='<PUBLIC_IP>' bash scripts/setup-singbox.sh
```

**Client (local machine):**
```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts\get-singbox.ps1   # fetch the sing-box data-plane engine
Copy-Item magnetgate.config.example.json magnetgate.config.json   # first run only
# Edit magnetgate.config.json: add your PSK to exits[] and set discovery options.
node src/client.js .\magnetgate.config.json
```

**Verify:**
```powershell
curl.exe --socks5-hostname 127.0.0.1:1080 https://api.ipify.org   # → exit IP
curl.exe --socks5-hostname 127.0.0.1:1080 https://www.youtube.com/robots.txt
```

Configure an application to use SOCKS5 `127.0.0.1:1080` with remote hostname resolution.
Proxied hostnames are resolved at the exit; direct exceptions use the direct path. A SOCKS client
does not automatically capture all device traffic. Use the desktop or Android app for system VPN.

For a persistent exit with Reality/hysteria2, firewall ports and systemd, follow
[DEPLOYMENT.md](DEPLOYMENT.md). The short foreground example above assumes a reachable bootstrap
and an open fixed UDP DHT port; a local bootstrap must be started separately.

## Rendezvous (two channels)

The exit publishes a sealed offer to both channels — the same generation and `ts`, but not byte
identical: the DHT view is compact (it drops the hysteria2 endpoint, whose pinned certificate would
not fit the ~1000 B BEP 44 limit) while the Nostr view carries it. Clients merge the two by data-plane
type. Discovery can continue through the remaining reachable channel; a DHT-only client does not
receive the hysteria2 certificate:

- **Mainline DHT (BEP 44)** — a mutable item keyed by a PSK-derived ed25519 key; republished every
  60 s. Lead `DHT_BOOTSTRAP` with an IPv4 node (some public bootstraps are IPv6-only and
  bittorrent-dht is udp4); a self-hosted bootstrap (`:20001`) is useful, but keep another reachable
  bootstrap if that host moves.
- **Nostr relays** — a parameterized-replaceable event (kind 30078) under a PSK-derived secp256k1
  key, delivered push + instantly to new subscribers. Override the pool with `MAGNETGATE_NOSTR_RELAYS`,
  disable with `MAGNETGATE_NOSTR=off`.

## Routing rules

The Node SOCKS client reads `rules` from its JSON configuration:

```json
{ "rules": { "direct": ["ru", "local"], "proxy": [] } }
```

Direct matches take priority. If `proxy` is non-empty, only its matching domains use the tunnel;
otherwise every non-direct destination uses it. Domain entries also match subdomains.
`MAGNETGATE_RULES` is not read by the current client; use the JSON field.

The desktop and Android VPN apps expose Full and Split modes. Full tunnels traffic except explicit
direct rules and system/private-network bypasses. Split uses the packaged rule sets plus the user
tunnel list. Application exclusions are separate from website rules. See the client guides for
save/apply behavior and the desktop-only optional firewall guard.

## Environment variables

| Variable | Meaning |
|---|---|
| `MAGNETGATE_PSK` | exit PSK, read from the env so it never lands on the argv/`ps` line (argv is a fallback) |
| `MAGNETGATE_PORT` / `MAGNETGATE_PUBLIC_HOST` | exit native-channel port and the public host advertised in the offer |
| `MAGNETGATE_NODE_SLOT` / `MAGNETGATE_NODE_NAME` | exit: which rendezvous slot this node occupies (default `0` = the single-node layout) and the name it advertises; two nodes share one PSK by taking different slots |
| `MAGNETGATE_NODE_COUNTRY` | exit: optional two-letter country code (e.g. `NL`, `FI`) advertised in the offer. The desktop and Android show discovered countries as a preference, with fallback when none match. This is not a geographic guarantee. Nodes without a code are absent from the country list |
| `MAGNETGATE_SLOTS` | client: comma-separated slots to look for, e.g. `0,1` — one PSK then finds every node in the set (same as `slots` in the config file) |
| `MAGNETGATE_PEER_SLOTS` | exit: slots this node watches and advertises in `peers`, e.g. `0,1`; unset means no scanning, and a client that knows one slot can then learn the rest by itself |
| `MAGNETGATE_EXPECT_PEERS` | exit: log an `[alert]` when fewer than N peer slots answer (unset = never) |
| `MAGNETGATE_PEER_ALERT_AFTER` | exit: how many consecutive misses are needed before that alert (default 3; a single DHT lookup can come back empty for a live node) |
| `MAGNETGATE_SLOT_DISCOVERY` | client: `0` stops taking extra slots from a node's `peers` list (they are logged when taken) |
| `MAGNETGATE_PUBLISH_MS` | exit: republish cadence (default 60000); lower it only for tests |
| `DHT_BOOTSTRAP` | CSV bootstrap list; **lead with an IPv4 node**, self-hosted `:20001` recommended |
| `MAGNETGATE_SEQ_FILE` | durable sequence reservation before publication; one publisher per file (systemd holds `flock`). Offer nonces are independently random. |
| `MAGNETGATE_NOSTR` / `MAGNETGATE_NOSTR_RELAYS` | disable the Nostr rendezvous channel / override its relay pool |
| `MAGNETGATE_DATA_PLANE` | client: `auto` (default — prefer Reality/hysteria2, else native) or `mgt` (native only) |
| `MAGNETGATE_CONFIG` | Node client JSON file when no positional config/PSK argument is given |
| `MAGNETGATE_RULESETS_FILE` | exit: rule-set manifest advertised to Android (default `/etc/magnetgate-rulesets.json`) |
| `MAGNETGATE_SOCKS_HOST` | client SOCKS5 bind address (default `127.0.0.1`; do not expose it to the LAN) |
| `MAGNETGATE_ALLOW_PRIVATE` | exit: `1` allows CONNECT to loopback/link-local/RFC1918 (blocked by default — SSRF guard) |
| `MAGNETGATE_MAX_SESSIONS` / `MAGNETGATE_MAX_STREAMS` | exit resource caps (default 512 / 256 per session) |
| `MAGNETGATE_UDP_IDLE_MS` | exit: drop a reliable-UDP stream after this much silence (default 600000); a vanishing peer otherwise holds a slot forever |
| `MAGNETGATE_HEALTH_FILE` | exit: write publication health (last put, node count, consecutive failures) to this file |
| `MAGNETGATE_ALERT_AFTER` | exit: warn after N consecutive publications that reached no DHT node (default 5) |
| `MAGNETGATE_DHT_PORT` | exit: fixed UDP port for its DHT node; open it in the firewall. Unset (`0`) chooses an ephemeral port that does not suit a fixed-port firewall rule. Outgoing publication alone does not prove incoming reachability |
| `MAGNETGATE_MIN_DHT_NODES` | healthcheck: flag a smaller DHT table after warmup and investigate reachability (default 100 nodes; warmup 30 minutes) |
| `MAGNETGATE_ALERT_WEBHOOK` | healthcheck: POST `{"text": ...}` to this endpoint when the publication health check fails, and once when it recovers |
| `MAGNETGATE_ALERT_TG_TOKEN` / `MAGNETGATE_ALERT_TG_CHAT` | healthcheck: send those notifications to Telegram instead (or as well) |
| `MAGNETGATE_ALERT_COOLDOWN_MIN` | healthcheck: how often a still-broken exit may repeat its alert (default 30) |
| `MAGNETGATE_TRANSPORT` | native channel: `tcp` (default) or `udp` (experimental reliable-UDP) |
| `MAGNETGATE_REALITY_SNI` | exit: the site whose TLS Reality borrows (default `www.microsoft.com`) |
| `MAGNETGATE_STATS` | client: log per-exit traffic counters every N seconds |
| `MAGNETGATE_LOG_TARGETS` | client: `1` logs full destination host names; by default only an 8-hex fingerprint is logged, so a log file is not a browsing history |

## Configuration and autostart

Client config (`magnetgate.config.json`, see `magnetgate.config.example.json`):
```json
{
  "localPort": 1080,
  "dataPlane": "auto",
  "bootstrap": ["<exit-ip>:20001", "router.bittorrent.com:6881"],
  "rules": { "direct": ["ru"], "proxy": [] },
  "exits": [
    { "name": "nl", "psk": "<psk>" },
    { "name": "backup", "psk": "<other-psk>" }
  ]
}
```
Multiple exits: the client discovers their offers, distributes new streams and fails over on errors.
Health is tracked per node and transport, with increasing cooldowns. A new connection may choose a
different exit; established streams are not transparently migrated. For one shared PSK, set numeric
`"slots": [0, 1]`; each publisher must use a distinct slot in the range 0–15.

Windows autostart (scheduled task at logon):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-client-windows.ps1 -ConfigPath .\magnetgate.config.json
```
Linux autostart: adapt `scripts/magnetgate-client.service` as `magnetgate-client@.service`
and enable an instance for the intended user; verify its working directory and config permissions.

## Private mode: credential rotation

`scripts/rotate-dp.mjs` (daily systemd timer, installed by `setup-singbox.sh`) rotates the Reality
shortId+uuid and the hysteria2 password, keeping the previous generation valid for one interval
(**grace window**) while preserving the stable Reality keypair / hy2 obfs / cert (so a client's
pinned key stays valid). The exit watches the dp file and republishes within ~1 s, so clients pick
up new credentials as discovery delivers them. Rotation restarts sing-box and interrupts existing
engine connections; applications must reconnect. Native fallback depends on reachability.
Trigger manually: `systemctl start magnetgate-rotate.service`.

## System-wide VPN mode (Windows)

Use the [desktop app](app/README.md), which owns the sing-box TUN and native fallback. It requires
Administrator privileges. The optional strict Full firewall guard is off by default; it persists
after engine/app termination until explicit Disconnect, and still needs elevated failure/recovery
validation. Routing while an engine runs is not protection after it exits.

`scripts/vpn-windows.ps1` (tun2proxy) and `scripts/vpn-singbox-windows.ps1` are deprecated reference
launchers. They do not enable the persistent guard. Do not run them alongside the desktop VPN.

## Private mode: deployment

[DEPLOYMENT.md](DEPLOYMENT.md) covers Linux provisioning, required ports, multi-node settings,
rotation, backups and pull-based updates. `magnetgate-deploy.timer` checks `origin/main` every
three minutes. The updater validates a staged candidate with `npm ci --ignore-scripts` and
`npm test` as `magnetgate-build`, then activates it and attempts rollback if activation fails.
It refuses tracked local changes and restarts only the exit/DHT services enabled or active on that
host. The optional `.deploy-verify` file enables signature verification; it requires trusted signed
commits. This is separate from the runtime service sandboxes.

## Documentation

- [Android guide](app-android/README.md) · [Русская инструкция Android](app-android/README.ru.md)
- [Windows and macOS desktop guide](app/README.md)
- [Linux deployment](DEPLOYMENT.md)
- [Development and validation](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md)

Public instructions live in the tracked files above. Internal design notes and device evidence in
`docs/` are deliberately ignored; they are not required to follow the public guides.

## Status

Public TCP/UDP connectivity has been checked against both nodes with HTTPS, UDP DNS and STUN.
This does not replace an end-to-end call test or real-device testing on every platform.
The remaining list describes the private group mode; validation scope differs by component:

- **Rendezvous** over two independent channels — Mainline DHT (BEP 44) + Nostr — with automatic
  merge/fail-over; offers signed + encrypted under the PSK.
- **Data planes** — Reality (primary) and hysteria2 (alternative) via a bundled sing-box, with the
  native forward-secret multiplexed channel as a fallback; per-connection
  selection and fail-over.
- **Credential rotation** with a grace window and prompt offer republication.
- **Multi-node discovery** with peer-slot advertisements and per-plane health.
- **Android UI** with RU/EN, application/site rules and fresh-check status; verified on an
  Android 16 arm64 device, not a full device-compatibility matrix.
- **Hardening** — exit/DHT/sing-box run unprivileged under systemd sandboxes; the PSK never appears
  on the process command line; the exit blocks egress to loopback/link-local/RFC1918 (SSRF guard)
  and caps concurrent sessions/streams; the SOCKS listener is loopback-only; downloaded binaries are
  pinned by SHA-256; `npm ci` for reproducible installs. Client binary and fetched rule-set checksums
  are recorded in `scripts/pins.json`; the Linux installer keeps its own pinned archive checksum.
  Supplied local assets are separate; review their checksums before packaging. Android verifies
  downloaded rule sets against an authenticated manifest. `scripts/check-hygiene.mjs` (wired into
  a pre-commit hook) refuses to commit private keys, tokens, field reports or real host addresses.

Known limitations: obfuscation of the native channel is at PoC level, and the DHT platform sees put/get
participants' IPs like any BitTorrent node. The rendezvous target is derived from the PSK, so anyone
who holds — or brute-forces a weak — PSK can locate the exit: **use a ≥128-bit random PSK.**

## Roadmap

[ROADMAP.md](ROADMAP.md) separates completed work from remaining plans. Android, multi-node
discovery, per-plane health and the desktop TUN are implemented. Remaining work includes broader
device coverage, controlled desktop firewall failure/recovery tests, signed release distribution,
commit-signing operations and automatic slot allocation. Entry/egress overlay, a third discovery
channel, WebRTC, multipath and store-and-forward remain proposals.

## Disclaimer

This software is provided for research and educational purposes, "as is", without warranty of any
kind (see [LICENSE](LICENSE)). The authors are not affiliated with any platform or service, do not
provide legal advice, and do not encourage the violation of any laws. You are solely responsible for
complying with the laws of your jurisdiction — including, where applicable, restrictions on the use
and promotion of circumvention tools. Do not use this software for unlawful purposes or to harm
others. The authors assume no liability for any misuse by third parties.

## License

MIT — see [LICENSE](LICENSE).
