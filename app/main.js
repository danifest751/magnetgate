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
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

// Clash API (loopback) that the TUN sing-box exposes for live stats
const CLASH_PORT = 19090
const CLASH_SECRET = crypto.randomBytes(16).toString('hex')

// Well-known RU resources that reject datacenter/VPN IPs ("turn off VPN") — always routed DIRECT on
// the real residential IP, on top of the community rule-set and the user's own additions. RU-domestic
// majors are included too (they don't need the tunnel and often block it).
const DEFAULT_DIRECT = [
  // marketplaces
  'ozon.ru', 'ozone.ru', 'wildberries.ru', 'wb.ru', 'wbbasket.ru', 'avito.ru', 'avito.st',
  'megamarket.ru', 'sbermegamarket.ru', 'lamoda.ru', 'dns-shop.ru', 'mvideo.ru', 'eldorado.ru',
  'citilink.ru', 'market.yandex.ru',
  // banks
  'sber.ru', 'sberbank.ru', 'alfabank.ru', 'tinkoff.ru', 'tbank.ru', 'vtb.ru', 'gazprombank.ru',
  'gpb.ru', 'raiffeisen.ru', 'psbank.ru', 'pochtabank.ru', 'sovcombank.ru', 'mkb.ru', 'open.ru',
  'rshb.ru', 'rosbank.ru',
  // gov
  'gosuslugi.ru', 'gov.ru', 'mos.ru', 'nalog.ru', 'nalog.gov.ru', 'pfr.gov.ru', 'sfr.gov.ru',
  'fss.ru', 'mvd.ru', 'rosreestr.gov.ru', 'rkn.gov.ru', 'mchs.gov.ru',
  // telecom
  'mts.ru', 'megafon.ru', 'beeline.ru', 'tele2.ru', 't2.ru', 'rt.ru',
  // streaming / cinema
  'kinopoisk.ru', 'okko.tv', 'wink.ru', 'ivi.ru', 'premier.one', 'start.ru', 'more.tv', 'kion.ru',
  'rutube.ru', 'smotrim.ru',
  // services / messengers
  'vk.com', 'vk.ru', 'vkontakte.ru', 'userapi.com', 'mail.ru', 'ok.ru', 'dzen.ru', 'max.ru', 'pochta.ru',
]

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
let quitting = false
const timers = []
let clientProc = null
let lastExitHost = null // exit IP learned from client logs, bypassed by the VPN
const logBuf = []
const state = { clientRunning: false, route: null, egress: null, vpnOn: false, lastError: null,
  otherTunnel: null, vpnHealthy: false,
  stats: { conns: 0, up: 0, down: 0, upBps: 0, downBps: 0 } }
let lastSample = null // { t, up, down } for speed calc
let vpnEnabledAt = 0        // when the user last enabled the VPN (to tell "starting" from "stuck")
let vpnRestarting = false   // guards the auto-recovery restart
let vpnRestartCount = 0     // caps auto-recovery so a persistent failure doesn't loop the UAC window

