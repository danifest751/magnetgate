# magnetgate

> A censorship-resistant tunnel with **no fixed address and no broker**: the client finds the exit
> on its own over two independent rendezvous channels, then connects through a camouflaged data plane.

**RU:** [README.ru.md](README.ru.md)

An exit node publishes a signed and encrypted **offer** into public infrastructure; a client
discovers it from a shared secret (PSK) and connects — preferring a strongly camouflaged data plane
(Reality / hysteria2) and falling back to magnetgate's own forward-secret channel. A censor sees
neither a centralized broker nor a single "suspicious" address it can simply block: rendezvous rides
the BitTorrent Mainline DHT **and** a pool of Nostr relays, and the data plane looks like ordinary
TLS / QUIC to a real website.

## How it works

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

All keys are derived deterministically from the PSK (`mgt-sig:` / `mgt-salt:` / `mgt-box:` /
`mgt-nostr:`), so no domains, certificates, trackers or brokers are required. The offer is sealed
with a secretbox under the PSK (only PSK holders can read or forge it). magnetgate's **native**
channel adds a forward-secret handshake (ephemeral X25519 authenticated under the PSK, replay-
protected), so a later PSK compromise does not decrypt past recorded native traffic; Reality and
hysteria2 bring their own well-studied camouflage and transport.

## Data planes

The offer advertises a list (`dp`) of data-plane endpoints. The client picks by preference and
fails over on error:

| Plane | Transport | Role | Notes |
|---|---|---|---|
| **Reality** | VLESS+Reality over TLS 1.3 (TCP/443) | primary | borrows a real site's TLS handshake (SNI); best against SNI/DPI |
| **hysteria2** | QUIC (UDP/443) + salamander obfs | alternative | great on lossy/mobile links; server cert pinned via the Nostr offer |
| **native `mgt`** | AEAD-framed mux over TCP (or reliable-UDP) on :49001 | fallback | forward-secret, no third-party binary, always available |

Reality and hysteria2 are run by a **bundled sing-box** on the client (`scripts/get-singbox.ps1`,
pinned SHA-256); magnetgate templates its config from the offer, supervises the process and routes
proxied connections through it. `MAGNETGATE_DATA_PLANE=mgt` forces the native channel only.

## Quick start

**Exit (a VPS with a public IPv4):**
```bash
# 1) magnetgate rendezvous + native channel (unprivileged, systemd units in systemd/)
npm ci
MAGNETGATE_PSK='<psk>' MAGNETGATE_PORT=49001 MAGNETGATE_PUBLIC_HOST=<PUBLIC_IP> \
MAGNETGATE_SEQ_FILE=/var/lib/magnetgate/seq \
DHT_BOOTSTRAP=127.0.0.1:20001,router.bittorrent.com:6881 node src/exit.js

# 2) Reality + hysteria2 data planes (sing-box) — one-time setup, then daily credential rotation
MAGNETGATE_PUBLIC_HOST=<PUBLIC_IP> bash scripts/setup-singbox.sh
```

**Client (local machine):**
```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts\get-singbox.ps1   # fetch the sing-box data-plane engine
node src/client.js .\magnetgate.config.json                        # or: node src/client.js "<psk>" 1080
```

**Verify:**
```powershell
curl.exe --socks5-hostname 127.0.0.1:1080 http://checkip.amazonaws.com/   # → exit IP
curl.exe --socks5-hostname 127.0.0.1:1080 https://www.youtube.com/robots.txt
```

Browser: SwitchyOmega / FoxyProxy → SOCKS5 `127.0.0.1:1080`. DNS is resolved at the exit (SOCKS5
hostnames), so local resolver poisoning is excluded.

## Rendezvous (two channels)

The exit publishes the same sealed offer to both channels, so discovery survives either being
blocked or shaped:

- **Mainline DHT (BEP 44)** — a mutable item keyed by a PSK-derived ed25519 key; republished every
  5 min. Lead `DHT_BOOTSTRAP` with an IPv4 node (some public bootstraps are IPv6-only and
  bittorrent-dht is udp4); a self-hosted bootstrap on the exit (`:20001`) is the most reliable.
- **Nostr relays** — a parameterized-replaceable event (kind 30078) under a PSK-derived secp256k1
  key, delivered push + instantly to new subscribers. Override the pool with `MAGNETGATE_NOSTR_RELAYS`,
  disable with `MAGNETGATE_NOSTR=off`.

## Split tunneling

