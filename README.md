# magnetgate

> SOCKS5 tunnel with rendezvous over the BitTorrent Mainline DHT — no domains, no brokers, no fixed addresses.

**RU:** [README.ru.md](README.ru.md)

An exit node publishes a signed (ed25519, BEP 44) and encrypted offer into the public DHT; a client
discovers it on its own from a shared secret (PSK) and establishes a direct encrypted connection.
A censor sees neither a "suspicious" IP on the client side nor a centralized broker — blocking the
rendezvous would mean blocking the Mainline DHT that the entire BitTorrent world relies on.

## How it works

```
Application → SOCKS5 127.0.0.1:1080
   ├─ proxy rules   → AEAD frames → exit (VPS) → CONNECT host:port → target
   └─ direct rules  → straight from the machine
Rendezvous: exit publishes offer {host,port,ts} into the Mainline DHT (BEP 44, mutable, ed25519)
Client: get(target) → signature check → decryption → connect
```

Identity/rendezvous keys are derived deterministically from the PSK (`mgt-sig:` / `mgt-salt:` /
`mgt-box:`), so no domains, certificates, trackers or brokers are required. The data channel then
runs a **forward-secret handshake** — an ephemeral X25519 exchange authenticated and encrypted
under the PSK — so session keys are ephemeral and a later PSK compromise does not decrypt past
recorded traffic. Payload travels as authenticated secretbox frames, size-padded into buckets.

## Quick start

**Exit (a VPS with a public IPv4):**
```bash
npm ci
# the PSK is read from the environment so it never lands on the argv / ps line
MAGNETGATE_PSK='<psk>' MAGNETGATE_PORT=49001 MAGNETGATE_PUBLIC_HOST=<PUBLIC_IP> \
MAGNETGATE_SEQ_FILE=/var/lib/magnetgate/seq \
DHT_BOOTSTRAP=127.0.0.1:20001,router.bittorrent.com:6881 node src/exit.js
```
(production: systemd units in `systemd/`, running as a non-root `magnetgate` user)

**Client (local machine):**
```powershell
npm install
$env:DHT_BOOTSTRAP='<exit-ip>:20001'   # a self-hosted bootstrap is more reliable than public ones
node src/client.js "<psk>" 1080
```

**Verify:**
```powershell
curl.exe --socks5-hostname 127.0.0.1:1080 http://checkip.amazonaws.com/   # → exit IP
curl.exe --socks5-hostname 127.0.0.1:1080 https://www.youtube.com/robots.txt
```

Browser: SwitchyOmega / FoxyProxy → SOCKS5 `127.0.0.1:1080`.
DNS is resolved at the exit (SOCKS5 hostnames), so local resolver poisoning is excluded.

## Split tunneling

`MAGNETGATE_RULES=path/to/rules.json`:
```json
{ "direct": ["ru", "*.local"], "proxy": [] }
```
If `direct` is non-empty, everything that does not match goes through the tunnel; if a non-empty
`proxy` is given instead, only listed domains go through the tunnel and the rest goes direct.

## Environment variables

| Variable | Meaning |
|---|---|
| `MAGNETGATE_PSK` | exit PSK, read from the env so it never lands on the argv/`ps` line (argv is a fallback) |
| `MAGNETGATE_PORT` / `MAGNETGATE_PUBLIC_HOST` | exit data port and the public host advertised in the offer |
| `DHT_BOOTSTRAP` | CSV bootstrap list. **Lead with an IPv4 node** — `dht.transmissionbt.com`/`dht.libtorrent.org` are IPv6-only on some hosts and bittorrent-dht is udp4. A self-hosted node (`127.0.0.1:20001` on the exit, `<exit-ip>:20001` on the client) is the most reliable |
| `MAGNETGATE_SEQ_FILE` | persistence for `seq` (mandatory on the exit: restarts must increment it, or an offer nonce can repeat) |
| `MAGNETGATE_RULES` | split-tunnel rules file (client) |
| `MAGNETGATE_SOCKS_HOST` | client SOCKS5 bind address (default `127.0.0.1`; do not expose it to the LAN) |
| `MAGNETGATE_ALLOW_PRIVATE` | exit: `1` allows CONNECT to loopback/link-local/RFC1918 targets (blocked by default — SSRF guard) |
| `MAGNETGATE_MAX_SESSIONS` / `MAGNETGATE_MAX_STREAMS` | exit resource caps (default 512 sessions / 256 streams per session) |
| `MAGNETGATE_TRANSPORT` | native channel: `tcp` (default) or `udp` (experimental reliable-UDP) |
| `MAGNETGATE_DATA_PLANE` | client: `auto` (default — prefer Reality/hysteria2 via sing-box, else native) or `mgt` (native only) |
| `MAGNETGATE_NOSTR` | `off` disables the Nostr rendezvous channel; `MAGNETGATE_NOSTR_RELAYS` overrides the pool |
| `MAGNETGATE_STATS` | client: log per-exit traffic counters every N seconds |

