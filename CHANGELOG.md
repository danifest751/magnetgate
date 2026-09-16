# Changelog

## Unreleased

### Multi-node slots (unreleased)

Phase 0 of `docs/design-multi-node.md` (internal): two exits can share one PSK and a client finds both,
so losing one of them no longer takes the service down.

- `MAGNETGATE_NODE_SLOT` / `MAGNETGATE_NODE_NAME` (exit) and `MAGNETGATE_SLOTS` / `slots` (client).
  **Slot 0 is by definition today's single-node derivation**, so nothing changes for an existing
  deployment and an older client keeps working against a node on slot 0.
- Each slot gets its own salt, target and box key; the offer carries `slot`/`node` as optional fields
  (schema stays v3, so old clients ignore them), and a client only accepts the record for the slot it
  asked about. The per-slot box key means one node cannot forge another node's offer.
- Verified by `scripts/dev/multi-node-lab.mjs`: a hermetic loopback lab (local DHT, local target,
  loopback SOCKS) that asserts one PSK discovers both nodes and that a request still succeeds after
  the node that served it is killed.
- The desktop needs no change: a `slots` entry in its config yields one outbound per node **per
  Reality/hysteria2 plane**, and the existing `urltest` group fails over between them. The native
  `mgt` plane is reached through one shared SOCKS outbound (the child picks the node per connection),
  so a node that offers only the native channel falls back to that shared path rather than getting an
  outbound of its own.

Phase 1 — nodes find each other (2026-09-16). Adding or replacing a node no longer means editing
every client:

- `MAGNETGATE_PEER_SLOTS` (exit, opt-in so an idle single node adds no DHT lookups) makes a node scan
  the other slots and list the live ones as `peers` in its offer; `MAGNETGATE_EXPECT_PEERS` turns a
  missing node into an explicit `[alert]`. `peers`/`peersSeen` also appear in the health file.
- A client that knows one slot adds the rest from `peers` by itself and logs each addition
  (`MAGNETGATE_SLOT_DISCOVERY=0` disables that, since a node holding the PSK can advertise any slot).
- The slow DHT poll is 30 s instead of 10 s: the exit republishes once a minute, so the tighter poll
  was pure load and visibility.
- `OFFER_SCHEMA` in `src/common.mjs` is now the single definition of the offer version; a drift test
  fails if either end hardcodes it again.
- Verified on two real nodes (slot 0 and slot 1, one PSK): each advertises the other as `peers`, a
  client configured with only slot 0 discovers slot 1 and serves traffic through either node.

Phase 1 fixes found by running it for real (2026-09-16):

- **Each slot needs its own Nostr `d` tag.** It was derived from the PSK alone while a kind-30078
  event is replaceable per `(kind, pubkey, d)`, so two nodes overwrote each other and only the last
  publisher was visible — the other node lost its hysteria2 endpoint (which travels only on Nostr,
  because the pinned cert does not fit the ~1000 B DHT record) and, with it, was invisible to a client
  that discovered it through `peers`. Slot 0 keeps the old tag.
- A slot discovered through `peers` now gets a Nostr subscription as well; before, it stayed DHT-only.
- Second node brought up with the full data plane (Reality + hysteria2 + native, all verified from a
  client) and with rotation held on both nodes, as on the first one.

Credential rotation, exercised for the first time (2026-09-16):

- `setup-singbox.sh` now generates the hysteria2 key and cert into a temp directory and moves them
  into place back to back, then reloads sing-box explicitly: replacing one before the other is what
  produced the observed `reload certificate: ... private key does not match public key`, after which
  sing-box silently keeps the previous pair.
- `rotate-dp.mjs` documents the supported manual path and what to check afterwards. Rotation was run
  on both live nodes: the config carries `[new, previous]`, the advertised record carries only the new
  generation, sing-box restarts and both 443 listeners come back, and signalling (exit + DHT
  publication) is not interrupted. The grace window was verified by connecting with real credentials:
  current and previous work, one generation older does not. A normal client picks the new credentials
  up from the offer within one poll interval.
### 0.11.1 / Desktop 0.3.3 — audit follow-up (2026-09-16)

Security and operations hardening from a full repository audit. No wire-protocol change: the sealed
offer schema (v3) and the native envelope/frame version (v4) are untouched, so existing clients and
exits stay compatible.

**Published artefacts (a public repository is public forever)**
- Purged `tests/results.md` / `tests/results.ru.md` from the working tree **and from every commit**
  (74 commits rewritten, tree otherwise unchanged) and redacted the exit/uplink addresses that also
  appeared in two older file versions. Those addresses must be treated as compromised and rotated.