`MAGNETGATE_RULES=path/to/rules.json` (or `rules` in the client config):
```json
{ "direct": ["ru", "*.local"], "proxy": [] }
```
If `direct` is non-empty, everything that does not match goes through the tunnel; if a non-empty
`proxy` is given instead, only listed domains go through the tunnel and the rest goes direct.

## Environment variables

| Variable | Meaning |
|---|---|
| `MAGNETGATE_PSK` | exit PSK, read from the env so it never lands on the argv/`ps` line (argv is a fallback) |
| `MAGNETGATE_PORT` / `MAGNETGATE_PUBLIC_HOST` | exit native-channel port and the public host advertised in the offer |
| `DHT_BOOTSTRAP` | CSV bootstrap list; **lead with an IPv4 node**, self-hosted `:20001` recommended |
| `MAGNETGATE_SEQ_FILE` | persistence for `seq` (mandatory on the exit: restarts must increment it, or an offer nonce can repeat) |
| `MAGNETGATE_NOSTR` / `MAGNETGATE_NOSTR_RELAYS` | disable the Nostr rendezvous channel / override its relay pool |
| `MAGNETGATE_DATA_PLANE` | client: `auto` (default — prefer Reality/hysteria2, else native) or `mgt` (native only) |
| `MAGNETGATE_RULES` | split-tunnel rules file (client) |
| `MAGNETGATE_SOCKS_HOST` | client SOCKS5 bind address (default `127.0.0.1`; do not expose it to the LAN) |
| `MAGNETGATE_ALLOW_PRIVATE` | exit: `1` allows CONNECT to loopback/link-local/RFC1918 (blocked by default — SSRF guard) |
| `MAGNETGATE_MAX_SESSIONS` / `MAGNETGATE_MAX_STREAMS` | exit resource caps (default 512 / 256 per session) |
| `MAGNETGATE_TRANSPORT` | native channel: `tcp` (default) or `udp` (experimental reliable-UDP) |
| `MAGNETGATE_REALITY_SNI` | exit: the site whose TLS Reality borrows (default `www.microsoft.com`) |
| `MAGNETGATE_STATS` | client: log per-exit traffic counters every N seconds |

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
Multiple exits: the client discovers every exit's offer, spreads streams round-robin, and fails over
to a healthy exit automatically (dead exits get a 30 s cooldown).

Windows autostart (scheduled task at logon):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-client-windows.ps1 -ConfigPath .\magnetgate.config.json
```
Linux autostart: `scripts/magnetgate-client.service` (systemd unit template).

## Credential rotation

`scripts/rotate-dp.mjs` (daily systemd timer, installed by `setup-singbox.sh`) rotates the Reality
shortId+uuid and the hysteria2 password, keeping the previous generation valid for one interval
(**grace window**) while preserving the stable Reality keypair / hy2 obfs / cert (so a client's
pinned key stays valid). The exit watches the dp file and republishes within ~1 s, so clients pick
up new credentials in seconds; the client switches sing-box to the new params cleanly and falls back
to the native channel during any gap. Trigger manually: `systemctl start magnetgate-rotate.service`.

## System-wide VPN mode (Windows)

The SOCKS5 client is the data plane; to route **all system traffic** through it,
[tun2proxy](https://github.com/tun2proxy/tun2proxy) creates a TUN adapter and feeds everything into
`127.0.0.1:1080` (DNS resolved at the exit). The exit IP is auto-bypassed so the client's own uplink
is not captured:

```powershell
# from an elevated PowerShell
powershell -ExecutionPolicy Bypass -File scripts\vpn-windows.ps1        # connect (downloads tun2proxy, pinned)
powershell -ExecutionPolicy Bypass -File scripts\vpn-windows.ps1 -Off   # disconnect
```
> Phase 3 will replace tun2proxy with sing-box's own TUN (one engine for both the data plane and the
> full-VPN layer, with a kill-switch, IPv6 handling and DNS-leak protection) — see the roadmap.

## Deployment (pull-based autodeploy)

The VPS pulls `main` from GitHub by itself (no GitHub Actions, no open webhook port):
```bash
# one-time bootstrap on the VPS (repo root == /opt/magnetgate)
git init && git remote add origin https://github.com/danifest751/magnetgate.git
git fetch origin && git checkout -f -B main origin/main

# unprivileged service user + state dir + secrets/config file (never in git)
useradd --system --no-create-home --shell /usr/sbin/nologin magnetgate
install -d -o magnetgate -g magnetgate -m 750 /var/lib/magnetgate
umask 077 && cat > /etc/magnetgate.env <<'ENV'
PSK=<your-128-bit-psk>
MAGNETGATE_PORT=49001
MAGNETGATE_PUBLIC_HOST=<PUBLIC_IP>
DHT_BOOTSTRAP=127.0.0.1:20001,router.bittorrent.com:6881
ENV
chown root:magnetgate /etc/magnetgate.env && chmod 640 /etc/magnetgate.env

