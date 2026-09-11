# Changelog

## 0.7.0 — 2026-09-12
- **Offer schema v3 + a second rendezvous channel (Nostr).** The rendezvous offer is now an
  extensible list of data-plane endpoints (`{v:3, ts, dp:[{t:'mgt',host,port,udp?}, …]}`), so the
  client can be handed several data planes and fail over between them; the native channel is
  `t:'mgt'` (Reality/hysteria2 land in a later phase — Track 3).
- The same sealed offer is now published to **both** the Mainline DHT and a pool of **Nostr relays**
  (kind 30078 parameterized-replaceable, secp256k1/BIP-340 identity derived from the PSK). Discovery
  no longer depends on the DHT alone — closing the single point of failure before it becomes the
  linchpin of the daily driver. Confidentiality/authenticity stay in the secretbox seal under boxKey;
  the Nostr signature only satisfies relays and gives a stable author key to filter by.
- Client and exit must be upgraded together (offer v3 is incompatible with v2).
- New deps: `ws`, `@noble/curves`. New env: `MAGNETGATE_NOSTR=off` (disable), `MAGNETGATE_NOSTR_RELAYS`
  (override the relay pool).
- Verified: 16/16 unit tests; a live Nostr publish→subscribe against public relays; the loopback
  tunnel over the v3 DHT offer.

## 0.6.0 — 2026-09-12
- **Security audit remediation.** Data protocol bumped to **v3** — client and exit must be
  upgraded together (v3 is incompatible with v2).
- **fix(proto): DATA-frame padding corruption** — the pad length was written into a single byte,
  but padding to the 512/1024/2048/4096 buckets exceeds 255, so it wrapped mod 256 and the receiver
  stripped the wrong offset, corrupting every DATA frame ≥512 B. A TLS ClientHello (~517 B) always
  landed in the first bad range, which broke **all HTTPS through the tunnel** while small HTTP
  survived. Pad length is now a 2-byte prefix.
- **feat(proto): forward-secret session handshake** — the static PSK-derived session keys are
  replaced by an ephemeral X25519 exchange authenticated and encrypted under the PSK; session keys
  are `BLAKE2b-512(dh ‖ cePk ‖ eePk ‖ boxKey)`. A later PSK compromise no longer decrypts past
  recorded traffic (forward secrecy). The handshake carries a timestamp and the exit keeps a TTL
  cache of client ephemeral keys, so stale or replayed openings are rejected.
- **Hardening:** exit and DHT run as an unprivileged `magnetgate` user under a systemd sandbox; the
  PSK is read from the environment (no longer on the argv/`ps` line); the exit blocks egress to
  loopback / link-local (169.254.169.254 metadata) / RFC1918 (SSRF guard, `MAGNETGATE_ALLOW_PRIVATE=1`
  to opt out) and caps concurrent sessions/streams; a malformed OPEN frame can no longer crash it.
- **fix(client): SOCKS5 binds to `127.0.0.1`** (was `0.0.0.0` — an open no-auth LAN proxy);
  override with `MAGNETGATE_SOCKS_HOST`.
- **fix(dht): IPv4 bootstrap** — lead the bootstrap list with `router.bittorrent.com`; the other
  public nodes resolve to IPv6-only on some hosts and bittorrent-dht is udp4, which caused
  "No nodes to query". The exit also bootstraps off its own self-hosted node
  (`DHT_BOOTSTRAP=127.0.0.1:20001,...`).
- **fix(udp):** scoped the retransmit `seq` reference (crashed under `MAGNETGATE_DEBUG`), gated
  debug logs behind the flag, and prune closed reliable-UDP streams (leak).
- **Supply chain:** deploy uses `npm ci` (reproducible) and can require a signed commit
  (`/opt/magnetgate/.deploy-verify`); `vpn-windows.ps1` verifies the tun2proxy download against a
  pinned SHA-256.
- Advisory weak-PSK warning at startup. Unit tests added (`npm test`, node:test).

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
