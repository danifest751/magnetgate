# magnetgate — roadmap & future directions

> The longer-horizon plan behind the README "Roadmap" section, especially the **exit overlay
> (entry/egress split)** idea. The transport survey that motivates it is kept in the internal
> `docs/` (out of the public repo). Last updated: 2026-09-16.

## 1. Framing: what magnetgate is (and is not)

magnetgate is a **control plane around off-the-shelf camouflage transports**. Its main contribution
is the **brokerless, multi-channel rendezvous** — how a client finds a working endpoint when the
config-distribution channel itself is a censored target — plus **rotation** and **per-connection
fail-over**. The actual DPI resistance is delivered by Reality / hysteria2 (via sing-box);
magnetgate's native forward-secret channel is the always-available fallback.

Operating model — **three layers, each with ≥2 independent mechanisms and automatic fail-over**:

| Layer | Job | Have | Planned |
|---|---|---|---|
| Rendezvous | find the exit + current endpoints | Mainline DHT + Nostr | DoH/ENS dead-drop (3rd channel) |
| Data plane | move bytes, camouflaged | Reality, hysteria2, native mgt | WebRTC DataChannel; exit overlay (below) |
| Cold fallback | survive a total shutdown | — | email/IMAP store-and-forward; physical (Starlink) |

**Non-goals (deliberate):** this is not Tor/I2P. It targets *unblockability + reasonable metadata
hygiene for a small trusted group*, not strong anonymity against a global adversary. The rendezvous
target is PSK-derived, so it is a private-group tool by construction — popularity (PSK leakage at
scale) is its enemy. Keep that boundary explicit in every design decision below.

## 2. Status (done)

- **Phase 0** — offer schema v3 (`dp` list) + Nostr as a second rendezvous channel (0.7.0).
- **Phase 1** — Reality + hysteria2 data planes via sing-box; client orchestrator + fail-over (0.8.0).
- **Phase 2** — credential rotation with a grace window + ~1 s propagation (0.9.0).
- **Phase 3** — hysteria2 cert-pinning via the superset Nostr offer, dropping `insecure` (0.10.0);
  **sing-box TUN as the system-wide VPN, field-validated** (system egress = exit; needs the other
  full tunnel off, since both use Wintun). Driven by the Electron app (`app/`).
- Plus the security-audit remediation (forward-secret handshake, non-root sandbox, SSRF egress
  filter, SOCKS loopback bind, DHT IPv4 bootstrap, pinned binaries) — see [CHANGELOG.md](CHANGELOG.md).

## 3. Near-term — Phase 3

- ✅ **sing-box TUN as the system-wide VPN (done, field-validated)** — replaces tun2proxy with a
  strict routing while the engine is running, IPv6-leak block and DNS routed
  through the tunnel. `scripts/vpn-singbox-windows.ps1` keeps the TUN → magnetgate SOCKS topology so
  reality>hy2>native fail-over and rendezvous stay in the client; the app passes the exit IP as
  `-Bypass` so the uplink does not loop. Validated in the field: with WireGuard off, system egress
  becomes the exit IP and real traffic flows over Reality. **Constraint:** it will not come up
  alongside another active full tunnel — WireGuard also uses Wintun, and sing-box's TUN hangs opening
  the interface until the other tunnel is off.
- ✅ **hy2 cert-pinning (done, 0.10.0)** — the self-signed server cert now ships via the
  size-unbounded Nostr offer, dropping the `insecure` fallback. Implemented as the compact-DHT /
  superset-Nostr split: the DHT offer omits hy2, the Nostr offer carries it with the cert, and the
  envelopes now use random nonces plus authenticated domains (`seq` vs `'n'+seq`). The cert carries
  a SAN so Go's TLS verifier accepts it under `server_name=magnetgate`.

### Stabilization, 0.11 (2026-09-13)

Native wire v4 authenticates routing metadata and counters. TCP setup/half-close, reusable UDP
associations, multi-exit fallback, Nostr reconnect publication, durable sequences, rotation recovery
and deploy rollback now have regression coverage. Desktop uses shared transport/config validation,
owned process lifecycles and an optional persistent firewall policy. The older field test above
does not validate this new firewall implementation: elevated crash/leak/recovery testing and a
coordinated v4 server/client rollout remain required before calling it field-validated.

### Hardening, 0.11.1 (2026-09-16)

An external audit (`docs/audit-2026-09-16.md`, internal) found that the engineering was ahead of the
operations. What it changed is in the CHANGELOG; three items belong on this roadmap because they are
product decisions, not cleanups:

1. **Fixed addresses.** The production exit address had been published inside a test report in this
   repository (purged, but a public repo means it is public forever). The project's "no single
   address a censor can block" claim is only true for the *rendezvous*, not for the exit: `target`
   and the host in the offer never rotate, so an IP-level block is terminal. That is exactly what
   §4 (exit overlay) is for, and it is now the highest-value next feature — ahead of WebRTC,
   multipath and the cold-fallback tier.
