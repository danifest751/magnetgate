// magnetgate desktop app — Electron main process.
//
// UI-only Electron shell around the existing magnetgate client:
//  - the rendezvous/SOCKS/fail-over client (../src/client.js) runs on Electron's own Node runtime
//    (process.execPath + ELECTRON_RUN_AS_NODE=1), so the app is self-contained — no system Node
//    needed. This is safe because the only native dep (sodium-native) ships N-API prebuilds, which
//    are ABI-stable across Node/Electron versions;
//  - the system-wide VPN (sing-box TUN) is brought up via scripts/vpn-singbox-windows.ps1, elevated
//    on demand (UAC only when the user enables it) — the app itself stays unprivileged;
//  - config/PSK management reads and writes a magnetgate.config.json kept in userData, seeded on
//    first run from the bundled seed-config.json so testing needs no manual key entry.
const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')

// resource root: repo root in dev, the packaged resources dir otherwise
const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
const CLIENT = path.join(RES, 'src', 'client.js')
const VPN_PS1 = path.join(RES, 'scripts', 'vpn-singbox-windows.ps1')
// first-run seed for the user config: the bundled seed-config.json (real PSK/exits) if present,
// else the repo config in dev, else the PSK-less example.
const SEED_CANDIDATES = [
  path.join(RES, 'seed-config.json'),
  path.join(RES, 'magnetgate.config.json'),
  path.join(RES, 'magnetgate.config.example.json'),
]
const CONFIG = path.join(app.getPath('userData'), 'magnetgate.config.json')
// everything (app events + the client's stdout/stderr) is appended here so a field test can be read
// back afterwards; the sing-box TUN logs into the same folder (see the VPN launcher's -LogDir).
const LOG_DIR = path.join(app.getPath('userData'), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'magnetgate.log')
const LOG_MAX = 500

let win = null
let clientProc = null
let lastExitHost = null // exit IP learned from client logs, bypassed by the VPN
const logBuf = []
const state = { clientRunning: false, route: null, egress: null, vpnOn: false, lastError: null,
  otherTunnel: null, vpnHealthy: false }
let vpnEnabledAt = 0        // when the user last enabled the VPN (to tell "starting" from "stuck")
let vpnRestarting = false   // guards the auto-recovery restart

// ---------- config ----------
const DEFAULT_CONFIG = {
  localPort: 1080,
  singboxPort: 1081,
  bootstrap: ['router.bittorrent.com:6881', 'dht.transmissionbt.com:6881', 'router.utorrent.com:6881'],
  exits: [],
  rules: { direct: [], proxy: [] },
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')) }

// on first run, seed the userData config from the first seed candidate that exists, so the user does
// not have to paste a PSK to start testing
function seedConfigIfMissing() {
  if (fs.existsSync(CONFIG)) return
  for (const src of SEED_CANDIDATES) {
    try {
      const cfg = { ...DEFAULT_CONFIG, ...readJson(src) }
      fs.mkdirSync(path.dirname(CONFIG), { recursive: true })
      fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2))
      pushLog(`[app] seeded config from ${path.basename(src)}`)
      return
    } catch { /* try the next candidate */ }
  }
}

function loadConfig() {
  seedConfigIfMissing()
  try { return { ...DEFAULT_CONFIG, ...readJson(CONFIG) } }
  catch { return { ...DEFAULT_CONFIG } }
}

function saveConfig(cfg) {
  const merged = { ...DEFAULT_CONFIG, ...cfg }
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true })
  fs.writeFileSync(CONFIG, JSON.stringify(merged, null, 2))
  return merged
}

const genPsk = () => crypto.randomBytes(32).toString('hex') // 256-bit random PSK

// ---------- logging / status push ----------
let logReady = false
function ensureLogDir() {
  if (logReady) return
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); logReady = true } catch { /* keep going without a file */ }
}
function pushLog(line) {
  const s = `${new Date().toISOString()} ${line}`
  logBuf.push(s)
  if (logBuf.length > LOG_MAX) logBuf.shift()
  win?.webContents.send('log', s)
  ensureLogDir()
  try { fs.appendFileSync(LOG_FILE, s + '\n') } catch { /* file logging is best-effort */ }
}
function pushStatus() { win?.webContents.send('status', { ...state }) }

