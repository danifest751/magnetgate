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

All keys are derived deterministically from the PSK (`mgt-sig:` / `mgt-salt:` / `mgt-box:`), so no
domains, certificates, trackers or brokers are required. Payload travels as secretbox frames with
per-connection keys.

## Quick start

**Exit (a VPS with a public IPv4):**
```bash
npm install
MAGNETGATE_SEQ_FILE=/var/lib/magnetgate/seq node src/exit.js "<psk>" 49001 <PUBLIC_IP>
```
(production: systemd units in `systemd/`)

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
| `DHT_BOOTSTRAP` | CSV list of bootstrap nodes; defaults to public ones. A self-hosted node on your VPS is recommended |
| `MAGNETGATE_SEQ_FILE` | persistence for `seq` (mandatory on the exit: restarts must increment it) |
| `MAGNETGATE_RULES` | split-tunnel rules file |

## Deployment (pull-based autodeploy)

The VPS pulls `main` from GitHub by itself (no GitHub Actions, no open webhook port):

```bash
# one-time bootstrap on the VPS (repo root == /opt/magnetgate)
git init && git remote add origin https://github.com/danifest751/magnetgate.git
git fetch origin && git checkout -f -B main origin/main
cp systemd/*.service systemd/*.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now magnetgate-exit magnetgate-dht magnetgate-deploy.timer
```

`magnetgate-deploy.timer` runs `scripts/deploy.sh` every 3 minutes: fetch → hard reset to
`origin/main` → `npm install` (only when the lockfile changed) → copy changed systemd units →
restart services. The public repo requires no credentials; if it ever goes private, add a
read-only deploy key. Manual trigger: `systemctl start magnetgate-deploy.service`.

## Documentation

Design notes, the implementation spec, the testing methodology and the research survey live in
the internal `docs/` directory, which is deliberately kept out of the public repository.
The tracked test report: [tests/results.md](tests/results.md).
Commit conventions: [CONTRIBUTING.md](CONTRIBUTING.md) (Conventional Commits, English-only,
enforced by a `commit-msg` hook).

## Status and limitations

M1–M4 are implemented and tested (see `tests/results.md`). Next: uTP/KCP data plane, stream
multiplexing, client service-ization, multi-exit patching.

Note: obfuscation is at PoC level — the data channel is only partially camouflaged as the
BitTorrent family; the DHT platform sees put/get participants' IPs like any ordinary BT node.
Use at your own risk and within the laws of your jurisdiction.

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