- Hygiene gate: `scripts/check-hygiene.mjs` rejects private keys, tokens, field reports and any
  public IPv4 literal that is not a documentation/private range; it runs from `.githooks/pre-commit`,
  the `commit-msg` guard covers the known secret file names, and `tests/results*.md` is ignored.
- `tests/consistency.test.mjs` guards the constants documentation has already drifted on
  (envelope/handshake/frame versions, offer schema, freshness window vs publish interval, Node floor).

**Supply chain**
- `scripts/pins.json` is the single source of truth for every downloaded or bundled artefact
  (sing-box zip+exe, both re:filter rule-sets, wintun zip+dll, tun2proxy, tunnel-userlist) and all
  three fetch scripts read it. The rule-sets came from a `latest` URL with **no** checksum, so an
  upstream change could silently retune routing; that now stops the fetch instead.
- The desktop build bundles an explicit file allowlist instead of `*.srs`, so a stray rule-set cannot
  reach the package (a leftover inside-russia list once added a hidden direct bypass); the unused
  `itdoginfo-inside-russia.*` files are removed.
- `update-rules.mjs` follows redirects, requires HTTP 200, refuses an empty result and writes
  atomically.

**Credentials on disk**
- The client child's runtime config (every PSK) is deleted as soon as the child exits and swept at
  startup, together with engine `*.candidate` / `*.tmp` leftovers.
- The CLI sweeps `magnetgate-dp-*.json` engine configs whose owning pid is gone, and removes its own
  file on exit.

**Privacy**
- Destination host names are no longer logged: an 8-hex fingerprint is written instead, and
  `MAGNETGATE_LOG_TARGETS=1` restores host names for diagnosis. The generated scheduled-task runner
  logs to `%LOCALAPPDATA%\magnetgate`, not into the repository.
- Diagnostics gains a "clear the log" action and a "data plane" row (reality / hysteria2 / native),
  so an unnoticed fall back to the native channel becomes visible.

**Availability**
- The exit evicts reliable-UDP streams idle for `MAGNETGATE_UDP_IDLE_MS` (default 10 min); a peer
  that simply vanished used to hold its slot forever, and 512 of them locked out every new client.
- The exit writes a publication heartbeat (`MAGNETGATE_HEALTH_FILE`) and logs an `[alert]` after
  `MAGNETGATE_ALERT_AFTER` consecutive publications that reached no DHT node;
  `scripts/healthcheck.mjs` with `magnetgate-health.{service,timer}` surfaces it to systemd.
- The client polls fast (3 s) only until an offer is known and then backs off to 10 s; a SOCKS request
  waiting on discovery fails after 5 s with an actionable error instead of stalling for 20 s, and UDP
  associations fail over across exits.
- `frame2` checks its limit against the real overhead after padding instead of a flat 8 KiB margin
  (hardening: the old margin was already conservative, but the bound is now exact and tested).

**Testing**: 50 core tests and 47 desktop tests pass; `npm audit` reports 0 in both trees.

### 0.11.2 — log analysis follow-up (2026-09-16)

Five days of logs showed that the tunnel was fine; what was pushed through it was not, and the log
could not say so.

- **Named processes can bypass the tunnel** (`directProcesses`, validated and emitted as a
  `process_name` rule, with a field in Settings). The exit had relayed BitTorrent: 2 144 142 sing-box
  ERRORS in 5 days, ~881 619 failed peer dials per day, destination ports 51413/6881 — the classic way
  to get a VPS suspended. The desktop config now excludes `qbittorrent.exe`.
- **Repetitive connection errors are collapsed** into a summary every 5 minutes or 1000 lines
  (`MAGNETGATE_PERSIST_NOISE=1` keeps them all). The desktop log held only ~3 hours because ~20k such
  lines per 1.5 h rotated it away; a three-day history did not exist.
