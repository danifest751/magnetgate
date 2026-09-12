// magnetgate desktop app — Electron main process.
//
// UI-only Electron shell around the existing magnetgate client:
//  - the rendezvous/SOCKS/fail-over client (../src/client.js) runs on Electron's own Node runtime
//    (process.execPath + ELECTRON_RUN_AS_NODE=1), so the app is self-contained — no system Node
//    needed. This is safe because the only native dep (sodium-native) ships N-API prebuilds, which
//    are ABI-stable across Node/Electron versions;
//  - the app runs elevated (requireAdministrator manifest — one UAC at launch) and manages the
//    sing-box TUN directly as a hidden child process: no per-toggle UAC, no console windows, instant
//    clean start/stop, and its config is generated in-process (buildVpnConfig);
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

// resource root: repo root in dev, the packaged resources dir otherwise
const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
const CLIENT = path.join(RES, 'src', 'client.js')
// first-run seed for the user config: the bundled seed-config.json (real PSK/exits) if present,
// else the repo config in dev, else the PSK-less example.
const SEED_CANDIDATES = [
  path.join(RES, 'seed-config.json'),
  path.join(RES, 'magnetgate.config.json'),
  path.join(RES, 'magnetgate.config.example.json'),
]
const CONFIG = path.join(app.getPath('userData'), 'magnetgate.config.json')
// the rendezvous client (spawned in rendezvous-only mode) writes the live data-plane endpoints here;
// the app builds the TUN sing-box config directly from them — one engine, data path TUN->reality->exit.
const DP_FILE = path.join(app.getPath('userData'), 'current-dp.json')
// everything (app events + the client's stdout/stderr) is appended here so a field test can be read
// back afterwards; the sing-box TUN logs into the same folder (see the VPN launcher's -LogDir).
const LOG_DIR = path.join(app.getPath('userData'), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'magnetgate.log')
const LOG_MAX = 500

let win = null
let quitting = false
const timers = []
let clientProc = null
let vpnProc = null // the sing-box TUN process (managed directly; app runs elevated)
let lastExitHost = null // exit IP learned from client logs, bypassed by the VPN
const logBuf = []
const state = { clientRunning: false, route: null, egress: null, vpnOn: false, lastError: null,
  otherTunnel: null, vpnHealthy: false, rvReady: false, phase: 'idle',
  stats: { conns: 0, up: 0, down: 0, upBps: 0, downBps: 0 } }
let lastSample = null // { t, up, down } for speed calc
let curDpSig = null   // signature of the data-plane last applied to the TUN sing-box (rotation detection)
let vpnChain = Promise.resolve() // serializes VPN (re)launches so a dp change can't race a start
let otherTunnelClearedAt = 0 // when another Wintun tunnel (WG) last went away — we let Wintun settle after

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
// One coarse connection phase for the UI, derived from the internal state so it is always accurate:
//  blocked   — another full tunnel (WireGuard) is up; can't connect until it's off
//  idle      — not connecting
//  rendezvous— connecting: rendezvous client up, still finding the exit / waiting for a data plane
//  starting  — connecting: the tunnel engine (sing-box) is up, waiting for it to carry traffic
//  connected — traffic confirmed flowing through the exit (egress probe succeeded)
function computePhase() {
  if (!state.vpnOn) return state.otherTunnel ? 'blocked' : 'idle'
  if (state.vpnHealthy) return 'connected'
  if (vpnProc) return 'starting'
  return 'rendezvous'
}
function pushStatus() { state.phase = computePhase(); safeSend('status', { ...state }) }

