# User connections — operator-provisioned pilot

The shared Go module is `app-android/core/peer`. This mode uses its own service and device keys;
it does not reuse VPN PSKs, rendezvous signing keys, or Android update-signing keys.
Android devices with existing VPN credentials keep the sealed update-metadata discovery in
the background; packages download through the peer VPN engine and retain the existing digest
and Android signature checks. Peer-only provisioning currently needs a separate trusted update
distribution plan; the peer service cannot authorize an app update.

| Platform | Connect through another user | Host a native exit |
|---|---|---|
| Windows x64 | Implemented; tested with native HTTPS egress | Implemented; separate limited process |
| Linux | Shared headless host | Tested on an unprivileged pilot server |
| macOS arm64/x64 | Included in shared desktop packaging and helper configuration | Disabled pending real Mac validation |
| Android arm64/x64 | Included in the combined AAR; tested on a physical arm64 phone | Opt-in physical IPv4 adapter implemented; exit/background field validation pending |

The pilot supports **TCP ports 80 and 443 only**. Proxied UDP is rejected after DNS interception.
DNS uses HTTPS through the selected exit; explicit direct routing exceptions retain their behavior.
Owners must leave their own VPN off. A physical route or DNS change pauses hosting and closes
owner sessions. On Windows the host drops administrative privileges, including when UAC is disabled;
if verified privilege reduction fails, it refuses to start.

## Interface

Select **Соединения пользователей** and **Автоматически** or a country from the live catalogue.
Search matches country names and ISO codes. A missing selected country stays visible and cannot
silently become another country. Reconnection may create new TCP connections; existing TCP flows
are not migrated between exits.

On Android, select **Пользователи** and tap the country card to open the searchable location list.
Connection details are available separately. Received and sent counters measure TCP payload
through the user connection, including proxied DNS and health checks; they exclude relay framing
and traffic routed directly. Counters survive recovery within a VPN session and reset for a new one.

In the same Android panel, **Разрешить другим использовать моё соединение** enables a separate
foreground sharing service with a persistent stop action. A provisioned exit role is required;
selecting user connections alone never enables sharing. **Ограничения раздачи** selects automatic
or manual aggregate speed (0.1–5 Mbps) and 1–2 simultaneous users; default quotas are 1 GiB/day and
20 GiB/month across both directions. Saved limits survive restart, but consent does not.
Sharing pauses for the owner's or another VPN, an uncertain physical network, or restricted Doze.
It resolves and binds each target socket to one validated physical Network generation and rejects
local/on-link prefixes, gateway/DNS endpoints, its observed IPv4 source and the control service.
Native IPv6-only forwarding is not enabled in this pilot. Android foreground services do not
exempt an app from [Doze network restrictions](https://developer.android.com/training/monitoring-device-state/doze-standby).

An eligible desktop owner enables **Разрешать другим пользователям использовать моё соединение**.
No per-guest invitations are needed. Hosting is off by default. The pilot allows 1–2 guests,
an aggregate cap of 0.1–5 Mbps, and persisted daily/monthly quotas counted across both directions.
Automatic mode starts conservatively and adjusts below the chosen cap. Changing limits closes
existing owner sessions before publishing the new policy. After an unclean host exit, sharing
returns disabled and requires an explicit enable action. Quota/storage failures pause hosting;
an exhausted quota is not silently re-enabled by heartbeat.

## Private provisioning

Provisioning is an operator step in this pilot. Normal production account login, automatic
distribution of service trust, and GeoIP database ingestion are not implemented yet. These
credentials must never enter renderer state, public release seeds, logs, or Git.

Build the service and the user host from `app-android/core`:

```sh
go build -trimpath -o peer-service ./cmd/peer-service
go build -trimpath -o peer-node ./cmd/peer-node
```

Run the service as a dedicated non-root user with a private state directory and a valid HTTPS
certificate. It requires `--config /private/service-config.json`:

```json
{
  "listen": ":18443",
  "certificate": "/private/tls.crt",
  "privateKey": "/private/tls.key",
  "stateDir": "/private/state",
  "accounts": [
    {"token": "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS", "principal": "test-account", "guest": true, "exit": true}
  ],
  "locations": [
    {"prefix": "TRUSTED_OWNER_PUBLIC_IP/32", "country": "FI", "expires": 0}
  ]
}
```

Replace the location prefix and expiry with independently verified, dated data. An unknown or
expired location cannot host a READY exit. Only the observed socket source is used; clients
cannot supply their own country or spoof it through forwarded headers. The service prints its
public authority key on startup. Device registration is bounded to four devices per account
and 128 devices in this pilot service.

Install a private `service.json` in the host profile (`--profile` for the standalone host,
the desktop application's `userData/peer`, or Android's private `files/peer`):

```json
{
  "url": "wss://YOUR_SERVICE_HOST:18443",
  "authority": "SERVICE_PUBLIC_ED25519_KEY_HEX",
  "enrollmentToken": "ACCOUNT_TOKEN"
}
```

For a private CA, the optional `ca` field holds its PEM certificate. TLS verification stays
enabled. The profile contains the generated device identity, policy, usage and crash marker;
keep it private. Use separate guest-only accounts for devices that should not host exits.

`peer-node --profile /private/profile --headless` runs a provisioned Linux node until SIGTERM
or interrupt. Hosting still requires an enabled valid private `policy.json`; a headless launch
does not grant consent. The desktop uses an inherited stdin/stdout channel and has no public
administration listener.

## Bounds and validation

Presence uses a five-second heartbeat and a fifteen-second lease, with pushed catalogue changes.
Reservations last three seconds. An owner verifies guest credentials inside TLS pinned to device
keys, then grants a short session lease renewed on a reserved management stream. Data-flow
saturation cannot take that management slot. Public-target checks reject private/reserved,
owner and control-plane addresses, validate all DNS results and dial a numeric pinned address.
Guests prepare the authenticated relay link before reserving an exit, so a cold TLS/WSS connection
does not consume the short reservation. The overall connection timeout remains bounded.

Relay admission, concurrent sessions, new dials, byte rate and daily relay allowance are bounded.
Usage persists before forwarding; crashes can conservatively overcount a buffered chunk. A
successful service-level device revocation persists across restart. A failed persistence operation
returns an error and is not a committed durable ban; the running service denies further admission
until repaired. There is no public operator revocation endpoint in this pilot.

Validation includes Go race tests, meaningful catalogue/lease/consent/quota/target-guard tests,
32 concurrent encrypted TCP streams with renewal, authenticated SOCKS tests, desktop/browser
tests, Android unit tests/lint/build, a physical Android VPN test, and Windows VM HTTPS egress
and renewal beyond 60 seconds. Actual macOS installation, utun behavior and peer connectivity
remain open for testing on a Mac. Windows strict firewall integration with this new carrier
still needs a complete failure/recovery field run before production rollout.

Android exit validation currently covers native adapter race tests (handover, suspend/stop,
old DNS tokens, all-answer guarding, half-close and crash consent), combined AAR compilation,
Android unit tests and lint, and installation on an arm64 phone. Real remote-client egress,
screen-off sharing and VPN pause/resume remain field gates; installation alone is not proof.

Direct ICE/QUIC paths, UDP associations, sharing while the owner's VPN is active, macOS
exit hosting, multiple relay servers, and public-scale abuse/account infrastructure are later
stages, not features of this pilot.