// ---------- config ----------
const DEFAULT_CONFIG = {
  localPort: 1080,
  singboxPort: 1081,
  bootstrap: ['router.bittorrent.com:6881', 'dht.transmissionbt.com:6881', 'router.utorrent.com:6881'],
  exits: [],
  rules: { direct: [], proxy: [] },
  vpnMode: 'full',   // 'full' = all via exit (direct exceptions); 'split' = direct default, list via exit
  directDomains: [], // full mode: user domains that bypass the VPN (direct on the real IP)
  tunnelDomains: [], // split mode: user domains forced THROUGH the exit
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
// send to the renderer only if the window still exists — child-process exit handlers can fire after
// the window is destroyed, and `win?.` guards null but not a destroyed webContents
function safeSend(channel, payload) {
  if (quitting || !win || win.isDestroyed()) return
  try { win.webContents.send(channel, payload) } catch { /* window went away mid-send */ }
}
function pushLog(line) {
  const s = `${new Date().toISOString()} ${line}`
  logBuf.push(s)
  if (logBuf.length > LOG_MAX) logBuf.shift()
  safeSend('log', s)
  ensureLogDir()
  try { fs.appendFileSync(LOG_FILE, s + '\n') } catch { /* file logging is best-effort */ }
}
function pushStatus() { safeSend('status', { ...state }) }

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
  // broadly detect ANY other VPN/tunnel adapter (not just WireGuard): any UP adapter besides
  // magnetgate whose description names a tunnel/VPN engine, or that carries a default route with an
  // on-link next hop (the generic full-tunnel signature). Physical NICs (Ethernet/Wi-Fi) don't match.
  const rx = 'WireGuard|OpenVPN|TAP|Wintun|WARP|Cloudflare|Amnezia|Outline|Hiddify|Nekoray|Xray|v2ray|Clash|Mihomo|Proton|Nord|ExpressVPN|Surfshark|sing-tun|VPN|Tunnel'
  const ps = "$mg=[bool](Get-NetAdapter -ea SilentlyContinue|?{$_.Name -eq 'magnetgate' -and $_.Status -eq 'Up'});" +
    "$byDesc=@(Get-NetAdapter -ea SilentlyContinue|?{$_.Status -eq 'Up' -and $_.Name -ne 'magnetgate' -and ($_.InterfaceDescription -match '" + rx + "')}|%{$_.Name});" +
    "$rtIdx=@(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ea SilentlyContinue|?{$_.NextHop -eq '0.0.0.0'}|%{$_.ifIndex});" +
    "$byRoute=@(Get-NetAdapter -ea SilentlyContinue|?{$_.Status -eq 'Up' -and $_.Name -ne 'magnetgate' -and $rtIdx -contains $_.ifIndex}|%{$_.Name});" +
    "$o=@($byDesc+$byRoute|Select-Object -Unique);" +
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
    if (r.mg) vpnRestartCount = 0 // came up fine → reset the recovery budget
    // another full tunnel came up while ours is on → stop ours (they conflict)
    if (state.otherTunnel && state.vpnOn) {
      pushLog(`[app] ${state.otherTunnel} is up — stopping the system VPN (two full tunnels conflict)`)
      runVpn(true)
    } else if (state.vpnOn && !state.otherTunnel && !r.mg && !vpnRestarting && Date.now() - vpnEnabledAt > 15000) {
      // enabled, no conflicting tunnel, but our adapter never came up (e.g. WG was on at start and is
      // now off) — restart it so it recovers without a manual re-toggle, but only a couple of times
      if (vpnRestartCount >= 2) {
        state.lastError = 'system VPN failed to come up — check the logs (Open logs folder)'
        state.vpnOn = false; pushStatus(); return
      }
      vpnRestartCount++
      vpnRestarting = true
      pushLog(`[app] system VPN did not come up — restarting (attempt ${vpnRestartCount})`)
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
  if (!off) { vpnEnabledAt = Date.now(); if (!vpnRestarting) vpnRestartCount = 0 }
  const ips = off ? [] : bypassIps()
  const bypassArg = ips.length ? ` -Bypass ${ips.join(',')}` : ''
  const clashArg = off ? '' : ` -ClashPort ${CLASH_PORT} -ClashSecret ${CLASH_SECRET}`
  const cfg = off ? {} : loadConfig()
  const mode = cfg.vpnMode === 'split' ? 'split' : 'full'
  const clean = (a) => [...new Set((a || []).map((d) => String(d).trim()).filter(Boolean))]
  let modeArg = ''
  if (!off) {
    modeArg = ` -Mode ${mode}`
    if (mode === 'full') {
      const doms = clean([...DEFAULT_DIRECT, ...(cfg.directDomains || [])])
      if (doms.length) modeArg += ` -DirectDomains ${doms.join(',')}`
    } else {
      const doms = clean(cfg.tunnelDomains)
      if (doms.length) modeArg += ` -TunnelDomains ${doms.join(',')}`
    }
  }
  // elevate the TUN launcher via UAC; the app stays unprivileged
  const args = `-NoProfile -ExecutionPolicy Bypass -File "${VPN_PS1}" -LogDir "${LOG_DIR}"${bypassArg}${clashArg}${modeArg}` + (off ? ' -Off' : '')
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

// ---------- live stats via the TUN sing-box Clash API ----------
function pollStats() {
  if (!(state.vpnOn && state.vpnHealthy)) {
    if (state.stats.conns || state.stats.up || state.stats.down) {
      state.stats = { conns: 0, up: 0, down: 0, upBps: 0, downBps: 0 }; lastSample = null; pushStatus()
    }
    return
  }
  const req = http.get({ host: '127.0.0.1', port: CLASH_PORT, path: '/connections',
    headers: { Authorization: `Bearer ${CLASH_SECRET}` }, timeout: 2500 }, (res) => {
    let body = ''
    res.on('data', (d) => { body += d })
    res.on('end', () => {
      let j; try { j = JSON.parse(body) } catch { return }
      const up = j.uploadTotal || 0, down = j.downloadTotal || 0
      const conns = Array.isArray(j.connections) ? j.connections.length : 0
      const now = Date.now()
      if (lastSample) {
        const dt = (now - lastSample.t) / 1000
        if (dt > 0) { state.stats.upBps = Math.max(0, (up - lastSample.up) / dt); state.stats.downBps = Math.max(0, (down - lastSample.down) / dt) }
      }
      lastSample = { t: now, up, down }
      state.stats.up = up; state.stats.down = down; state.stats.conns = conns
      pushStatus()
    })
  })
  req.on('error', () => {})
  req.on('timeout', () => req.destroy())
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
  win.on('closed', () => { win = null })
}

app.whenReady().then(() => {
  pushLog(`[app] === magnetgate app ${app.getVersion()} started; logs -> ${LOG_FILE} ===`)
  createWindow()
  timers.push(setInterval(pollEgress, 5000))
  monitorTunnels(); timers.push(setInterval(monitorTunnels, 4000))
  timers.push(setInterval(pollStats, 2000))
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('before-quit', () => { quitting = true; for (const t of timers) clearInterval(t) })

app.on('window-all-closed', async () => {
  quitting = true
  for (const t of timers) clearInterval(t)
  await stopClient()
  app.quit()
})

// last-resort: never let a stray async error pop Electron's crash dialog; log it instead
process.on('uncaughtException', (e) => { try { pushLog(`[app] uncaught: ${e && e.stack || e}`) } catch {} })
process.on('unhandledRejection', (e) => { try { pushLog(`[app] unhandledRejection: ${e && e.stack || e}`) } catch {} })
