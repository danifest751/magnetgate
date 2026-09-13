# magnetgate desktop 0.3

The elevated Electron app manages a sing-box TUN process and a discovery/native SOCKS client.
Reality and pinned hysteria2 run directly in sing-box; native is a fallback through the Node client.
Multiple fresh exits participate in selection. Node is bundled through Electron.

## Build and develop

Use Node.js 22.12 or later for desktop tooling; the core requires 20.19 or later.

```powershell
# repository root
npm ci
# sing-box.exe and wintun.dll must exist in tools/sing-box
cd app
npm ci
npm run install:electron
npm test
npm start
npm run dist
```

The portable artifact is `app/dist/magnetgate-0.3.1.exe`. The app requests Administrator at launch
for TUN/firewall operations. Child processes are hidden and only owned processes are stopped.

Builds use the valid empty example config by default. Add PSKs under Настройки → Серверы и ключи доступа.
`MAGNETGATE_PERSONAL_BUILD=1` deliberately embeds the local `magnetgate.config.json`; such an artifact
contains credentials and is for private use. The resource allowlist excludes local sing-box JSON
configs and logs. Store user settings in Electron userData; use Open config folder to find it.

## Interface

The Russian UI has four screens: Подключение, Сайты, Настройки and Диагностика. Full is labelled
«Весь интернет» and Split «Только выбранное». The selected preference and actual applied mode
are displayed separately while a change is pending. Light/dark appearance follows Windows.

Direct exceptions and tunnel domains are separate lists; editing either does not switch modes.
Rule changes save automatically. Server keys and advanced settings use explicit Save buttons;
unsaved drafts do not leak into unrelated saves. Existing userData configuration remains in use.
Diagnostics shows live status, egress and the bounded log; Refresh reads the current status.

`npm test` includes state/recovery tests and loopback-only sing-box checks. The optional
`npm run test:ui` runs the actual renderer in headless Edge using fixture IPC, without Electron,
TUN or firewall operations. It requires an existing Playwright installation (set `PLAYWRIGHT_MODULE`
to its module directory if it is not on the module search path). Screenshots go to ignored
`tools/verification/ui-0.3.0`. This does not replace a manual test of the packaged desktop app.

## Routing and protection

- Full: proxy by default with configured direct exceptions and an optional bundled RU list.
- Split: only selected domains/IP rules go through the proxy.
- With the firewall option off, switching Full/Split updates rules on the same engine/TUN.
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
proxy-only SOCKS inbound. Split has a separate health condition. Endpoint snapshots expire after
12 minutes and are refreshed independently of active connections.
Mode changes request an immediate health check and discard results from previous policies.
Logs distinguish a live mode change from an engine restart and include mode-change duration/PID.

App and sing-box warnings share the bounded, rotating userData/logs `magnetgate.log` (plus one
previous file). Existing `vpn.log` files are historical and are no longer appended by the app.
Each engine attempt uses a fresh TUN name to avoid reusing a stale Wintun device identity.
Startup waits up to 30 seconds for authenticated control and SOCKS endpoints before egress checks.
Disconnect cancels that wait. If Windows delays termination, the app retains the owned process,
offers Disconnect again and keeps the window open on failed shutdown.

## Protocol migration

Core 0.11 uses native wire v4 and v4 sealed rendezvous envelopes. Clients and exit must be updated
together. Offer JSON remains schema v3; desktop endpoint snapshots are schema v4. The legacy native
helper names `frame2`/`makeCodecV2` do not imply old-wire compatibility.
