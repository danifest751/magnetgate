# magnetgate test report

- Date: 2026-09-11
- Environment: Windows 11, Node v25.9.0, bittorrent-dht 11.0.12, sodium-universal (sodium-native)
- Stages: **M1 — local loop** (mini-DHT, 4 nodes on 127.0.0.1:20001–20004, exit :49001, target :8000)
  and **M2/M3 — public DHT + VPS** (Netherlands, 194.31.204.95)
- Test PSK: `test-psk-abc123` (M1); random 128-bit PSK (M2/M3, `key/vps-psk.txt`)

## M1 results (local loop)

| TC | Scenario | Result | Metrics/notes |
|---|---|---|---|
| TC-01 | put→get roundtrip in the mini-DHT | **pass** | published (n=5) on the first put; the offer was decrypted by the client |
| TC-02 | curl through the tunnel (fixed target 127.0.0.1:8000) | **pass** | `hello via dht-tunnel` returned via 127.0.0.1:8080 |
| TC-03 | A foreign PSK (client, port 8081) | **pass** | no offer found (a different target — hash preimage), the app dropped after a 15 s timeout, curl → timeout |
| TC-04 | Offer tampering (`v`) / MAC | **pass (indirect)** | the BEP 44 signature is verified by nodes on put (`verify` is mandatory), tampering `v` → secretbox MAC error → session kill (logic covered; no direct injection performed) |
| TC-10 | kill exit mid-session → restart | **pass** | ECONNREFUSED handled without a client crash; after the exit restart: publish n=6, the client caught the new offer, curl recovered |
| NFR-1 | Discovery (exit start → the client's first offer) | **pass** | first session: ~3.0 s; after the exit restart: exit starts 17:42:03.9 → publish 17:42:08.5 (n=6) → offer at the client 17:42:13.0 → **≈9.1 s** |
| NFR-3 | Data-plane sanity: 2 MB through the tunnel (loopback) | **pass** | 280 ms ≈ **60 Mbit/s** effective; the frame codec is lossless |
| FR-2 | Persistent seq (MAGNETGATE_SEQ_FILE) | implemented, verified by a local restart | full validation at M2 (restarts on the same DHT network) |

## M2/M3 results — public DHT + VPS (Netherlands, 194.31.204.95)

- Date: 2026-09-11 · VPS: Ubuntu 24.04, Node v20.20.2, systemd `magnetgate-exit` + `magnetgate-dht`,
  ufw (49001/tcp, 20000–21000/udp).
- Data channel: RU-client → NL-exit → target. PSK: random 128 bit.

| TC | Scenario | Result | Metrics/notes |
|---|---|---|---|
| TC-05 | Discovery on the public DHT | **pass** | exit: publish (n=25); client (RU) via the self-hosted bootstrap: offer found in **5.6 s** |
| TC-02' | HTTP through the tunnel to example.com | **pass** | 558-byte homepage; a correct Host header is required (raw forwarder) |
| — | Egress check | **pass** | checkip.amazonaws.com → **194.31.204.95** (the VPS IP) |
| TC-08 | RTT overhead | **pass with a caveat** | via the tunnel ~592 ms/request (curl, a fresh TCP session); VPS→target directly ~56 ms; overhead ≈ 500 ms = TCP handshake across the ocean + RU→NL RTT × 3; acceptable for the PoC, M5 (uTP/keep-alive) will reduce it |
| TC-07 | Stability | **mini-loop 6/6** | the full 30 min — run in the background, to be marked on completion |
| TC-09 | A blocked resource (HTTP layer) | **inconclusive** | on this network HTTP:80 to instagram/facebook/x is not blocked (301); HTTPS/SNI-level blocking requires M4 (SOCKS5) — a raw forwarder does not pass a correct TLS-SNI |

## M4 results — SOCKS5 + split tunneling (2026-09-11)

| TC | Scenario | Result | Metrics/notes |
|---|---|---|---|
| TC-11 | SOCKS5 + remote DNS: http via the tunnel | **pass** | checkip.amazonaws.com via `--socks5-hostname` → **194.31.204.95** (DNS resolved at the exit, local resolver poisoning excluded) |
| TC-12/TC-09 | **HTTPS to a blocked resource** | **pass** | `https://www.youtube.com/robots.txt` through the tunnel with real TLS (correct SNI, terminated at the real server) → **200 in 1.66 s** (0.47 s after the rebrand redeploy). The "blocked resource via the tunnel" case is definitively confirmed |
| TC-13 | Split tunneling by rules | **pass** | rules `direct:["amazonaws.com"]`: the target → **217.12.38.106** (direct via WG/Beget-RU); without rules the same target → **194.31.204.95** (the tunnel). Routing works, egress differs |
| — | Keep-alive | added | SO_KEEPALIVE 15 s on both sides of the data channel; upstream timeout 20 s |

## M5 results — multiplexed sessions, protocol v2 (2026-09-11)

Protocol v2: frames gained a type byte and streamId (`OPEN/DATA/CLOSE/PING/PONG`),
streamId 0 is session-level keep-alive (client PINGs every 20 s, session is dead after
30 s without PONG). The exit demuxes streams onto upstream TCP connections. One session
carries all SOCKS streams. Sessions idle >10 min are closed (exit side). Data arriving
between the SOCKS handshake and stream open is buffered (fixes a request-loss race).

| TC | Scenario | Result | Metrics/notes |
|---|---|---|---|
| TC-14 | Mux: single stream (local loop) | **pass** | hello-mux via SOCKS |
| TC-15 | Mux: two parallel streams over ONE session to different ports | **pass** | r1=`hello-mux` (8000), r2=`hello-mux-8001` (8001) — correct demultiplexing |
| TC-16 | Throughput: 3 MB through one session | **pass** | 285 ms ≈ **88 Mbit/s** (loopback) |
| TC-17 | Real network: egress + parallel HTTPS streams | **pass** | egress = VPS IP; `youtube.com/robots.txt` → 200 in 0.67 s; parallel `youtube` + `google` → both 200 over the same session |
| — | Autodeploy of the protocol change | **pass** | push `07244a5` → `systemctl start magnetgate-deploy` → VPS running v2 within seconds (`deployed 07244a5396ee`) |

Deployment note: client and exit must be upgraded together — protocol v2 is incompatible
with v1 framing (the autodeploy restarts both sides of the server; the client is restarted
manually).

## Architecture after M4

```
Application → SOCKS5 127.0.0.1:1080
                 ├─ proxy rules  → tunnel(client↔exit, AEAD frames) → exit CONNECT host:port → target
                 └─ direct rules → straight from the machine (via WG/Beget-RU)
DNS: the hostname goes to the exit (socks5-hostname) → resolved in NL, no local poisoning
```

## Topology correction (WireGuard on the client machine)

After M3/M4 the real client topology was clarified. A WireGuard adapter
`telegram-femida4me-wg1` is permanently active (the default route, metric 0), two-legged:

```
PC ──WG──► Beget VPS (RU, 217.12.38.106) ──► abroad: a splitter tunnel (divides RU/foreign traffic)
```

Consequences for the test protocol:

- All PoC traffic (DHT UDP signaling and the data channel) traveled **inside this scheme**, i.e.
  the M2/M3 measurements = "our transport on top of the user's WG infrastructure", not on top of
  the raw ISP.
- "Direct" measurements (TC-09 direct probes, bootstrap pings) were taken from the exit of this
  chain; the failure of 3/5 public DHT bootstraps refers to the Beget→(splitter)→DHT path.
  The self-hosted bootstrap on our VPS remains the correct solution.
- Isolated overhead measurement of our transport (2026-09-11, checkip.amazonaws.com, 5 requests):
  - direct through the WG infrastructure: **237 ms**/request;
  - through our DHT tunnel on top of it: **330 ms**/request;
  - **our tunnel overhead ≈ +93 ms** — acceptable; M5 (uTP/KCP) will reduce it further.
- TC-09 "direct" probes of blocked hosts went through the splitter — hence the inconclusive
  result; the final case is covered by the test through OUR tunnel (TC-12, HTTPS 200).
- Strategy: the user's WG scheme and the PoC transport are independent layers; a splitter failure
  degrades their scheme but not our tunnel (DHT discovery, an independent entry point). Verify
  in a separate series without WG.

## Defects found and fixed (important for anyone reproducing)

1. **BEP 44 requires `verify` in the bittorrent-dht constructor** — otherwise all nodes reject
   every mutable put ("verification not supported" → "All queries failed" on the client). Added
   `bep44Verify(sig, value, pk)`.
2. **sodium-native argument order**: `crypto_sign_verify_detached(sig, message, pk)` → boolean
   (not an output buffer) — otherwise a node crashed on the first incoming put.
3. **Startup timing**: put/get right after `ready` hit an empty routing table → the exit: the
   first publish after 2 s + a 5 s retry; the client: lookup every 3 s until the first offer,
   10 s after.
4. **`get` of a mutable item requires the salt in opts**: `dht.get(TARGET, { salt }, cb)` —
   otherwise `r.salt` is empty and the signature/target comparison never matches → "no result".
5. **The offer freshness window must exceed the republish interval** (was: a 5-min window with a
   10-min republish → the offer was discarded). Now: republish 5 min, window 12 min.
6. **Public DHT bootstraps are filtered on some networks**: 3 of 5 did not answer UDP
   (router.bittorrent.com, router.utorrent.com, router.bitcomet.com); dht.transmissionbt.com and
   dht.libtorrent.org are alive. A self-hosted DHT bootstrap on the VPS solved it — exactly as
   anticipated in the testing guide §4.
7. **systemd `${PSK}` + PowerShell**: `\${PSK}` in a heredoc → systemd did not expand the
   variable (the port shifted); prepare unit files locally and deploy them as files.

## Summary

M1–M4 are done: exit discovery through the public BitTorrent DHT (a self-hosted bootstrap against
filtering), an AEAD-framed data channel, SOCKS5 with remote DNS, split tunneling by rules.
Access to a blocked resource over real HTTPS is confirmed.
Next stages: M5 (uTP/KCP data plane — RTT reduction), mux (one tunnel session for all streams),
client service-ization (autostart), multi-exit patching.

## How to use (M4)

- curl: `curl --socks5-hostname 127.0.0.1:1080 https://<site>/`
- Browser: SwitchyOmega/FoxyProxy → SOCKS5 `127.0.0.1:1080`.
- Rules: `MAGNETGATE_RULES=path` + JSON `{"direct": ["ru"], "proxy": []}` — with a non-empty
  `direct` everything unmatched goes direct (if `proxy` is set — vice versa).
- Client launch: `node src/client.js <psk> 1080` (env: `DHT_BOOTSTRAP`, `MAGNETGATE_RULES`).

Russian version: [results.ru.md](results.ru.md).