cp systemd/*.service systemd/*.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now magnetgate-exit magnetgate-dht magnetgate-deploy.timer

# data planes (Reality + hysteria2 + daily rotation):
MAGNETGATE_PUBLIC_HOST=<PUBLIC_IP> bash scripts/setup-singbox.sh
```

`magnetgate-deploy.timer` runs `scripts/deploy.sh` every 3 minutes: fetch → hard reset to
`origin/main` → `npm ci` (only when the lockfile changed) → copy changed units → restart services.
The exit, DHT and sing-box run as unprivileged users under systemd sandboxes (`NoNewPrivileges`,
`ProtectSystem=strict`, dropped capabilities). Create `/opt/magnetgate/.deploy-verify` to require a
signed commit (`git verify-commit`) before running new code as root. (Deploy restarts only the
magnetgate exit/DHT; sing-box is untouched, so Reality/hysteria2 sessions survive updates.)

## Documentation

Design notes, the implementation spec, the testing methodology and the research survey (with the
2026 build plan) live in the internal `docs/` directory, kept out of the public repository.
Test report: [tests/results.md](tests/results.md). Unit tests: `npm test` (node:test).
Commit conventions: [CONTRIBUTING.md](CONTRIBUTING.md) (Conventional Commits, English-only,
enforced by a `commit-msg` hook).

## Status

Implemented and tested in production:

- **Rendezvous** over two independent channels — Mainline DHT (BEP 44) + Nostr — with automatic
  merge/fail-over; offers signed + encrypted under the PSK.
- **Data planes** — Reality (primary) and hysteria2 (alternative) via a bundled sing-box, with the
  native forward-secret multiplexed channel as the always-available fallback; per-connection
  selection and fail-over.
- **Credential rotation** with a grace window and ~1 s propagation.
- **Hardening** — exit/DHT/sing-box run unprivileged under systemd sandboxes; the PSK never appears
  on the process command line; the exit blocks egress to loopback/link-local/RFC1918 (SSRF guard)
  and caps concurrent sessions/streams; the SOCKS listener is loopback-only; downloaded binaries are
  pinned by SHA-256; `npm ci` for reproducible installs.

Known limitations: obfuscation of the native channel is at PoC level, and the DHT platform sees put/get
participants' IPs like any BitTorrent node. The rendezvous target is derived from the PSK, so anyone
who holds — or brute-forces a weak — PSK can locate the exit: **use a ≥128-bit random PSK.**

## Roadmap

> Full detail, including the **exit-overlay (entry/egress split)** design, is in [ROADMAP.md](ROADMAP.md).

**Phase 3:**
- ✅ **hy2 cert-pinning** — the server cert now ships via the size-unbounded Nostr offer (DHT offer
  compact, both sealed under disjoint nonces), dropping the `insecure` fallback for hysteria2.
- **sing-box TUN as the system-wide VPN** (next), replacing tun2proxy — one engine for both the data
  plane and the full-VPN layer, with a **kill-switch**, IPv6 handling and DNS-leak protection.

**After Phase 3:**
- **WebRTC DataChannel data plane** (coturn on the exit; DTLS looks like a video call; built-in NAT
  traversal) as another `dp` type — direct P2P without a fixed data port.
- **A third rendezvous channel** — a DoH / ENS dead-drop as a tertiary discovery path, so Layer 1
  has ≥3 independent mechanisms.
- **Multi-exit fan-out** — several exits, each rotating Reality/hysteria2; the client load-balances
  and fails over across them.
- **Multipath aggregation** — carry one session across several data planes at once (MPTCP-style), so
  blocking one degrades throughput instead of dropping the session.
- **Cold-fallback tier** — email/IMAP store-and-forward for total-shutdown scenarios.
- **Cross-platform clients** — Linux/macOS/Android (sing-box is cross-platform) packaged as a
  service, plus automated exit provisioning and health/metrics.

## Disclaimer

This software is provided for research and educational purposes, "as is", without warranty of any
kind (see [LICENSE](LICENSE)). The authors are not affiliated with any platform or service, do not
provide legal advice, and do not encourage the violation of any laws. You are solely responsible for
complying with the laws of your jurisdiction — including, where applicable, restrictions on the use
and promotion of circumvention tools. Do not use this software for unlawful purposes or to harm
others. The authors assume no liability for any misuse by third parties.

## License

MIT — see [LICENSE](LICENSE).