2. **The deploy path.** Autodeploy runs `npm ci` + `npm test` from GitHub as root, and the optional
   signature gate cannot be enabled because no commit is signed. Either sign commits and enable it,
   or run the install and tests unprivileged and keep only the activation step as root.
3. **The firewall guard.** The one component able to cut off all connectivity has still never been
   tested against a crash, a kill or a profile change, and it pins absolute paths of a portable
   executable that unpacks into a temporary directory. Until a VM test matrix exists it should be
   described in the UI as unverified, not as protection.

Deferred deliberately: splitting `app/main.js` (it is covered by tests and is in daily use) and any
change to the TUN stack.

**Owner decision (2026-09-16):** items 1 (fixed exit address / exit overlay) and 3 (firewall-guard
field testing) stay on the roadmap but are **not being worked on while the project is in its test
stage**. Item 2 (root deploy path and commit signing) is open. The audit report keeps them listed as
unresolved rather than planned, and the README wording was adjusted so nothing claims more than the
code delivers today.

The blocker for item 1 is concrete, not a priority call: §4 assumes a private overlay of the
operator's own nodes (at minimum a cheap entry plus the existing egress), and **there is currently no
capacity to run additional nodes**. Nothing in §4 can be built for a single host, because a second
address is exactly what the overlay exists to provide.

What that does *not* mean (an earlier revision of this paragraph got it wrong): moving the exit to
another address is **not** a client-side change and does **not** require redistributing the PSK. The
address travels inside the sealed offer (`MAGNETGATE_PUBLIC_HOST` is only a field of the published
record), while the rendezvous key derives from the PSK, so a client that reads the record follows the
new `host` with no reconfiguration — it re-reads the offer every 10 s, though an established session
keeps the old address until it drops. The real cost of having one node is therefore downtime and
manual work, not broken clients.

Two caveats worth knowing before a move: the client's `bootstrap` list should be checked, because it
currently leads with the exit's own IP (`<exit-ip>:20001`), which goes stale the moment the exit
moves; and a blocked address is still a hard stop rather than something routed around, which is what
§4 would add.

## 4. The exit overlay — entry/egress split & control-plane mesh

**Motivation.** The two honest weaknesses of the current design are (a) the exit is a single,
blockable IP:port — credential rotation does *not* help against IP-level blocking, which is the
censor's endgame; and (b) one exit sees both the client IP and the destination. Letting server parts
talk to each other fixes both — **if scoped carefully.**

### 4.1 Recommended shape: a private overlay of the operator's own nodes

Not a public/volunteer onion. A small mesh of **your own** nodes with two roles:

- **Entry nodes** — cheap, disposable fronts running Reality/hysteria2. These are what the client
  connects to, what gets published + rotated in the rendezvous, and what the censor can see/block.
  Replacing a burned entry IP is cheap and automatic.
- **Egress nodes** — a few stable nodes that actually reach the internet. **Never published in the
  rendezvous**, only reachable from entries over an authenticated exit↔exit link. The censor never
  sees an egress IP, so it can never block it.

```
client ─▶ entry (Reality/hy2, disposable, published & rotated)
             └─ authenticated exit↔exit link ─▶ egress (hidden, stable) ─▶ target
```

**What it buys:**
- Kills weakness (a): only entry IPs are exposed/blockable, and they are disposable + auto-rotated;
  the real egress stays hidden.
- Partial (b): entry knows the client IP but not the destination (encrypted to the egress); egress
  knows the destination but not the client. No single node has both.
- Egress diversity: pick the egress with the best route / right geo / not IP-reputation-blocked for a
  given target (geoblock + reputation bypass).

**Why "own nodes only" (for now):** if all nodes are the operator's, trust is uniform and the design
stays simple — no malicious-relay, Sybil, or third-party-abuse problems. The anonymity gain is
smaller than with independent operators, but the complexity and legal/abuse risk are far lower. Going
volunteer/independent-operator is where the real anonymity is *and* where you start reimplementing
Tor — treat that as a separate, explicit decision (see §4.4), not a drift.

### 4.2 Control-plane gossip (cheap, high value, low risk — do this early)

Independently of data relaying, let nodes exchange a small signed control stream:
- health / liveness, current rotation generation, "blocked in region X" intel;
- cross-publish each other's entry offers into the rendezvous, so a client that discovers **any**
  live entry can reach the whole network;
- coordinate rotation timing.

This can ride the existing rendezvous infra (or a dedicated authenticated channel) and reuses the
forward-secret handshake for node↔node auth. It delivers most of the resilience benefit before any
data-plane meshing.

### 4.3 How it fits the current architecture (little new crypto/concepts)

- **Offer/dp extends naturally:** an entry's offer says "entry; egress via the overlay"; the client
  never learns the egress. Rotation applies to entries as today.