// ---------- magnetgate client child ----------
function startClient() {
  if (clientProc) return
  state.lastError = null
  const cfg = loadConfig()
  if (!cfg.exits?.length) { state.lastError = 'no exits configured — add a PSK first'; pushStatus(); return }
  // run the existing client on Electron's own Node runtime (no system Node needed)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  try {
    clientProc = spawn(process.execPath, [CLIENT, CONFIG], { cwd: RES, env, windowsHide: true })
  } catch (e) { state.lastError = `failed to start client: ${e.message}`; pushStatus(); return }

  clientProc.on('error', (e) => {
    state.lastError = e.message
    state.clientRunning = false; clientProc = null; pushStatus()
  })
  const onData = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue
      pushLog(line)
      const m = line.match(/via (reality|hy2|mgt)\b/) || line.match(/\]\s*(reality|hy2|mgt)\b/)
      if (m) { state.route = m[1]; pushStatus() }
      // learn the exit's IP so the VPN can bypass it (else the client uplink loops through the TUN)
      const mh = line.match(/via (?:reality|hy2|mgt): (\d{1,3}(?:\.\d{1,3}){3}):/)
      if (mh) lastExitHost = mh[1]
    }
  }
  clientProc.stdout.on('data', onData)
  clientProc.stderr.on('data', onData)
  clientProc.on('exit', (code) => {
    pushLog(`[app] client exited (code ${code})`)
    state.clientRunning = false; state.route = null; state.egress = null; clientProc = null; pushStatus()
  })
  state.clientRunning = true
  pushLog('[app] magnetgate client started')
  pushStatus()
}

function killTree(pid) {
  // the client spawns its own sing-box (Reality/hy2 supervisor), so kill the whole tree
  return new Promise((resolve) => {
    const t = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    t.on('exit', () => resolve())
    t.on('error', () => resolve())
  })
}

async function stopClient() {
  if (!clientProc) return
  const pid = clientProc.pid
  await killTree(pid)
  clientProc = null
  state.clientRunning = false; state.route = null; state.egress = null
  pushLog('[app] magnetgate client stopped')
  pushStatus()
}

// the exit IP(s) that MUST bypass the TUN, or the client's own uplink to the exit is captured and
// loops back into the SOCKS proxy and nothing connects — from the config bootstrap literals plus the
// exit IP learned at runtime. The packaged launcher can't find the userData config on its own, so the
// app passes these explicitly.
function bypassIps() {
  const ips = new Set()
  const ipRe = /^\d{1,3}(\.\d{1,3}){3}$/
  for (const b of (loadConfig().bootstrap || [])) {
    const h = String(b).split(':')[0]
    if (ipRe.test(h)) ips.add(h)
  }
  if (lastExitHost) ips.add(lastExitHost)
  return [...ips]
}

// ---------- tunnel monitoring (WG conflict + health/auto-recovery) ----------
// sing-box's TUN cannot come up alongside another full tunnel (WireGuard also uses Wintun — it hangs
// on "open interface"). So: refuse to start the VPN while another tunnel is up, auto-stop ours if one
// appears, and — the key UX — when the other tunnel goes away but ours is enabled-yet-not-up, restart
// it so it starts working without the user re-toggling.
function monitorTunnels() {
  const ps = "$mg=[bool](Get-NetAdapter -ea SilentlyContinue|?{$_.Name -eq 'magnetgate' -and $_.Status -eq 'Up'});" +
    "$o=@(Get-NetAdapter -ea SilentlyContinue|?{$_.Status -eq 'Up' -and $_.Name -ne 'magnetgate' -and ($_.InterfaceDescription -match 'WireGuard|OpenVPN|TAP-Windows')}|%{$_.Name});" +
    "[pscustomobject]@{mg=$mg;others=$o}|ConvertTo-Json -Compress"
  const p = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true })
  let out = ''
  p.stdout.on('data', (d) => { out += d.toString() })
  p.on('error', () => {})
  p.on('exit', () => {
    let r; try { r = JSON.parse(out) } catch { return }
    const others = Array.isArray(r.others) ? r.others : (r.others ? [r.others] : [])
    const prevOther = state.otherTunnel
    state.otherTunnel = others[0] || null
    state.vpnHealthy = !!r.mg && state.vpnOn
    // another full tunnel came up while ours is on → stop ours (they conflict)
    if (state.otherTunnel && state.vpnOn) {
      pushLog(`[app] ${state.otherTunnel} is up — stopping the system VPN (two full tunnels conflict)`)
      runVpn(true)
    } else if (state.vpnOn && !state.otherTunnel && !r.mg && !vpnRestarting && Date.now() - vpnEnabledAt > 15000) {
      // enabled, no conflicting tunnel, but our adapter never came up (e.g. WG was on at start and is
      // now off) — restart it so it recovers without a manual re-toggle
      vpnRestarting = true
      pushLog('[app] system VPN did not come up — restarting now that no other tunnel is active')
      runVpn(true)
      setTimeout(() => { runVpn(false); vpnRestarting = false }, 3000)
    }
    if (prevOther !== state.otherTunnel) pushLog(`[app] other tunnel: ${state.otherTunnel || 'none'}`)
    pushStatus()
  })
}