- The rendezvous line now lists the planes the offer advertises instead of always claiming `via mgt`
  (the child runs with `MAGNETGATE_NATIVE_ONLY=1`, so its own preference is not the tunnel's).
- Server side (operator record in `manual-release.txt`): journald capped at 200 MB (was unbounded,
  1.3 GB), the release-directory indirection removed so the exit and rotation run from the same
  checkout as the DHT node and the scripts, `magnetgate-health.timer` enabled, 0.11.1 deployed.
  The sing-box data plane was not restarted.

### Desktop 0.3.2 — remove hidden Full bypasses

- Stop loading the bundled inside-russia domain list as direct exceptions in Full. It contains
  kilo.ai and kilocode.ai, so an empty user exception list could still send those sites directly.
  Full now uses only explicit user website exceptions; transport and private-network rules remain.
- Clarify the independent site-list descriptions. Add a regression with a leftover bundled file
  and real sing-box checks for app.kilo.ai/kilocode.ai before and after a Full/Split round trip.
- Remove the same implicit list from the legacy launcher and default downloads; an explicitly
  supplied legacy DirectListPath remains supported.
- Reproduce the old behavior as direct routing in a loopback fixture before applying the fix.
  Health-check egress alone does not prove the route taken by every website.

### Desktop 0.3.1 — reopening and process exit

- Repeated launches restore/focus the existing window, or recreate it if missing, instead of
  silently discarding the request. A duplicate process exits without touching the primary VPN.
- After owned-process cleanup and log flushing succeed, exit directly instead of re-entering
  the cancellable window-close lifecycle. Failed cleanup keeps the recovery window available.
- Add regressions for repeated launches, missing windows, duplicate instances and exit ordering.

### Desktop 0.3.0 — focused desktop interface

- Separate Russian-language Connection, Sites, Settings and Diagnostics screens, with system
  light/dark themes and a resizable layout. Show actual connection health and applied routing mode.
- Edit direct and tunnel lists independently. Serialize automatic rule saves; keep unsaved server
  keys and advanced fields separate until explicit Save, including edits made during a pending save.
- Preserve disconnect/firewall recovery even when configuration loading fails. Other-VPN detection
  offers Retry. Keep technical errors and bounded logs available without exposing keys in the UI.
- Retain the existing engine and in-place Full/Split switching. Browser regression coverage uses
  fixture IPC only; real elevated desktop connection tests remain a manual verification step.

### Desktop 0.2.2 — Full/Split switching without TUN recreation

- With the firewall option disabled, load both routing policies and switch the owned engine's
  authenticated Clash mode in place. Confirm the applied mode and close old flows before reporting
  success. Full direct exceptions and Split tunnel lists keep their separate priorities.
- Bound and cancel control requests, retain visible pending state on partial failure, and retry
  without silently restarting TUN. Strict firewall and other configuration changes retain restart.
- Probe the applied policy immediately and discard stale health after mode changes or engine exit.
  Log mode, PID and duration. Windows loopback integration verifies real routing/connection cleanup
  without a TUN; user verification of system-wide switching is still required.

### Desktop 0.2.1 — Windows TUN startup recovery

- After a field test found a stalled adapter and a create/open-existing adapter conflict, use a
  fresh TUN name for each engine attempt. Strict firewall rules follow the owned adapter name.
- Wait for authenticated control and local SOCKS readiness with a cancellable 30-second deadline;
  spawning the process no longer counts as startup success. Egress health is checked afterward.
- Wait for actual owned-process exit even when taskkill reports an error. Failed Disconnect stays
  available for retry, and failed shutdown keeps the app open while still attempting client cleanup.
- Rotate sing-box warnings with the application log and record startup PID, adapter and health.
  Unit/config validation passes; repeat elevated desktop testing remains necessary.

### 0.11.0 / desktop 0.2.0 — stability and security remediation

- **Breaking wire change:** v4 session metadata/counters are authenticated; replay closes the
  session. Random-nonce discovery envelopes also require clients and exit to upgrade together.
- Normalize IPv4/IPv6 and validate resolved TCP/UDP destinations. Bound pre-auth time, session,
  stream, datagram and write queues. Preserve SOCKS early data and TCP half-close responses.
- Reuse UDP associations, try all configured transports/exits, retain endpoint generations for
  active CLI streams and retry failed sing-box starts. Nostr publishes independently of DHT
  readiness and resends queued offers after relay reconnect.
- Persist sequences before publication; use kernel locks for server publisher/rotation. Validate
  rotation candidates and listener readiness before advertising, recover forward after publication.
  Autodeploy validates a candidate, checks each service and preserves backups on failed rollback.
- Desktop serializes lifecycle changes, retains owned children on stop failures, refreshes
  discovery credentials and rejects expired endpoints. Native fallback and multiple exits are
  available to its shared sing-box configuration. Health uses HTTPS system and forced-proxy probes.
- Optional strict Full firewall policy persists until explicit Disconnect. It is off by default;
  elevated Windows crash/leak/restore field tests remain outstanding. Legacy launchers no longer
  claim a persistent kill-switch or stop unrelated binaries by name.
- Electron 44.3.0 and electron-builder 26.15.3; distribution defaults to an empty valid config.
  Only binaries and `.srs` files are copied from the local sing-box directory, excluding credentials.

### Validation of core 0.11.0 and desktop 0.3.1

- Pass 37 core tests, 46 desktop tests and 54 fixture-IPC browser checks. Core tests exercise
  actual TCP/UDP loopback, handshake tampering/replay, half-close and recovery. Desktop tests
  include real loopback-only sing-box mode changes on the same process, without a system TUN.
- Build the Windows portable app and verify packaged source files, empty default seed and the
  resource allowlist. Dependency audits report no known vulnerabilities at verification time.
- Elevated firewall crash/leak/restoration tests and manual reopening/connection testing of
  desktop 0.3.1 remain outstanding; browser and loopback checks do not establish those outcomes.

### Earlier development notes (historical behavior; superseded where changed above)
- **Reworked the system-VPN plumbing (elevated app, no consoles).** The app now runs elevated
  (requireAdministrator — one UAC at launch) and manages the sing-box TUN directly as a hidden
  child process, with the config generated in-process: no per-toggle UAC, no PowerShell console
  windows, instant clean start/stop, sing-box output captured into the in-app log. Fixes the
  flickering/lingering consoles and the start-on-2nd-try glitches. Full mode no longer force-
  directs a built-in RU list (Full = everything via the exit; use Split for RU-direct).
- **Two routing modes (Full VPN / Split).** Split mode inverts the model: direct by default,
  only the blocked/geo-restricted list routed through the exit (bundled re:filter RKN blocklists
  + the operator tunnel_manager IP list + user domains), so all RU-domestic sites work on the real
  IP with no RU-direct list to maintain. Full mode keeps everything via the exit with a direct
  exception list. UI has a Full/Split toggle and a mode-aware routing list; the launcher gained a
  -DryRun preflight that generates+validates the config without admin/TUN.
- **Split tunnel for RU domestic resources.** RU sites that reject datacenter/VPN IPs (Gosuslugi,
  MAX, banks) now go DIRECT on the real residential IP while everything else stays on magnetgate.
  Base list = the community `itdoginfo-inside-russia` sing-box rule-set, bundled as a local .srs
  (fetched by get-singbox.ps1); a built-in curated set of ~60 well-known VPN-rejecting RU resources (Ozon, WB, Avito, banks, Gosuslugi/gov, telecom, cinemas, VK/MAX) is applied by default, and the app UI lets you add/remove your own domains;
  direct-list domains also resolve via a RU resolver so the geo-answer is local. Server-published
  overlay is the next step. See docs/ru-direct-list-research.md.
- **App: WG/tunnel-aware system VPN + live stats.** The VPN toggle is gated while any other full
  tunnel is up (WireGuard/OpenVPN/TAP/Wintun/commercial VPNs, detected by adapter description or
  a default-route-with-on-link-nexthop), auto-stops if one appears, and auto-recovers when the
  conflicting tunnel goes away. The TUN sing-box exposes a loopback Clash API; the app shows live
  down/up speed, connection count and totals. Config editor collapsed into an Advanced section.
- **sing-box TUN VPN field-validated.** With WireGuard off, the app's system VPN brings up the
  `magnetgate` TUN and routes all traffic through it: system egress becomes the exit IP, exit
  connections go direct (bypass works, no loop), real traffic flows over Reality to the exit. Note:
  it will not come up alongside an active WireGuard full tunnel (both use Wintun) — turn the other
  full tunnel off first.
- **App is self-contained + logs to disk.** The client runs on Electron's own Node (no system Node
  needed; `sodium-native` N-API is ABI-stable), the config is seeded on first run so testing needs no
  PSK entry (the built exe then holds the PSK — keep it private), and everything is written to
  `%APPDATA%/magnetgate/logs/` (`magnetgate.log`, and `vpn.log`/`vpn-launcher.log` for the TUN) so a
  field test can be read back.