- **exit↔exit link reuses the existing forward-secret handshake** (mutual key auth between the
  operator's nodes) — no new primitive.
- **Rendezvous (DHT/Nostr) already** distributes entry offers and can carry gossip.
- **Latency:** one extra hop; keep both hops close (co-located/same-region egress) to bound RTT.
  Single-hop stays the default fast path; multi-hop is opt-in per route (for the geo/reputation cases
  or, later, anonymity).

### 4.4 Risks & boundaries (read before expanding scope)

- **Latency tax** — every hop adds RTT; never make multi-hop the default.
- **Complexity** — a mesh means peer discovery, authenticated node↔node sessions, path selection,
  loop prevention, key management, gossip and failure handling: an order of magnitude more than the
  current tool, and a large bug surface. Grow it in the smallest testable steps.
- **The "reinvent Tor" trap** — a full volunteer, any-to-any, multi-hop-for-anonymity network is a
  solved problem (Tor/I2P/Lokinet), audited and mature. If anonymity (not just unblockability)
  becomes an explicit goal, seriously evaluate building on Tor pluggable transports / I2P instead of
  reimplementing them. magnetgate's edge is brokerless rendezvous + Reality-grade camouflage, not the
  onion routing itself.
- **Trust & legal** — independent-operator egress relaying arbitrary traffic carries Tor-exit-style
  legal exposure and malicious-relay risk; node↔node connectivity also makes a compromised node an
  attack vector on peers (need strong mutual auth + least privilege between nodes).

### 4.5 First concrete step (contained, testable)

A **2-node, operator-owned entry→egress relay**: a cheap entry runs the Reality/hy2 front and
tunnels over an authenticated link to a hidden egress; only the entry is published in the rendezvous.
Verify: client → entry → egress → target works, the egress IP never appears in any offer, and
burning/rotating the entry swaps it without touching the egress. If it holds up, add the control-plane
gossip (§4.2) and a small pool of entries.

This still needs a relay protocol between the two nodes, so it stays blocked while there is no
capacity for extra nodes. It should not be confused with multi-exit fan-out (§5): that one gives
availability across independent exits and is being designed first, but it does **not** hide an egress
— every exit stays discoverable in the rendezvous, which is exactly the property §4 exists to change.

## 5. Other post-Phase-3 directions

- **WebRTC DataChannel data plane** (coturn on the exit; DTLS looks like a video call; built-in NAT
  traversal) as another `dp` type — direct P2P without a fixed data port; complements the overlay.
- **Third rendezvous channel** — a DoH / ENS dead-drop, so Layer 1 has ≥3 independent mechanisms.
- **Multi-exit fan-out** — several exits, each rotating Reality/hysteria2; the client load-balances
  and fails over across them (a lighter cousin of the overlay when full entry/egress split is not
  needed). **Chosen next step:** it needs no relay protocol and the client was already most of the way
  there (`exits[]` takes a shared PSK with a per-node salt; per-connection fail-over and the desktop
  `urltest` exist). **Phase 0 landed 2026-09-16:** an exit occupies a rendezvous slot
  (`MAGNETGATE_NODE_SLOT`, `MAGNETGATE_NODE_NAME`), a client can look for several slots from one PSK
  (`MAGNETGATE_SLOTS`), each slot has its own salt/target/box key, and slot 0 is byte-identical to the
  single-node derivation so nothing had to migrate. Verified by `scripts/dev/multi-node-lab.mjs`
  (two loopback nodes, one PSK, kill one, the next request uses the other). Remaining work — peer
  advertisement (`peers`), per-plane health, automatic slot allocation and the desktop settings field —
  is described in the internal `docs/design-multi-node.md`. **Phase 1 (nodes find each other) landed
  2026-09-16:** each node scans the other slots (`MAGNETGATE_PEER_SLOTS`) and lists the live ones in
  `peers`, so a client that knows one slot learns the rest by itself — adding or replacing a node no
  longer means touching every client. Verified on two live nodes on one PSK. This still does **not**
  hide an egress: every node stays discoverable in the rendezvous, which is the property §4 exists to
  change.
- **Multipath aggregation** — carry one session across several data planes at once (MPTCP-style), so
  blocking one degrades throughput instead of dropping the session.
- **Cold-fallback tier** — email/IMAP store-and-forward for total-shutdown scenarios; Starlink at the
  physical layer.
- **Cross-platform clients** — Linux/macOS/Android (sing-box is cross-platform) packaged as a
  service; automated exit provisioning + health/metrics.

## 6. Suggested sequencing

1. **Phase 3** (TUN VPN + hy2 cert-pinning) — finishes the "usable daily driver" story.
2. **Control-plane gossip (§4.2)** — cheap resilience; nodes cross-publish + coordinate rotation.
3. **Entry/egress split (§4.5)** — the anti-IP-blocking win, operator-owned, single extra hop.
4. **Multi-exit fan-out + a third rendezvous channel** — scale the pool and the discovery layer.
5. **WebRTC data plane / multipath / cold fallback** — as needs dictate.

Guiding rule: **grow the overlay as a private network of your own nodes; keep single-hop the fast
default; and if the goal ever becomes anonymity rather than unblockability, decide explicitly whether
to build on Tor/I2P instead of reimplementing them.**