// ---------- system VPN (sing-box TUN), elevated on demand ----------
function runVpn(off) {
  if (!off && state.otherTunnel) {
    state.lastError = `turn off ${state.otherTunnel} first — the system VPN can't share Wintun with another full tunnel`
    pushLog(`[app] refusing to start VPN: ${state.otherTunnel} is active`)
    pushStatus()
    return
  }
  if (!off) vpnEnabledAt = Date.now()
  const ips = off ? [] : bypassIps()
  const bypassArg = ips.length ? ` -Bypass ${ips.join(',')}` : ''
  // elevate the TUN launcher via UAC; the app stays unprivileged
  const args = `-NoProfile -ExecutionPolicy Bypass -File "${VPN_PS1}" -LogDir "${LOG_DIR}"${bypassArg}` + (off ? ' -Off' : '')
  const inner = args.replace(/'/g, "''")
  const cmd = `Start-Process -Verb RunAs -FilePath 'powershell.exe' -ArgumentList '${inner}'`
  const p = spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true })
  p.on('error', (e) => { state.lastError = `VPN launch failed: ${e.message}`; pushStatus() })
  state.vpnOn = !off
  if (!off && !ips.length) state.lastError = 'no exit IP to bypass yet — start the client and wait for a route first'
  pushLog(`[app] system VPN ${off ? 'stopping' : `starting (bypass: ${ips.join(', ') || 'NONE!'})`} — approve UAC if prompted`)
  pushStatus()
}

// ---------- egress status polling (through the client SOCKS) ----------
function pollEgress() {
  if (!state.clientRunning) { if (state.egress) { state.egress = null; pushStatus() } return }
  const { localPort } = loadConfig()
  const c = spawn('curl.exe', ['-s', '--socks5-hostname', `127.0.0.1:${localPort}`, '--max-time', '8', 'http://checkip.amazonaws.com/'], { windowsHide: true })
  let out = ''
  c.stdout.on('data', (d) => { out += d.toString() })
  c.on('error', () => {})
  c.on('exit', () => {
    const ip = (out.match(/\d{1,3}(\.\d{1,3}){3}/) || [])[0] || null
    if (ip !== state.egress) { state.egress = ip; pushStatus() }
  })
}

// ---------- IPC ----------
ipcMain.handle('getState', () => ({ ...state }))
ipcMain.handle('getLog', () => logBuf.slice())
ipcMain.handle('getConfig', () => loadConfig())
ipcMain.handle('saveConfig', (_e, cfg) => saveConfig(cfg))
ipcMain.handle('genPsk', () => genPsk())
ipcMain.handle('startClient', () => { startClient() })
ipcMain.handle('stopClient', async () => { await stopClient() })
ipcMain.handle('vpnOn', () => { runVpn(false) })
ipcMain.handle('vpnOff', () => { runVpn(true) })
ipcMain.handle('openConfigDir', () => shell.openPath(path.dirname(CONFIG)))
ipcMain.handle('openLogs', () => { ensureLogDir(); return shell.openPath(LOG_DIR) })
ipcMain.handle('getLogPath', () => LOG_FILE)

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 780, height: 620, minWidth: 620, minHeight: 480,
    title: 'magnetgate',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  win.removeMenu()
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.on('did-finish-load', () => { pushStatus() })
}

app.whenReady().then(() => {
  pushLog(`[app] === magnetgate app ${app.getVersion()} started; logs -> ${LOG_FILE} ===`)
  createWindow()
  setInterval(pollEgress, 5000)
  monitorTunnels(); setInterval(monitorTunnels, 4000)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', async () => {
  await stopClient()
  app.quit()
})
