# magnetgate desktop app

An Electron UI around the magnetgate client. It runs the existing
[`../src/client.js`](../src/client.js) as a separate system-`node` process (rendezvous, local SOCKS,
Reality→hy2→native fail-over), manages a `magnetgate.config.json` (PSK / exits / ports), and brings
the system-wide VPN up on the sing-box TUN via
[`../scripts/vpn-singbox-windows.ps1`](../scripts/vpn-singbox-windows.ps1) — elevated on demand (UAC
only when you enable it; the app itself stays unprivileged).

## Prerequisites

- **Node.js** (v20+) on PATH — the client child process is launched with the system `node`.
- The repo deps installed at the root: from the repo root run `npm ci` (provides `sodium-native`,
  `bittorrent-dht`, etc. that the client needs; the app finds them via `NODE_PATH`).
- `../tools/sing-box/sing-box.exe` and `wintun.dll` present — fetch with
  `powershell -File ..\scripts\get-singbox.ps1` (wintun is auto-fetched by the VPN launcher, pinned).

## Develop

```powershell
cd app
npm install        # electron + electron-builder (dev only)
npm start          # launch the app against ../src and ../tools
```

The config is stored in Electron's `userData` dir (Open config folder in the UI), **not** in the
repo, so PSKs are never committed.

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
  config is offline-validated with `sing-box check`.
- Bundling a pinned `node.exe` (so the app is fully self-contained instead of relying on system Node)
  is a possible follow-up.
