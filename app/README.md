# magnetgate desktop 0.3.5

The shared Windows/macOS app manages a sing-box TUN process. Personal public access uses
pinned Hysteria2 with individual device credentials. In private PSK mode, a discovery/native
SOCKS client provides Reality/Hysteria2 endpoints and native fallback. Node is bundled through Electron.

## Connect with a personal code

1. Download the Windows ZIP or the matching macOS DMG from [magnet.norma.so](https://magnet.norma.so/#start).
   On Windows extract the complete ZIP. On macOS move the app to Applications.
2. Get and save a personal `MG1-…` code on the same website.
3. With the VPN off, open **Настройки → Личный доступ MagnetGate**, paste the code and select
   **Подключить личный доступ**. Activation selects the public connection source.
4. Return to **Подключение**, select the desired routing mode and connect. Accept the system
   administrator prompt needed to create the VPN interface.

Both Mac architectures support the same personal-code flow. Mac builds are experimental,
unsigned and unnotarized; see the validation limits below. Public access carries TCP and UDP
but needs a reachable UDP/4443 transport. It has no Reality/native fallback and does not use
the owner's PSK. Limits and revocation are described in the [project overview](../README.md).

Codes are saved through OS-backed Electron secure storage, separate from ordinary configuration.
Do not share your code or the private files in the app's userData directory.

## Build and develop

Use Node.js 22.12 or later for desktop tooling; the core requires 20.19 or later.

```powershell
# repository root
npm ci
powershell -ExecutionPolicy Bypass -File scripts/get-singbox.ps1
# Provide wintun.dll in tools/sing-box and verify it against scripts/pins.json.
# get-singbox.ps1 fetches sing-box and public rule sets, not wintun.dll.
cd app
npm ci
npm run install:electron
npm test
npm start
npm run dist
```

The portable artifact is `app/dist/magnetgate-0.3.5.exe`. The app requests Administrator at launch
for TUN/firewall operations. Child processes are hidden and only owned processes are stopped.
For frequent use, extract `app/dist/magnetgate-0.3.5-win.zip` once and launch `magnetgate.exe`
from that folder. Keep all extracted files together. This avoids unpacking Electron and the engine
on every cold launch; the standalone portable EXE still unpacks into a fresh temporary directory.
Each portable launch uses its own temporary resource directory; duplicate launches reveal the
existing window without deleting its active resources.
For the pinned electron-builder 26.15.3, `portable.unpackDirName: true` omits `UNPACK_DIR_NAME`
and selects `$PLUGINSDIR/app`. Its implementation differs from the online documentation's
description of `false`; check this behavior before changing the builder version.

Builds use the valid empty example config by default. Activate a personal code as above, or
add your own private-group PSKs under Настройки → Серверы и ключи доступа.
`MAGNETGATE_PERSONAL_BUILD=1` deliberately embeds the local `magnetgate.config.json`; such an artifact
contains credentials and is for private use. The resource allowlist excludes local sing-box JSON
configs and logs. Store user settings in Electron userData; use Open config folder to find it.

## Related clients and versions

This shared Electron client supports Windows x64 and macOS x64/arm64. It is separate from the native
[Android client](../app-android/README.md), whose UI has a RU/EN switch. Desktop currently uses
Russian labels. The root core version and Android package version are independent of desktop 0.3.5.
`npm run dist` builds a local portable executable and a ZIP archive; it does not publish a GitHub release.

## macOS build and testing

macOS support was imported from [Xaint00ship/tunnel-manager-client-macos](https://github.com/Xaint00ship/tunnel-manager-client-macos),
commit `35f08d9fe7854be9f941394e600e25fb538297ec` (MIT). Platform paths, automatic utun naming,
Darwin download pins and DMG/ZIP packaging are integrated into this shared latest desktop client;
the fork's older core and planning documents are not substituted for the current implementation.

On an Intel or Apple Silicon Mac, install Node.js 22 and run:

```sh
npm ci
bash scripts/get-singbox-macos.sh
cd app
npm ci
npm test
npm start
npm run dist:mac
```

Build on the target architecture. The resource gate checks the pinned engine/rule-set hashes
and refuses cross-architecture packaging. CI uses macOS 15 arm64 and macOS 15 Intel runners.
Archives are `magnetgate-0.3.5-mac-arm64` or `magnetgate-0.3.5-mac-x64` (DMG and ZIP).
These test builds are unsigned and unnotarized; production signing requires an Apple Developer
identity and notarization credentials. No signing key is included in the repository.

The GUI and discovery client run as the ordinary user. The first VPN start opens macOS's system
administrator prompt for an ephemeral Node helper, which launches only the bundled VPN engine.
A private Unix socket with a random per-launch capability carries validated settings. The helper
rebuilds the VPN config, uses a root-owned private runtime directory, stops its owned engine on
disconnect/socket loss/heartbeat expiry, and deletes its runtime config on exit. No persistent
daemon is installed. macOS assigns the utun interface name. The Windows persistent firewall
kill switch is unavailable on macOS and is disabled in both settings and runtime configuration.

Automated tests cover configuration, protocol authentication and shared lifecycle; CI runs real
loopback engine mode tests and packages both architectures. Interactive authorization, real TUN
connectivity, crash recovery, sleep/wake and Gatekeeper installation still need a Mac test session.
An Intel VM does not replace testing Apple Silicon. A forcibly killed root helper may require
manual cleanup of its engine; persistent macOS protection is not claimed.

## Interface

The Russian UI has four screens: Подключение, Сайты, Настройки and Диагностика. Full is labelled
«Весь интернет» and Split «Только выбранное». The selected preference and actual applied mode
are displayed separately while a change is pending. Light/dark appearance follows the operating system.

Direct exceptions and tunnel domains are separate lists; editing either does not switch modes.
Rule changes save automatically (unlike Android, where Save rules is explicit).
Server keys and advanced settings use explicit Save buttons;
unsaved drafts do not leak into unrelated saves. Existing userData configuration remains in use.
Diagnostics shows live status, egress and the bounded log; Refresh reads the current status.

`npm test` includes state/recovery tests and loopback-only sing-box checks. The optional
`npm run test:ui` runs the actual renderer in headless Edge using fixture IPC, without Electron,
TUN or firewall operations. It requires an existing Playwright installation (set `PLAYWRIGHT_MODULE`
to its module directory if it is not on the module search path). Screenshots go to ignored
`tools/verification/ui-0.3.0`. This does not replace a manual test of the packaged desktop app.

## Routing and protection

On macOS the root helper leases a supplemental system DNS resolver at `172.19.0.2`
only after the TUN is ready. Queries use encrypted DNS through the proxy in both modes.
The temporary resolver disappears on disconnect, engine failure or helper termination;
Wi-Fi/Ethernet DNS preferences are not modified. IPv4 is preferred, but IPv6 destinations
are routed according to the selected policy instead of being unconditionally rejected.

- Full: proxy by default with only explicit user domain exceptions. Bundled lists never add
  direct website exceptions. Private-network and transport/discovery bypasses remain separate.
- Split: only selected domains/IP rules go through the proxy.
- With the firewall option off, switching Full/Split updates rules on the same engine/TUN.
  Both modes remain available when starting in Split with an empty exception list.
  Existing connections close so applications reconnect under the new policy. Other configuration
  changes and transitions with the firewall option enabled still restart the engine.
- Strict Full firewall option: disables direct exceptions, records prior local firewall settings,
  disables existing local outbound allows and restricts egress to the owned executables, loopback
  and TUN. The policy survives engine or app termination. **Disconnect** restores the recorded
  policy; simply closing the app leaves it engaged. Domain/GPO policy that prevents enforcement
  is reported as an error. A recovery file alone is never shown as verified protection.

The firewall option is off by default. This revision has unit tests, real Electron UI checks and
`sing-box check` validation; elevated TUN/firewall crash, leak and restoration tests have not been
performed on the workstation. Its `-Status` and `-DryRun` commands are read-only. Recovery from an
interrupted strict session is available through Disconnect or elevated PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/kill-switch.ps1 -Off
```

For a packaged app, use its `resources/scripts/kill-switch.ps1` path or reopen the app and Disconnect.
Other full tunnels should be turned off first. The legacy PowerShell launchers only provide routing
while their engine runs; they do not enable the persistent guard.

Connection health compares HTTPS system egress with an HTTPS request forced through a separate
proxy-only SOCKS inbound. Full accepts matching addresses or two addresses belonging to the selected
discovered VPN nodes, because concurrent probes can use different exits during failover. An unrelated
system address still fails the check. Split has a separate health condition. Endpoint snapshots expire after
12 minutes and are refreshed independently of active connections.
Mode changes request an immediate health check and discard results from previous policies.
Logs distinguish a live mode change from an engine restart and include mode-change duration/PID.

On Connect, discovery runs during the Windows adapter inspection. The TUN starts only after that
inspection passes. Authenticated endpoint changes notify the app over its owned child-process IPC;
a 100 ms batch window combines nearby offers into one configuration. The two-second poll remains
as recovery if a notification is lost. Disconnect cancels pending wakeups and late offers cannot
activate a stopped connection.

App and sing-box warnings share the bounded, rotating userData/logs `magnetgate.log` (plus one
previous file). Existing `vpn.log` files are historical and are no longer appended by the app.
Each engine attempt uses a fresh TUN name to avoid reusing a stale Wintun device identity.
Startup waits up to 30 seconds for authenticated control and SOCKS endpoints before egress checks.
Disconnect cancels that wait. If Windows delays termination, the app retains the owned process,
offers Disconnect again and keeps the window open on failed shutdown.

## Country and application rules

The country selector applies to both the engine and the native TCP/UDP fallback and is built from discovered offers.
Changing country or discovery slots refreshes the native client configuration. It is a preference with fallback when no
endpoint matches, not a promise that every connection exits in that country. Diagnostics summarizes
discovered nodes and their transports. Traffic counters describe observed activity, not link capacity.
Desktop application bypass uses executable names; Android selects installed application packages.

## Protocol migration

Core 0.11 uses native wire v4 and v4 sealed rendezvous envelopes. Clients and exit must be updated
together. Offer JSON remains schema v3; desktop endpoint snapshots are schema v4. The legacy native
helper names `frame2`/`makeCodecV2` do not imply old-wire compatibility.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the validation commands and [README.md](../README.md) for discovery and exit configuration.