// ---------- magnetgate client child ----------
function startClient() {
  if (clientProc) return
  state.lastError = null
  const cfg = loadConfig()
  if (!cfg.exits?.length) { state.lastError = 'no exits configured — add a PSK first'; pushStatus(); return }
  // start fresh: drop any stale endpoints from a previous run so the VPN waits for a live result
  try { fs.unlinkSync(DP_FILE) } catch { /* none */ }
  curDpSig = null; state.rvReady = false
  // run the client in rendezvous-only mode on Electron's own Node runtime (no system Node needed):
  // it only discovers exits and writes the data-plane endpoints to DP_FILE — no SOCKS, no 2nd sing-box.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', MAGNETGATE_RENDEZVOUS_ONLY: '1', MAGNETGATE_DP_OUT: DP_FILE }
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

// read the current data-plane endpoints the rendezvous client published (null until the first offer)
function readDp() {
  try {
    const o = JSON.parse(fs.readFileSync(DP_FILE, 'utf8').replace(/^﻿/, ''))
    return Array.isArray(o?.dp) ? o.dp : null
  } catch { return null }
}

// the exit IP(s) that MUST bypass the TUN, or the reality/hy2 handshake to the exit is itself captured
// by the TUN and loops — nothing connects. Sources: the data-plane endpoint hosts (the exit IP), the
// config's IP-literal DHT bootstraps, and the exit IP seen in client logs.
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/
function bypassIps(dp) {
  const ips = new Set()
  for (const d of (dp || [])) { if (d.host && IP_RE.test(d.host)) ips.add(d.host) }
  for (const b of (loadConfig().bootstrap || [])) {
    const h = String(b).split(':')[0]
    if (IP_RE.test(h)) ips.add(h)
  }
  if (lastExitHost) ips.add(lastExitHost)
  return [...ips]
}

// ---------- tunnel monitoring (WG conflict + health/auto-recovery) ----------
// sing-box's TUN cannot come up alongside another full tunnel (WireGuard also uses Wintun — it hangs
// on "open interface"). So: refuse to start the VPN while another tunnel is up, auto-stop ours if one
// appears, and — the key UX — when the other tunnel goes away but ours is enabled-yet-not-up, restart
// it so it starts working without the user re-toggling.
// broadly detect ANY other VPN/tunnel adapter (not just WireGuard): any UP adapter besides
// magnetgate whose description names a tunnel/VPN engine, or that carries a default route with an
// on-link next hop (the generic full-tunnel signature). Physical NICs (Ethernet/Wi-Fi) don't match.
function checkTunnels() {
  const rx = 'WireGuard|OpenVPN|TAP|Wintun|WARP|Cloudflare|Amnezia|Outline|Hiddify|Nekoray|Xray|v2ray|Clash|Mihomo|Proton|Nord|ExpressVPN|Surfshark|sing-tun|VPN|Tunnel'
  const ps = "$mg=[bool](Get-NetAdapter -ea SilentlyContinue|?{$_.Name -eq 'magnetgate' -and $_.Status -eq 'Up'});" +
    "$byDesc=@(Get-NetAdapter -ea SilentlyContinue|?{$_.Status -eq 'Up' -and $_.Name -ne 'magnetgate' -and ($_.InterfaceDescription -match '" + rx + "')}|%{$_.Name});" +
    "$rtIdx=@(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ea SilentlyContinue|?{$_.NextHop -eq '0.0.0.0'}|%{$_.ifIndex});" +
    "$byRoute=@(Get-NetAdapter -ea SilentlyContinue|?{$_.Status -eq 'Up' -and $_.Name -ne 'magnetgate' -and $rtIdx -contains $_.ifIndex}|%{$_.Name});" +
    "$o=@($byDesc+$byRoute|Select-Object -Unique);" +
    "[pscustomobject]@{mg=$mg;others=$o}|ConvertTo-Json -Compress"
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => { out += d.toString() })
    p.on('error', () => resolve(null))
    p.on('exit', () => {
      let r; try { r = JSON.parse(out) } catch { return resolve(null) }
      const others = Array.isArray(r.others) ? r.others : (r.others ? [r.others] : [])
      resolve({ mg: !!r.mg, others })
    })
  })
}

async function monitorTunnels() {
  const r = await checkTunnels()
  if (!r) return
  const prevOther = state.otherTunnel
  state.otherTunnel = r.others[0] || null
  // vpnHealthy is driven by the egress probe (actual connectivity), not adapter-name detection here
  // if another full tunnel appears while ours is on, stop ours (they can't share Wintun). We do NOT
  // auto-restart on a slow/absent adapter: Wintun creation can legitimately take many seconds, and
  // killing it mid-open just loops. The pre-start check already blocks enabling while a tunnel is up.
  if (state.otherTunnel && state.vpnOn) {
    pushLog(`[app] ${state.otherTunnel} is up — stopping the system VPN (two full tunnels conflict)`)
    runVpn(true)
  }
  if (prevOther !== state.otherTunnel) {
    if (prevOther && !state.otherTunnel) otherTunnelClearedAt = Date.now() // WG/other just torn down
    pushLog(`[app] other tunnel: ${state.otherTunnel || 'none'}`)
  }
  pushStatus()
}

