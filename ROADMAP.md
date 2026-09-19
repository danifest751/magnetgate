# magnetgate roadmap

Last updated: **2026-09-19**. This document separates current behavior from proposed work.
See the [README](README.md) for configuration and [CHANGELOG](CHANGELOG.md) for history.
Items below are not release dates or claims of completed device validation.

## 1. Scope

magnetgate provides brokerless discovery, credential rotation and per-connection fail-over around
Reality, hysteria2 and a native forward-secret transport. Discovery uses Mainline DHT and Nostr;
their infrastructure and the exit endpoints can still be blocked. Native transport is another
option, not a guarantee of reachability. Credential rotation does not rotate an IP address.

The intended model is a small trusted group sharing a strong PSK. Strong anonymity against a
global observer is outside the current design. A PSK holder can locate and forge group offers;
the system is not a public anonymous relay network.

## 2. Implemented

| Area | Current behavior | Validation boundary |
|---|---|---|
| Discovery | DHT + Nostr, sealed wire v4 envelopes, offer JSON schema v3; compact DHT and full Nostr views | Both channels still depend on reachable network infrastructure |
| Transports | Reality, certificate-pinned hysteria2 and forward-secret native fallback | Availability and camouflage depend on the network |
| Rotation | Daily data-plane credentials, previous-generation grace window, durable publication sequence | Clients and exits must use compatible wire versions |
| Multiple nodes | Slots `0..15`, peer advertisements, per-node/per-plane health, fallback and slot controls in clients | Slot assignment is manual; established streams are not migrated |
| Windows | Electron 0.3.3, sing-box TUN, Full/Split routing, country preference, application rules, diagnostics | Earlier live TUN checks do not validate the optional persistent firewall guard |
| Android | Native 0.1.0 client, one Go/engine AAR, `VpnService`, website/app rules, three-tab UI, icon, persistent RU/EN switch | Tested on an emulator and an Android 16 ARM64 phone; not all Android/OEM combinations |
| Android health | Engine-path DNS/HTTPS checks, fresh-result status, network handover handling, real traffic counters | One successful check does not prove the route of every app/connection |
| Operations | Runtime sandboxes, pinned downloads, hygiene gate, unprivileged candidate install/test and activation rollback | Signature verification is optional and needs trusted signed commits |

The desktop app owns its engine directly. The old PowerShell VPN launchers are deprecated
reference scripts. Android language changes preserve the active VPN and drafts; saving routing
or access changes requires reconnection. Details are in the [desktop](app/README.md) and
[Android](app-android/README.md) guides.

## 3. Remaining validation and delivery work

- **Android compatibility:** expand physical-device coverage across Android 8+ and OEM firmware,
  including VPN consent, secure storage, background restrictions, restart and network handover.
  Current APKs cover ARM64 phones and x86_64 emulators; there is no 32-bit package.
- **Android distribution:** establish repeatable signed releases, update/migration testing and
  artifact distribution. A package version or local debug APK is not a published release.
- **Windows firewall guard:** controlled elevated tests of engine/app crashes, forced kills,
  network profile changes and restoration, including portable executable paths. Keep it off by
  default and avoid treating routing alone as protection after a process exits.
- **Commit signing:** establish operator trust and signed updates before enabling `.deploy-verify`.
  Running candidate installation/tests as root was already fixed; it is not pending work.
- **Multiple nodes:** automatic slot allocation and broader failure/load tests. Peer advertisements,
  per-plane cooldowns and desktop slot editing are already implemented.
- **Protocol rollout:** keep clients/exits coordinated for breaking wire changes and test recovery
  during upgrades. Native wire v4 does not interoperate with older sealed envelopes.

The owner's 2026-09-16 decision deferred entry/egress overlay work and firewall field testing
during the test stage. This documentation update does not change that priority decision. A future
overlay trial needs separately allocated nodes; today's independent exits are not such an overlay.

## 4. Proposed entry/egress overlay

**Not implemented.** The proposal separates replaceable client-facing entry nodes from internet
egress nodes owned by the same operator:

```text
client → entry (Reality/hysteria2, published in rendezvous)
             → authenticated inter-node link → egress → destination
```

Only entry endpoints would be published to clients. This could make replacing blocked entry
addresses easier while keeping stable egress identities. It cannot make an address unblockable:
destinations still see egress IPs, operators know their nodes, and observation/correlation can
reveal relationships. An entry must not learn the destination if that is a design goal; an
authenticated entry-to-egress link alone is insufficient and needs an inner client-to-egress
encryption design and review.

Start, if approved and provisioned, with two operator-owned nodes and one explicit relay path.
Define authentication, key separation, routing, loop prevention, failure behavior and resource
limits before adding a mesh. Verify that offers omit egress endpoints, requests traverse both
hops, and replacing an entry allows new client connections without changing egress identity.
Measure the extra latency and retain single-hop as the default.

Possible later control-plane work includes authenticated health exchange, coordinated rotation
and cross-publication. Current `peers` advertisements tell clients which slots to discover; they
do not implement inter-node traffic forwarding, cross-signing offers or a gossip mesh.

Independent volunteer relays would change the trust and abuse model substantially. If strong
anonymity becomes a requirement, evaluate established anonymity networks instead of silently
expanding this private-group tunnel into one.

## 5. Other proposals

| Direction | Open design question |
|---|---|
| Third discovery channel, such as a DoH/ENS dead-drop | Authentication, freshness and independence from existing blocked infrastructure |
| WebRTC DataChannel transport | NAT traversal, relay requirements, fingerprinting and operational cost |
| Multipath | Session scheduling, ordering and recovery across simultaneous transports |
| Store-and-forward via email/IMAP | Delayed-message use cases; it cannot replace interactive internet access |
| Linux/macOS packaged clients | Supported VPN integration, packaging, lifecycle and recovery |
| Provisioning/metrics | Repeatable host setup and operator visibility beyond the current scripts |

These are research directions, not supported configuration options. Any physical fallback depends
on separately available connectivity and is outside the current software.

## 6. Sequencing

Stabilize and document the existing clients, exercise compatibility and recovery, then establish
release/signing operations. Expand multi-node testing without calling it an entry/egress relay.
Revisit the deferred overlay and firewall work when the owner allocates test capacity. Select
additional discovery/transports based on measured failures rather than treating every proposal
as a committed feature.