- **Desktop app (Electron, MVP).** `app/` wraps the client in a GUI: start/stop the client, a
  system-VPN toggle (elevates the sing-box TUN launcher on demand), live status (route + egress IP)
  and log, plus config/PSK management (exits, PSK generate, ports, bootstrap) stored in userData so
  PSKs are never committed. Runs the existing client as a system-node child (no native-module ABI
  fight); `electron-builder` packages a portable .exe. See [app/README.md](app/README.md).
- **sing-box TUN launcher (Phase 3, in progress).** `scripts/vpn-singbox-windows.ps1` brings the
  system-wide VPN up on sing-box's own TUN inbound instead of tun2proxy: TUN -> the magnetgate SOCKS
  client (so reality>hy2>native fail-over and rendezvous stay in the client), with a fail-closed
  kill-switch (`route.final = proxy` + `strict_route`), IPv6-leak block (v6 rejected), and DNS routed
  through the tunnel via DoH. Same `-Off`/`-Bypass` interface as `vpn-windows.ps1`; the generated
  config is validated with `sing-box check` before the network is touched. Offline-validated only —
  the elevated field bring-up (with any other full tunnel off) and pinning the wintun.dll hash are
  still pending.

## 0.10.0 — 2026-09-12
- **hysteria2 cert-pinning (Track 3, Phase 3).** The exit now publishes two same-generation views of
  the offer: the DHT offer stays compact and omits hy2 (its self-signed cert does not fit the
  ~1000 B BEP44 limit), while the Nostr offer is a superset carrying the pinned hy2 endpoint with the
  server cert (`dp.ca`) and its SAN hostname (`dp.sni`). `insecure` TLS is gone — Reality and hy2 are
  now both fully server-authenticated.