// Reality / hysteria2 outbounds built straight from an offer's data-plane endpoint (same schema the
// standalone client's dp-supervisor uses — proven in prod). Tag is assigned by the caller.
function realityOutbound(dp) {
  return {
    type: 'vless', server: dp.host, server_port: dp.port, uuid: dp.uuid, flow: 'xtls-rprx-vision',
    tls: {
      enabled: true, server_name: dp.sni,
      utls: { enabled: true, fingerprint: dp.fp || 'chrome' },
      reality: { enabled: true, public_key: dp.pbk, short_id: dp.sid },
    },
  }
}
function hy2Outbound(dp) {
  const tls = { enabled: true, alpn: ['h3'] }
  if (dp.ca) { tls.certificate = Array.isArray(dp.ca) ? dp.ca : [dp.ca]; if (dp.sni) tls.server_name = dp.sni }
  else tls.insecure = true
  return { type: 'hysteria2', server: dp.host, server_port: dp.port, password: dp.pw, obfs: { type: 'salamander', password: dp.obfs }, tls }
}

// Build the sing-box TUN config in-process (the app runs elevated, so it manages sing-box directly —
// no PowerShell console, no per-toggle UAC). ONE engine: the TUN sing-box dials Reality/hysteria2 to
// the exit itself (built from `dp`), so the data path is just TUN -> sing-box -> reality -> exit.
// full: everything via the exit + a direct exception list; split: direct by default + only the
// blocked/geo-restricted list via the exit.
function buildVpnConfig({ mode, dp, bypass, clashPort, clashSecret, directDomains, tunnelDomains, logOut }) {
  const TOOLS = path.join(RES, 'tools', 'sing-box')
  const rs = (tag, file) => {
    const p = path.join(TOOLS, file)
    return fs.existsSync(p) ? { type: 'local', tag, format: 'binary', path: p.replace(/\\/g, '/') } : null
  }
  // camouflage outbounds to the exit, in preference order; 'proxy' is the entry the route rules use.
  const camo = []
  const reality = (dp || []).find((d) => d.t === 'reality'); if (reality) camo.push({ tag: 'reality', ...realityOutbound(reality) })
  const hy2 = (dp || []).find((d) => d.t === 'hy2'); if (hy2) camo.push({ tag: 'hy2', ...hy2Outbound(hy2) })
  const proxyOutbounds = []
  if (camo.length > 1) {
    proxyOutbounds.push(...camo, { tag: 'proxy', type: 'urltest', outbounds: camo.map((c) => c.tag), url: 'https://www.gstatic.com/generate_204', interval: '3m' })
  } else if (camo.length === 1) {
    proxyOutbounds.push({ ...camo[0], tag: 'proxy' }) // single endpoint: tag it 'proxy' directly, no urltest
  } // camo.length === 0 is guarded by the caller (applyVpn waits for a data plane)

  const ruleSets = []
  const rules = [{ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' }]
  // the magnetgate client (this app's own process) must bypass the TUN so its rendezvous (DHT/Nostr)
  // stays independent of tunnel health — the tunnel is now sing-box itself, not the client.
  rules.push({ process_name: ['magnetgate.exe'], action: 'route', outbound: 'direct' })
  if (bypass?.length) rules.push({ ip_cidr: bypass.map((i) => `${i}/32`), action: 'route', outbound: 'direct' })
  let final
  if (mode === 'split') {
    final = 'direct'
    const tags = []
    for (const [tag, file] of [['blk-dom', 'refilter-domains.srs'], ['blk-ip', 'refilter-ip.srs'], ['usr', 'tunnel-userlist.srs']]) {
      const r = rs(tag, file); if (r) { ruleSets.push(r); tags.push(tag) }
    }
    if (tags.length) rules.push({ rule_set: tags, action: 'route', outbound: 'proxy' })
    if (tunnelDomains?.length) rules.push({ domain_suffix: tunnelDomains, action: 'route', outbound: 'proxy' })
  } else {
    final = 'proxy'
    const r = rs('ru-inside', 'itdoginfo-inside-russia.srs')
    if (r) { ruleSets.push(r); rules.push({ rule_set: ['ru-inside'], action: 'route', outbound: 'direct' }) }
    if (directDomains?.length) rules.push({ domain_suffix: directDomains, action: 'route', outbound: 'direct' })
  }
  rules.push({ ip_is_private: true, action: 'route', outbound: 'direct' })
  rules.push({ ip_version: 6, action: 'reject' })
  return {
    log: { level: 'info', timestamp: true, ...(logOut ? { output: logOut } : {}) },
    ...(clashPort ? { experimental: { clash_api: { external_controller: `127.0.0.1:${clashPort}`, secret: clashSecret } } } : {}),
    dns: { servers: [{ tag: 'proxy-dns', type: 'https', server: '1.1.1.1', detour: 'proxy' }], strategy: 'ipv4_only' },
    // gVisor userspace TCP/IP stack: on Windows the 'system' stack does not deliver TUN-inbound TCP
    // to routing (UDP/QUIC and sing-box's own DoH work, but app TCP connections stall with no outbound
    // — verified in the field), so TCP browsing fails. gVisor handles TCP in userspace and is the
    // reliable choice on Windows (Hiddify/Nekoray default). The reality outbound itself carries TCP
    // fine (verified via a SOCKS+reality probe: checkip returned the exit IP, HTTPS loaded).
    inbounds: [{ type: 'tun', tag: 'tun-in', interface_name: 'magnetgate', address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'], mtu: 1400, auto_route: true, strict_route: true, stack: 'gvisor' }],
    outbounds: [...proxyOutbounds, { type: 'direct', tag: 'direct' }],
    route: { ...(ruleSets.length ? { rule_set: ruleSets } : {}), rules, final, auto_detect_interface: true, default_domain_resolver: 'proxy-dns' },
  }
}

// ---------- system VPN (sing-box TUN), managed directly (app runs elevated) ----------
const SB_DIR = path.join(RES, 'tools', 'sing-box')
const SB_EXE = path.join(SB_DIR, 'sing-box.exe')
const VPN_CFG = path.join(LOG_DIR, 'vpn-config.json')

function sbCheck(cfgPath) {
  return new Promise((resolve) => {
    const c = spawn(SB_EXE, ['check', '-c', cfgPath], { cwd: SB_DIR, windowsHide: true })
    let err = ''
    c.stderr.on('data', (d) => { err += d })
    c.on('error', (e) => resolve(`check spawn failed: ${e.message}`))
    c.on('exit', (code) => resolve(code ? (err.trim().split(/\r?\n/).pop() || 'invalid config') : null))
  })
}

// Clear stale TUN state before (re)starting sing-box. The "create adapter: Cannot create a file when
// that file already exists | open existing adapter: Element not found" failure comes from a Wintun
// adapter left behind by a hard-killed sing-box, OR from the Wintun driver still settling right after
// another Wintun tunnel (e.g. WireGuard) was torn down. So: kill any orphan sing-box (releasing its
// adapter), remove a lingering 'magnetgate' adapter outright (pnputil, we run elevated), and let the
// driver settle briefly. Best-effort and quick; never throws.
function cleanupStaleTun() {
  return new Promise((resolve) => {
    const ps = [
      "Get-Process sing-box -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue;",
      "$a = Get-NetAdapter -Name 'magnetgate' -ErrorAction SilentlyContinue;",
      "foreach ($d in $a) { if ($d.PnPDeviceID) { try { & pnputil.exe /remove-device $d.PnPDeviceID | Out-Null } catch {} } }",
      "Start-Sleep -Milliseconds 800",
    ].join(' ')
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true })
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    p.on('error', finish)
    p.on('exit', finish)
    setTimeout(finish, 6000) // never block the launch for long
  })
}

// User intent (the toggle). Turning on ensures the rendezvous client is running and records the
// intent; the actual engine launch is applyVpn, which may have to wait for the first data plane.
async function runVpn(off) {
  if (off) {
    state.vpnOn = false
    if (vpnProc) { const pid = vpnProc.pid; vpnProc = null; await killTree(pid) }
    state.vpnHealthy = false
    pushLog('[app] system VPN stopped')
    pushStatus()
    return
  }
  // block if another full tunnel is up (they can't share Wintun) — checked synchronously at click
  const r = await checkTunnels()
  const other = r && r.others[0]
  if (other) {
    state.otherTunnel = other
    state.lastError = `turn off ${other} first — the system VPN can't share Wintun with another full tunnel`
    pushLog(`[app] refusing to start VPN: ${other} is active`)
    pushStatus(); return
  }
  state.otherTunnel = null
  // the data plane comes from the rendezvous client — make sure it's running to publish endpoints
  if (!clientProc) { pushLog('[app] starting the rendezvous client for the VPN'); startClient() }
  state.vpnOn = true; state.lastError = null
  // if another Wintun tunnel (WireGuard) was just torn down, the driver needs a moment before it can
  // create ours — otherwise the first start hangs ~16s and fails ("create adapter ... already exists").
  const sinceCleared = Date.now() - otherTunnelClearedAt
  if (otherTunnelClearedAt && sinceCleared < 6000) {
    const waitMs = 6000 - sinceCleared
    pushLog(`[app] letting Wintun settle after the previous tunnel (${Math.round(waitMs / 1000)}s)…`)
    pushStatus()
    await new Promise((r) => setTimeout(r, waitMs))
    if (!state.vpnOn) return // turned off while waiting
  }
  await applyVpn('user enabled')
  pushStatus()
}

// (re)launch the TUN sing-box for the CURRENT data plane. Serialized on vpnChain so a rotation/dp
// change can't race the initial start. No-op unless the user intent (state.vpnOn) is set; if no data
// plane has been published yet it logs "waiting" and returns — the dp watcher calls it again once the
// client publishes endpoints (or on rotation).
function applyVpn(reason) {
  vpnChain = vpnChain.then(() => _applyVpn(reason)).catch((e) => { pushLog(`[app] applyVpn error: ${e.message}`) })
  return vpnChain
}

async function _applyVpn(reason) {
  if (!state.vpnOn) return // turned off while queued
  const dp = readDp()
  const camo = (dp || []).filter((d) => d.t === 'reality' || d.t === 'hy2')
  if (!camo.length) {
    state.vpnHealthy = false
    pushLog('[app] system VPN: waiting for rendezvous (no data plane yet)…')
    pushStatus(); return
  }
  // tear down any running engine first (rotation / dp change / mode change all relaunch cleanly)
  if (vpnProc) { const pid = vpnProc.pid; vpnProc = null; await killTree(pid) }

  const cfg = loadConfig()
  const mode = cfg.vpnMode === 'split' ? 'split' : 'full'
  const clean = (a) => [...new Set((a || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))]
  const ips = bypassIps(dp)
  const conf = buildVpnConfig({
    mode, dp, bypass: ips,
    clashPort: CLASH_PORT, clashSecret: CLASH_SECRET,
    directDomains: clean(cfg.directDomains), tunnelDomains: clean(cfg.tunnelDomains),
    logOut: path.join(LOG_DIR, 'vpn.log').replace(/\\/g, '/'),
  })
  ensureLogDir()
  try { fs.writeFileSync(VPN_CFG, JSON.stringify(conf, null, 2)) } catch (e) { state.lastError = `config write failed: ${e.message}`; pushStatus(); return }

  const bad = await sbCheck(VPN_CFG)
  if (bad) { state.lastError = `config invalid: ${bad}`; pushLog(`[app] sing-box check failed: ${bad}`); pushStatus(); return }

  curDpSig = JSON.stringify(dp) // mark this data plane as applied (dedupes the watcher)
  const MAX_TUN_RETRIES = 3
  let tunRetries = 0
  const launch = () => {
    let sawTunErr = false
    let proc
    try { proc = spawn(SB_EXE, ['run', '-c', VPN_CFG], { cwd: SB_DIR, windowsHide: true }) }
    catch (e) { state.lastError = `VPN start failed: ${e.message}`; state.vpnOn = false; vpnProc = null; pushStatus(); return }
    vpnProc = proc
    const onOut = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue
        pushLog(`[vpn] ${line}`)
        if (/configure tun interface|initialization has already|create adapter|open.*adapter/i.test(line)) sawTunErr = true
      }
    }
    proc.stdout.on('data', onOut)
    proc.stderr.on('data', onOut)
    proc.on('error', (e) => { if (vpnProc !== proc) return; state.lastError = e.message; state.vpnOn = false; vpnProc = null; pushStatus() })
    proc.on('exit', (code) => {
      if (vpnProc !== proc) return // intentional stop/relaunch (vpnProc nulled first)
      vpnProc = null
      pushLog(`[app] sing-box exited (code ${code})`)
      // the Wintun adapter can be busy/stale — from a hard-killed previous sing-box, or the driver
      // still settling right after another Wintun tunnel (WireGuard) was torn down. It clears within
      // a few seconds, so re-clean and retry a few times (keeping the UI in "starting") before giving up.
      if (code && sawTunErr && tunRetries < MAX_TUN_RETRIES && state.vpnOn) {
        tunRetries++
        pushLog(`[app] TUN adapter busy — cleaning up and retrying (${tunRetries}/${MAX_TUN_RETRIES})`)
        cleanupStaleTun().then(() => { if (state.vpnOn) launch() })
        return
      }
      if (state.vpnOn && code) state.lastError = sawTunErr
        ? 'could not create the TUN adapter — turn off any other VPN/WireGuard and try again'
        : `VPN stopped (code ${code}) — see the log`
      state.vpnOn = false; state.vpnHealthy = false; pushStatus()
    })
  }
  state.lastError = null
  pushLog(`[app] system VPN ${reason ? `(${reason}) ` : ''}starting [mode=${mode}, dp=${camo.map((c) => c.t).join('+')}, bypass=${ips.join(',') || 'none'}]`)
  await cleanupStaleTun() // clear any stale 'magnetgate' adapter so the first start succeeds cleanly
  if (!state.vpnOn) return // turned off during cleanup
  launch()
  pushStatus()
}

