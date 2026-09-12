# magnetgate desktop app

An Electron UI around the magnetgate client. It runs the existing
[`../src/client.js`](../src/client.js) as a separate system-`node` process (rendezvous, local SOCKS,
Reality→hy2→native fail-over), manages a `magnetgate.config.json` (PSK / exits / ports), and brings
the system-wide VPN up on the sing-box TUN via
[`../scripts/vpn-singbox-windows.ps1`](../scripts/vpn-singbox-windows.ps1) — elevated on demand (UAC
only when you enable it; the app itself stays unprivileged).

## Prerequisites

The built app is **self-contained** — no system Node.js needed at runtime. The client runs on
Electron's own Node (`ELECTRON_RUN_AS_NODE`); this is safe because the only native dep,
`sodium-native`, ships ABI-stable N-API prebuilds.

To **build**, the resources that get bundled must be present:
- repo deps at the root: from the repo root run `npm ci` (bundled into the exe);
- `../tools/sing-box/sing-box.exe` and `wintun.dll` — `powershell -File ..\scripts\get-singbox.ps1`
  fetches sing-box; wintun is auto-fetched (pinned) by the VPN launcher, or place `wintun.dll` in
  `../tools/sing-box/` yourself.

## Develop

```powershell
cd app
npm install        # electron + electron-builder (dev only)
npm start          # launch the app against ../src and ../tools
```

The config is stored in Electron's `userData` dir (Open config folder in the UI), **not** in the
repo, so PSKs are never committed. On first run it is **seeded** from `seed-config.json` (prepared
at build by `prepare-seed.js` from your `../magnetgate.config.json`), so testing needs no manual PSK
entry. Because that seed is baked into the exe, the built `.exe` then **contains your PSK — keep it
private**. `seed-config.json` is gitignored.

**Logs** (for reading back a field test): everything goes to `%APPDATA%\magnetgate\logs\` —
`magnetgate.log` (app events + the client's output) and, when the VPN is on, `vpn.log` (sing-box)
and `vpn-launcher.log`. The UI has an **Open logs folder** button.

## Build a portable .exe

```powershell
cd app
npm install
npm run dist       # -> app/dist/magnetgate-<version>.exe
```

`electron-builder` bundles `../src`, `../node_modules`, `../tools/sing-box` and the VPN launcher as
resources (see the `build.extraResources` in [package.json](package.json)).

## Notes / limitations

- **Elevation model:** only the System-VPN toggle elevates (a UAC prompt spawns the TUN launcher);
  starting/stopping the client and editing config do not. The elevated sing-box runs in its own
  window, so its log is not streamed into the app (the client's log is). Turning the VPN off elevates
  again (second UAC).
- **Other full tunnels:** do not enable the system VPN on top of an active WireGuard/OpenVPN full
  tunnel — turn the other one off first.
- Field bring-up of the TUN has not been validated yet (see the repo ROADMAP); the generated sing-box
  config is offline-validated with `sing-box check`, and the packaged client is verified to start on
  Electron's Node.