- The two offers are sealed under **disjoint nonces** (`seq` for the DHT, `'n'+seq` for Nostr) so the
  differing plaintexts never reuse a nonce. The client merges same-generation offers from both
  channels by data-plane type (`src/offer.mjs`), so the DHT poll no longer clobbers the hy2 entry
  that only the Nostr channel carries.
- The hy2 self-signed cert now carries a `subjectAltName` so Go's TLS verifier (which ignores the
  legacy CN) accepts it under `server_name=magnetgate`; `rotate-dp.mjs` writes the cert into the dp
  file each rotation, `setup-singbox.sh` generates it with the SAN on fresh installs.
- Also fixed a duplicate Nostr publish (the offer was sent to the relay pool twice per cycle).
- Verified in prod: a standalone sing-box built from the advertised pinned hy2 endpoint (cert
  validated, no `insecure`) egresses through the exit with HTTPS 200; Reality stays the primary path.
- Tests: 20/20 (added nonce-separation, `pickDp`, and `mergeOffer` merge/replace/ignore cases).

## 0.9.0 — 2026-09-12
- **Credential rotation with a grace window (Track 3, phase 2).** `scripts/rotate-dp.mjs` (a systemd
  timer, daily) rotates the Reality shortId+uuid and the hysteria2 password while keeping the
  previous generation valid for one interval (grace); the stable Reality keypair, hy2 obfs and TLS
  cert are preserved so a client's pinned key stays valid.
- The exit watches the dp file and republishes within ~1s of a rotation, so clients pick up the new
  credentials in seconds instead of the 5-minute cycle. The client's supervisor switches sing-box to
  the new params cleanly (restarts serialized to avoid a SOCKS-port race) and falls back to the
  native channel during any gap.
- Verified in prod: rotation → exit republishes → client switches to the new generation with no race
  and no downtime (HTTPS 200 throughout); the grace window keeps the previous generation working.

## 0.8.0 — 2026-09-12
- **Reality + hysteria2 data planes (Track 3, phase 1).** The exit runs sing-box with VLESS+Reality
  (TCP/443, borrowed SNI) and hysteria2 (UDP/443) inbounds and advertises both in the offer `dp`
  list (from `/etc/magnetgate-dp.json`). The client runs a bundled sing-box
  (`src/dp-supervisor.mjs`) as the data-plane engine — templating a client config from the chosen
  endpoint, exposing a local SOCKS — and `routeFn` dials proxied connections through it, preferring
  reality > hysteria2 and **falling back to the native `mgt` tunnel** on failure.
  `MAGNETGATE_DATA_PLANE=mgt` forces the native channel; `scripts/get-singbox.ps1` fetches sing-box
  (pinned SHA-256); `tools/` is gitignored.
- magnetgate is now the rendezvous + data-plane-selection control plane around sing-box; the exit,
  the DHT/Nostr rendezvous and the native channel are unchanged (still the fallback).
- Known limitation: hysteria2 currently uses `insecure` TLS (traffic is encrypted and the client is
  authed via password + salamander obfs, but the self-signed server cert is not validated) to keep
  the offer within the DHT 1000-byte limit; Reality is fully authenticated. Hardening hy2 server-auth
  (ship the cert via the size-unbounded Nostr offer) is a follow-up.
- Verified in prod: client → Reality → exit (egress = exit IP, HTTPS 200); hysteria2 likewise;
  forced-native fallback (`-> mgt`) works.

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
- Tests: M1–M4 pass; HTTPS to a blocked resource through the tunnel — 200. (Field test reports are kept
  internal, outside the repository.)
- Documentation is now English-primary with Russian versions in `docs/ru/` and `README.ru.md`.

## 0.1.0 — 2026-09-11
- First PoC (oflx-poc): BEP 44 signaling + a TCP data channel + a fixed-target forwarder.
  The local loop and the public DHT verified.