// watch the rendezvous client's published endpoints; start/relaunch the engine on the first data
// plane and on rotation (a creds change). Polling is robust against fs.watch's win32 rename quirks.
function onDpTick() {
  const dp = readDp()
  if (!dp) return // nothing published yet, or briefly gone — keep any running tunnel as-is
  const sig = JSON.stringify(dp)
  if (sig === curDpSig) return
  curDpSig = sig
  state.rvReady = true
  pushLog(`[app] rendezvous data plane: ${dp.map((d) => d.t).join('+')}`)
  if (state.vpnOn) applyVpn('data plane changed')
  pushStatus()
}

// ---------- egress status polling ----------
// The one-engine app has no client SOCKS to probe, so we curl checkip directly: curl.exe is not the
// bypassed magnetgate.exe, so when the VPN is up its traffic rides the TUN and reports the EXIT IP.
// This probe is now the AUTHORITATIVE health signal: it runs whenever the sing-box process is alive
// (not gated on adapter-name detection, which is fragile — 'magnetgate' may not be the adapter's
// Get-NetAdapter Name), and a successful result both fills the egress IP and marks the VPN healthy.
// So the egress IP appears exactly when the tunnel actually carries TCP — no dependency on how Windows
// names the Wintun adapter.
function pollEgress() {
  if (!(state.vpnOn && vpnProc)) {
    if (state.egress || state.vpnHealthy) { state.egress = null; state.vpnHealthy = false; pushStatus() }
    return
  }
  const c = spawn('curl.exe', ['-s', '--max-time', '8', 'http://checkip.amazonaws.com/'], { windowsHide: true })
  let out = ''
  c.stdout.on('data', (d) => { out += d.toString() })
  c.on('error', () => {})
  c.on('exit', () => {
    const ip = (out.match(/\d{1,3}(\.\d{1,3}){3}/) || [])[0] || null
    const healthy = !!ip
    if (ip !== state.egress || healthy !== state.vpnHealthy) {
      if (healthy && !state.vpnHealthy) pushLog(`[app] VPN connected — egress ${ip}`)
      state.egress = ip; state.vpnHealthy = healthy; pushStatus()
    }
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
ipcMain.handle('vpnOn', async () => { await runVpn(false) })
ipcMain.handle('vpnOff', async () => { await runVpn(true) })
// one-click: Connect brings up everything (client rendezvous + VPN tunnel); Disconnect tears it all down
ipcMain.handle('connect', async () => { await runVpn(false) })
ipcMain.handle('disconnect', async () => { await runVpn(true); await stopClient() })
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
  onDpTick(); timers.push(setInterval(onDpTick, 2000)) // watch rendezvous endpoints -> start/relaunch engine
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('before-quit', () => { quitting = true; for (const t of timers) clearInterval(t) })

app.on('window-all-closed', async () => {
  quitting = true
  for (const t of timers) clearInterval(t)
  if (vpnProc) { const pid = vpnProc.pid; vpnProc = null; await killTree(pid) } // remove the TUN on exit
  await stopClient()
  app.quit()
})

// last-resort: never let a stray async error pop Electron's crash dialog; log it instead
process.on('uncaughtException', (e) => { try { pushLog(`[app] uncaught: ${e && e.stack || e}`) } catch {} })
process.on('unhandledRejection', (e) => { try { pushLog(`[app] unhandledRejection: ${e && e.stack || e}`) } catch {} })
