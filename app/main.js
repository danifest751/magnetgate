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
const LOG_MAX = 500

let win = null
let clientProc = null
const logBuf = []
const state = { clientRunning: false, route: null, egress: null, vpnOn: false, lastError: null }

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
function pushLog(line) {
  const s = `${new Date().toISOString()} ${line}`
  logBuf.push(s)
  if (logBuf.length > LOG_MAX) logBuf.shift()
  win?.webContents.send('log', s)
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

// ---------- system VPN (sing-box TUN), elevated on demand ----------
function runVpn(off) {
  // elevate the TUN launcher via UAC; the app stays unprivileged
  const args = `-NoProfile -ExecutionPolicy Bypass -File "${VPN_PS1}"` + (off ? ' -Off' : '')
  const inner = args.replace(/'/g, "''")
  const cmd = `Start-Process -Verb RunAs -FilePath 'powershell.exe' -ArgumentList '${inner}'`
  const p = spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true })
  p.on('error', (e) => { state.lastError = `VPN launch failed: ${e.message}`; pushStatus() })
  state.vpnOn = !off
  pushLog(`[app] system VPN ${off ? 'stopping' : 'starting'} (elevated) — approve the UAC prompt`)
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
  createWindow()
  setInterval(pollEgress, 5000)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', async () => {
  await stopClient()
  app.quit()
})
