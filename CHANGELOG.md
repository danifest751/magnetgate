# Changelog

## 0.5.0 — 2026-09-11
- M7: **SOCKS5 UDP ASSOCIATE + UDP relay through the tunnel** — QUIC/DNS/games now work in
  VPN mode. Tunnel UDP payload format: `[atyp][addr][port][data]` in both directions.
- M8: **system-wide VPN mode** — `scripts/vpn-windows.ps1` wires a tun2proxy TUN adapter to the
  client's SOCKS5 port (all system traffic, DNS resolved at the exit).
- Experimental UDP data transport (`MAGNETGATE_TRANSPORT=udp`): a pure-JS reliable ordered
  stream over UDP (ARQ: seq/ack, per-packet RTO with backoff, 64-packet window, HELLO
  handshake). TCP remains the default and the fallback.
- Verified end-to-end: a raw DNS query to 1.1.1.1:53 through the tunnel from a filtered network
  returns a valid answer relayed by the VPS exit.
- Known issue: with a full-tunnel WireGuard in front of the client, the reliable-UDP return
  traffic (exit → client) can be dropped by the WG chain's NAT/splitter — the local path works,
  the TCP fallback covers it.

## 0.4.0 — 2026-09-11
- M6: **multi-exit client with failover** — a config file (`magnetgate.config.json`) lists several
  exits (each with its own PSK); the client discovers every offer, spreads SOCKS streams
  round-robin, and fails over to a healthy exit (dead exits get a 30 s cooldown, recovery is
  automatic).
- Client service-ization: `scripts/install-client-windows.ps1` (scheduled task at logon) and
  `scripts/magnetgate-client.service` (Linux systemd template); user configs with PSKs are
  gitignored (`magnetgate.config.json`).
- Traffic masking: DATA frame sizes are padded and quantized to buckets (64–4096) so wire sizes
  do not reveal the payload shape.
- Optional metrics: `MAGNETGATE_STATS=<seconds>` logs per-exit traffic counters.

## 0.3.0 — 2026-09-11
- M5: **multiplexed sessions (protocol v2)** — one persistent session to the exit carries every
  SOCKS stream. Frames: `[u32 len][u8 type][u32 streamId][nonce][secretbox]` with
  `OPEN/DATA/CLOSE/PING/PONG`; streamId 0 is session-level.
- Keep-alive: client PINGs every 20 s, a session without PONG for 30 s is torn down and
  re-established on the next stream request.
- The exit demultiplexes streams onto upstream TCP connections; sessions idle >10 min are closed.
- Data arriving between the SOCKS handshake and stream open is buffered (fixes a request-loss race).
- Removed the aggressive 20 s upstream idle timeout on the exit.
- Verified on a real network: parallel HTTPS streams (youtube+google) over one session, both 200;
  egress IP = VPS.
- Deployment: client and exit must be upgraded together (protocol v2 is incompatible with v1).

## 0.2.0 — 2026-09-11
- Pull-based autodeploy on the VPS: a systemd timer (`magnetgate-deploy.timer`) runs
  `scripts/deploy.sh` every 3 minutes (fetch → reset → conditional deps → restart).
- Проект переименован в **magnetgate** (ранее oflx-poc); wire-префиксы `oflx-*` → `mgt-*`,
  env `OFLX_*` → `MAGNETGATE_*`.
- M4: SOCKS5 (RFC 1928, no-auth, CONNECT, domains/IPv4) + split tunneling by rules
  (`MAGNETGATE_RULES`), remote DNS at the exit.
- Keep-alive (SO_KEEPALIVE 15 s) on both sides of the data channel; upstream timeout.
- Offer republished every 5 min; the client freshness window is 12 min (> the interval).
- A self-hosted DHT bootstrap on the VPS (public bootstraps are filtered on some networks).
- Persistent `seq` (`MAGNETGATE_SEQ_FILE`) — the BEP 44 CAS requirement across restarts.
- Fixes: `verify` is mandatory for BEP 44 in bittorrent-dht; the sodium-native argument order of
  `crypto_sign_verify_detached`; the salt in `dht.get()` opts.
- Tests: M1–M4 pass (see tests/results.md); HTTPS to a blocked resource through the tunnel — 200.
- Documentation is now English-primary with Russian versions in `docs/ru/` and `README.ru.md`.

## 0.1.0 — 2026-09-11
- First PoC (oflx-poc): BEP 44 signaling + a TCP data channel + a fixed-target forwarder.
  The local loop and the public DHT verified.