## Configuration and autostart

Client config (`magnetgate.config.json`, see `magnetgate.config.example.json`):

```json
{
  "localPort": 1080,
  "bootstrap": ["<exit-ip>:20001"],
  "rules": { "direct": ["ru"], "proxy": [] },
  "exits": [
    { "name": "nl", "psk": "<psk>" },
    { "name": "backup", "psk": "<other-psk>" }
  ]
}
```

Multiple exits: the client discovers every exit's offer, opens SOCKS streams round-robin across
them, and fails over to a healthy exit automatically (dead exits get a 30 s cooldown).

Windows autostart (scheduled task at logon):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-client-windows.ps1 -ConfigPath .\magnetgate.config.json
```
Linux autostart: `scripts/magnetgate-client.service` (systemd unit template).

## System-wide VPN mode (Windows)

The SOCKS5 client is the data plane; to route **all system traffic** through it (a real VPN),
[ tun2proxy ](https://github.com/tun2proxy/tun2proxy) creates a TUN adapter and feeds everything
into `127.0.0.1:1080` (DNS included, resolved at the exit):

```powershell
# from an elevated PowerShell
powershell -ExecutionPolicy Bypass -File scripts\vpn-windows.ps1            # connect (downloads tun2proxy on first run)
powershell -ExecutionPolicy Bypass -File scripts\vpn-windows.ps1 -Off       # disconnect
```

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
```

`magnetgate-deploy.timer` runs `scripts/deploy.sh` every 3 minutes: fetch → hard reset to
`origin/main` → `npm ci` (only when the lockfile changed) → copy changed systemd units → restart
services. The exit and DHT run as the unprivileged `magnetgate` user under a systemd sandbox
(`NoNewPrivileges`, `ProtectSystem=strict`, dropped capabilities). Create `/opt/magnetgate/.deploy-verify`
to make the deploy require a signed commit (`git verify-commit`) before running new code as root.
The public repo requires no credentials; if it ever goes private, add a read-only deploy key.
Manual trigger: `systemctl start magnetgate-deploy.service`.

## Documentation

Design notes, the implementation spec, the testing methodology and the research survey live in
the internal `docs/` directory, which is deliberately kept out of the public repository.
The tracked test report: [tests/results.md](tests/results.md).
Commit conventions: [CONTRIBUTING.md](CONTRIBUTING.md) (Conventional Commits, English-only,
enforced by a `commit-msg` hook).

## Status and limitations

M1–M9 are implemented and tested (see `tests/results.md`): BEP 44 rendezvous, SOCKS5 with remote
DNS, split tunneling, multiplexed sessions (one persistent session carries all streams, with
keep-alive), UDP ASSOCIATE relaying and a system-wide VPN mode.

Rendezvous runs over **two independent channels** (the Mainline DHT and a Nostr relay pool), so
discovery survives either being blocked. The offer advertises a list of data-plane endpoints; the
client prefers **Reality (VLESS+Reality) and hysteria2** (run via a bundled sing-box —
`scripts/get-singbox.ps1`) and **falls back to the native forward-secret channel** (ephemeral X25519
authenticated under the PSK, with replay protection). The exit runs unprivileged under a systemd
sandbox, blocks egress to loopback/link-local/RFC1918 (SSRF guard) and caps concurrent
sessions/streams. Unit tests: `npm test`.

Note: obfuscation is at PoC level — the data channel is only partially camouflaged as the
BitTorrent family; the DHT platform sees put/get participants' IPs like any ordinary BT node, and
the rendezvous target is derived from the PSK (anyone who holds — or brute-forces a weak — PSK can
locate the exit). Use a ≥128-bit random PSK. Use at your own risk and within the laws of your
jurisdiction.

## Disclaimer

This software is provided for research and educational purposes, "as is", without warranty of
any kind (see [LICENSE](LICENSE)). The authors are not affiliated with any platform or service,
do not provide legal advice, and do not encourage the violation of any laws. You are solely
responsible for complying with the laws of your jurisdiction — including, where applicable,
restrictions on the use and promotion of circumvention tools. Do not use this software for
unlawful purposes or to harm others. The authors assume no liability for any misuse by third
parties.

## License

MIT — see [LICENSE](LICENSE).
