const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const net = require('node:net')
const http = require('node:http')
const { EngineController, command, stopChild } = require('./engine.cjs')
const { buildVpnConfig } = require('./vpn-config.cjs')
const { switchMode, engineSignature } = require('./mode.cjs')
const { rotatingLog } = require('./log.cjs')
if (process.env.MAGNETGATE_APP_TEST_DIR)
  app.setPath('userData', process.env.MAGNETGATE_APP_TEST_DIR)
const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
const { DEFAULT_CONFIG, validateConfig, freshEndpoints } = require(
  path.join(RES, 'src', 'config.cjs')
)
const CONFIG = path.join(app.getPath('userData'), 'magnetgate.config.json')
const DP_FILE = path.join(app.getPath('userData'), 'current-dp.json')
// holds every exit PSK while the client child runs, so it must not outlive the session
const RUNTIME_FILE = path.join(app.getPath('userData'), 'runtime-client.json')
const LOG_DIR = path.join(app.getPath('userData'), 'logs')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, 'magnetgate.log'),
  diskLog = rotatingLog(LOG_FILE)
const SB_DIR = path.join(RES, 'tools', 'sing-box'),
  SB_EXE = path.join(SB_DIR, 'sing-box.exe')
const GUARD = path.join(RES, 'scripts', 'kill-switch.ps1')
const CLASH_PORT = 19090,
  CLASH_SECRET = crypto.randomBytes(16).toString('hex')
let win = null,
  quitting = false,
  allowQuit = false,
  clientProc = null,
  clientStarting = null,
  clientSig = null,
  lastSig = null,
  probeBusy = false,
  retryAt = 0,
  guardReady = false
let activeTunnelAlias = null,
  appliedConfig = null,
  activeEngineSig = null,
  policyRevision = 0,
  modeAbort = null
const timers = [],
  logs = []
const state = {
  clientRunning: false,
  route: null,
  egress: null,
  proxyEgress: null,
  vpnOn: false,
  lastError: null,
  otherTunnel: null,
  vpnHealthy: false,
  modePending: false,
  activeMode: null,
  rvReady: false,
  phase: 'idle',
  viaExit: false,
  trafficProtected: false,
  stats: { conns: 0, up: 0, down: 0, upBps: 0, downBps: 0 }
}
function safeSend(channel, value) {
  if (win && !win.isDestroyed() && !quitting) win.webContents.send(channel, value)
}
function pushLog(line) {
  const text = new Date().toISOString() + ' ' + String(line).slice(0, 8192)
  logs.push(text)
  if (logs.length > 500) logs.shift()
  diskLog.append(text)
  safeSend('log', text)
}
// A tunnel client's log records where the user went: make it removable from the UI.
async function clearLogs() {
  await diskLog.clear()
  let names = []
  try {
    names = fs.readdirSync(LOG_DIR)
  } catch {}
  for (const name of names) {
    if (!name.endsWith('.log') && !name.endsWith('.log.1')) continue
    try {
      fs.unlinkSync(path.join(LOG_DIR, name))
    } catch {}
  }
  logs.length = 0
}
function pushStatus() {
  state.engineReady = engine.ready
  state.stopRecoveryRequired = !state.vpnOn && !!(engine.running || clientProc)
  state.phase = state.stopRecoveryRequired
    ? 'stopping'
    : !state.vpnOn
      ? state.otherTunnel
        ? 'blocked'
        : 'idle'
      : state.modePending
        ? 'switching'
        : state.vpnHealthy
          ? 'connected'
          : engine.running
            ? 'starting'
            : 'rendezvous'
  safeSend('status', { ...state })
}
function atomicJson(file, value) {
  const temp = file + '.tmp'
  const fd = fs.openSync(temp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file)
}
// A crash or a kill can leave copies of the client config (every exit PSK) and of the engine's
// candidate config behind: drop them at startup, since both are recreated when connecting.
function sweepLeftovers() {
  const dir = app.getPath('userData')
  try {
    fs.unlinkSync(RUNTIME_FILE)
  } catch (err) {
    if (err.code !== 'ENOENT') pushLog('[app] could not remove a stale runtime config: ' + err.message)
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.candidate') && !name.endsWith('.tmp')) continue
      try {
        fs.unlinkSync(path.join(dir, name))
      } catch {}
    }
  } catch {}
}
function loadConfig() {
  if (!fs.existsSync(CONFIG)) {
    const seeds = [
      path.join(RES, 'seed-config.json'),
      path.join(RES, 'magnetgate.config.example.json')
    ]
    const seed = seeds.find((p) => fs.existsSync(p))
    atomicJson(
      CONFIG,
      seed ? JSON.parse(fs.readFileSync(seed, 'utf8').replace(/^﻿/, '')) : DEFAULT_CONFIG
    )
  }
  return validateConfig(JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')))
}
function saveConfig(cfg) {
  const clean = validateConfig(cfg)
  atomicJson(CONFIG, clean)
  return clean
}
function readDp() {
  try {
    return freshEndpoints(JSON.parse(fs.readFileSync(DP_FILE, 'utf8')))
  } catch {
    return []
  }
}
function bypassIps(dp) {
  return [...new Set(dp.map((d) => d.host).filter(net.isIPv4))]
}
const engine = new EngineController({
  exe: SB_EXE,
  cwd: SB_DIR,
  configPath: path.join(LOG_DIR, 'vpn-config.json'),
  log: (line) => pushLog('[vpn] ' + line),
  onExit: (err) => {
    modeAbort?.abort()
    invalidateHealth()
    state.lastError = err.message
    retryAt = Date.now() + 5000
    lastSig = null
    pushLog(err.message)
    pushStatus()
  }
})
async function firewall(off = false, status = false) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', GUARD]
  if (off) args.push('-Off')
  else if (status) args.push('-Status')
  else {
    if (!activeTunnelAlias) throw new Error('No owned TUN alias')
    args.push(
      '-ClientExe',
      process.execPath,
      '-EngineExe',
      SB_EXE,
      '-TunnelAlias',
      activeTunnelAlias
    )
  }
  const output = await command('powershell.exe', args, {}, 20000)
  if (status) {
    const result = JSON.parse(output)
    guardReady = result.recoveryRequired
    state.guardRecoveryRequired = guardReady
    state.trafficProtected = result.protected
    return guardReady
  }
  guardReady = !off
  state.guardRecoveryRequired = !off
  state.trafficProtected = !off
}
async function checkOtherTunnel() {
  const script =
    "@(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and $_.Name -ne 'magnetgate' -and $_.InterfaceDescription -match 'WireGuard|OpenVPN|TAP|WARP|Amnezia' } | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress"
  try {
    const output = (
      await command(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {},
        8000
      )
    ).trim()
    const names = output ? JSON.parse(output) : []
    return Array.isArray(names) ? names[0] || null : names
  } catch (err) {
    throw new Error('Could not inspect tunnel state: ' + err.message)
  }
}
async function startClient() {
  const cfg = loadConfig(),
    sig = JSON.stringify({
      exits: cfg.exits,
      bootstrap: cfg.bootstrap,
      localPort: cfg.localPort,
      transport: cfg.transport
    })
  if (clientProc && sig === clientSig) return
  if (clientProc) await stopClient()
  if (clientStarting) return clientStarting
  clientStarting = (async () => {
    try {
      fs.unlinkSync(DP_FILE)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    if (!cfg.exits.length) {
      await engine.stop()
      lastSig = null
      state.vpnHealthy = false
      state.rvReady = false
      state.route = null
      throw new Error('Add an exit PSK first')
    }
    const runtime = { ...cfg, dataPlane: 'mgt', rules: { direct: [], proxy: [] } }
    const runtimeFile = RUNTIME_FILE
    atomicJson(runtimeFile, runtime)
    const child = spawn(process.execPath, [path.join(RES, 'src', 'client.js'), runtimeFile], {
      cwd: RES,
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        MAGNETGATE_RENDEZVOUS_ONLY: '0',
        MAGNETGATE_NATIVE_ONLY: '1',
        MAGNETGATE_DP_OUT: DP_FILE
      }
    })
    clientProc = child
    clientSig = sig
    state.clientRunning = true
    for (const output of [child.stdout, child.stderr])
      output.on('data', (buf) => pushLog('[client] ' + String(buf).trim()))
    child.once('error', (err) => {
      if (clientProc === child) {
        clientProc = null
        state.clientRunning = false
        state.lastError = err.message
        pushStatus()
      }
    })
    child.once('exit', (code) => {
      if (clientProc === child) {
        clientProc = null
        state.clientRunning = false
        state.lastError = 'Discovery client stopped (' + code + ')'
        pushStatus()
      }
    })
    pushLog('Discovery and native fallback client started')
    pushStatus()
  })().finally(() => {
    clientStarting = null
  })
  return clientStarting
}
async function stopClient() {
  if (clientStarting) await clientStarting.catch(() => {})
  const old = clientProc
  await stopChild(old)
  if (clientProc === old) clientProc = null
  clientSig = null
  state.clientRunning = false
  // the runtime config carries every PSK: remove it as soon as the child is gone
  try {
    fs.unlinkSync(RUNTIME_FILE)
  } catch (err) {
    if (err.code !== 'ENOENT') pushLog('[client] could not remove the runtime config: ' + err.message)
  }
}
async function applyVpn() {
  if (!state.vpnOn) return
  const dp = readDp()
  state.rvReady = dp.length > 0
  if (!dp.length) {
    if (engine.running) await engine.stop()
    state.vpnHealthy = false
    state.route = null
    lastSig = null
    pushStatus()
    return
  }
  const cfg = loadConfig(),
    sig = JSON.stringify({ dp, cfg })
  if (sig === lastSig && engine.running && !state.modePending) return
  if (Date.now() < retryAt) return
  const engineSig = engineSignature(cfg, dp)
  const token = intent
  const startedAt = Date.now()
  invalidateHealth()
  if (engine.ready && !cfg.killSwitch && !guardReady && activeEngineSig === engineSig) {
    state.modePending = true
    pushLog(
      `Switching mode ${state.activeMode} -> ${cfg.vpnMode}; PID=${engine.child.pid}; TUN=${activeTunnelAlias}`
    )
    pushStatus()
    const abort = new AbortController()
    modeAbort = abort
    const generation = engine.generation
    try {
      await switchMode({ port: CLASH_PORT, secret: CLASH_SECRET }, cfg.vpnMode, abort.signal)
      if (token !== intent || !state.vpnOn || generation !== engine.generation || !engine.ready)
        return
      lastSig = sig
      appliedConfig = cfg
      state.activeMode = cfg.vpnMode
      state.modePending = false
      state.lastError = null
      pushLog(
        `Mode ${cfg.vpnMode} applied without TUN restart in ${Date.now() - startedAt} ms; PID=${engine.child.pid}`
      )
    } catch (err) {
      if (token !== intent || !state.vpnOn) return
      throw err
    } finally {
      if (modeAbort === abort) modeAbort = null
    }
    pushStatus()
    void pollEgress()
    return
  }
  state.modePending = false
  appliedConfig = null
  activeEngineSig = null
  pushLog(`Applying VPN configuration: mode=${cfg.vpnMode}; engine restart required`)
  pushStatus()
  const tunnelAlias = 'magnetgate-' + crypto.randomBytes(6).toString('hex')
  const conf = buildVpnConfig({
    root: RES,
    cfg,
    dp,
    bypass: bypassIps(dp),
    clashPort: CLASH_PORT,
    clashSecret: CLASH_SECRET,
    clientPath: process.execPath,
    tunnelAlias
  })
  // Validate candidate first. Strict policy survives process failure and credential rotation.
  const started = await engine.start(conf, async () => {
    activeTunnelAlias = tunnelAlias
    if (cfg.vpnMode === 'full' && cfg.killSwitch) await firewall()
    else if (guardReady) await firewall(true)
  })
  if (started) {
    lastSig = sig
    activeEngineSig = engineSig
    appliedConfig = cfg
    state.activeMode = cfg.vpnMode
    state.route = 'auto'
    state.vpnHealthy = false
    pushLog('VPN engine ready with ' + dp.length + ' endpoints')
  }
  pushStatus()
  if (started) void pollEgress()
}
function invalidateHealth() {
  ++policyRevision
  state.vpnHealthy = false
  state.egress = null
  state.proxyEgress = null
  state.viaExit = false
}
let operation = Promise.resolve(),
  intent = 0
function runVpn(off) {
  if (quitting) return Promise.reject(new Error('Shutdown in progress; wait for process cleanup'))
  if (off) {
    engine.cancelStart()
    modeAbort?.abort()
  }
  const token = ++intent
  state.vpnOn = !off
  const result = operation
    .then(async () => {
      if (token !== intent) return
      if (off) {
        await stopProcesses()
        if (guardReady || (await firewall(false, true))) await firewall(true)
        state.vpnHealthy = false
        state.egress = null
        state.proxyEgress = null
        state.viaExit = false
        lastSig = null
        appliedConfig = null
        activeEngineSig = null
        state.activeMode = null
        state.modePending = false
        state.lastError = null
        pushStatus()
        return
      }
      const other = await checkOtherTunnel()
      if (token !== intent) return
      state.otherTunnel = other
      if (other) {
        state.vpnOn = false
        throw new Error('Turn off ' + other + ' before connecting')
      }
      await startClient()
      if (token !== intent) return
      state.lastError = null
      retryAt = 0
      await applyVpn()
    })
    .catch(async (err) => {
      state.lastError = err.message
      pushLog(err.message)
      try {
        await firewall(false, true)
      } catch {}
      pushStatus()
      throw err
    })
  operation = result.catch(() => {})
  pushStatus()
  return result
}
let tickBusy = false
function tick() {
  if (tickBusy || quitting || !state.vpnOn) return
  tickBusy = true
  const token = intent
  const result = operation
    .then(async () => {
      if (token !== intent || quitting || !state.vpnOn) return
      await startClient()
      if (token !== intent || !state.vpnOn) return
      await applyVpn()
      if (token === intent && state.vpnOn && guardReady && engine.running && !state.vpnHealthy)
        await firewall()
    })
    .catch(async (err) => {
      state.lastError = err.message
      retryAt = Date.now() + 5000
      pushLog(err.message)
      try {
        await firewall(false, true)
      } catch {}
      pushStatus()
    })
    .finally(() => {
      tickBusy = false
    })
  operation = result.catch(() => {})
}
async function pollEgress() {
  if (probeBusy || !state.vpnOn || !engine.ready || state.modePending || !appliedConfig) return
  probeBusy = true
  const generation = engine.generation
  const revision = policyRevision
  try {
    const cfg = appliedConfig
    const run = (extra) =>
      command(
        'curl.exe',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--max-time',
          '8',
          '--noproxy',
          '',
          ...extra,
          'https://checkip.amazonaws.com/'
        ],
        {},
        10000
      )
        .then((text) => {
          const ip = text.trim()
          return net.isIP(ip) ? ip : null
        })
        .catch(() => null)
    const [system, proxy] = await Promise.all([
      run(['--proxy', '']),
      run(['--socks5-hostname', '127.0.0.1:' + cfg.probePort])
    ])
    if (
      generation !== engine.generation ||
      revision !== policyRevision ||
      !state.vpnOn ||
      !engine.ready ||
      state.modePending
    )
      return
    state.egress = system
    state.proxyEgress = proxy
    state.viaExit = !!(system && proxy && system === proxy)
    const wasHealthy = state.vpnHealthy
    state.vpnHealthy = !!proxy && (cfg.vpnMode === 'split' ? !!system : state.viaExit)
    const previousError = state.lastError
    if (!state.vpnHealthy)
      state.lastError = proxy
        ? 'System traffic did not match the proxy egress'
        : 'Proxy connectivity test failed'
    else state.lastError = null
    if (wasHealthy !== state.vpnHealthy || previousError !== state.lastError)
      pushLog(
        `Health: system=${system || 'unavailable'} proxy=${proxy || 'unavailable'} healthy=${state.vpnHealthy}${state.lastError ? ' ' + state.lastError : ''}`
      )
    pushStatus()
  } finally {
    probeBusy = false
    if (revision !== policyRevision) void pollEgress()
  }
}
let lastSample = null
function pollStats() {
  if (!state.vpnOn || !engine.ready) return
  const generation = engine.generation
  const req = http.get(
    {
      host: '127.0.0.1',
      port: CLASH_PORT,
      path: '/connections',
      headers: { Authorization: 'Bearer ' + CLASH_SECRET },
      timeout: 2000
    },
    (res) => {
      let body = ''
      res.on('data', (buf) => {
        body += buf
        if (body.length > 1024 * 1024) req.destroy()
      })
      res.on('end', () => {
        if (generation !== engine.generation) return
        try {
          const j = JSON.parse(body),
            now = Date.now(),
            up = Number(j.uploadTotal) || 0,
            down = Number(j.downloadTotal) || 0
          const dt = lastSample ? (now - lastSample.time) / 1000 : 0
          state.stats = {
            conns: Array.isArray(j.connections) ? j.connections.length : 0,
            up,
            down,
            upBps: dt > 0 ? Math.max(0, (up - lastSample.up) / dt) : 0,
            downBps: dt > 0 ? Math.max(0, (down - lastSample.down) / dt) : 0
          }
          lastSample = { time: now, up, down }
          pushStatus()
        } catch {}
      })
    }
  )
  req.on('error', () => {})
  req.on('timeout', () => req.destroy())
}
function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      throw new Error('Untrusted IPC sender')
    return fn(...args)
  })
}
handle('getState', () => ({ ...state }))
handle('getLog', () => logs.slice())
handle('getConfig', loadConfig)
handle('saveConfig', saveConfig)
handle('genPsk', () => crypto.randomBytes(32).toString('hex'))
handle('startClient', () => runVpn(false))
handle('stopClient', () => runVpn(true))
handle('vpnOn', () => runVpn(false))
handle('vpnOff', () => runVpn(true))
handle('connect', () => runVpn(false))
handle('disconnect', () => runVpn(true))
handle('openConfigDir', () => shell.openPath(path.dirname(CONFIG)))
handle('openLogs', () => shell.openPath(LOG_DIR))
handle('getLogPath', () => LOG_FILE)
handle('clearLog', async () => {
  await clearLogs()
  return true
})
function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 620,
    minHeight: 600,
    show: !process.env.MAGNETGATE_APP_TEST_DIR,
    title: 'magnetgate',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.removeMenu()
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.once('did-finish-load', pushStatus)
  win.on('close', (event) => {
    if (!allowQuit) {
      event.preventDefault()
      shutdown()
    }
  })
  win.on('closed', () => {
    win = null
  })
}
function revealWindow() {
  if (quitting || !app.isReady()) return
  if (!win || win.isDestroyed()) createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
if (!app.requestSingleInstanceLock()) app.exit(0)
else {
  app.on('second-instance', () => {
    pushLog('Another launch requested; showing the existing window')
    revealWindow()
  })
  app.on('activate', revealWindow)
  app.whenReady().then(async () => {
    createWindow()
    pushLog('magnetgate ' + app.getVersion() + ' started')
    sweepLeftovers()
    try {
      await firewall(false, true)
      if (guardReady)
        state.lastError =
          'Previous firewall policy needs restoration. Disconnect restores internet.'
    } catch (err) {
      pushLog(err.message)
    }
    timers.push(
      setInterval(tick, 2000),
      setInterval(pollEgress, 5000),
      setInterval(pollStats, 2000)
    )
    pushStatus()
  })
}
async function stopProcesses() {
  const results = await Promise.allSettled([engine.stop(), stopClient()])
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message)
  if (errors.length) throw new Error(errors.join('; '))
}
async function shutdown() {
  if (quitting) return
  quitting = true
  engine.cancelStart()
  modeAbort?.abort()
  ++intent
  state.vpnOn = false
  try {
    await operation
    await stopProcesses()
    await diskLog.flush()
  } catch (err) {
    quitting = false
    state.lastError = 'Shutdown incomplete: ' + err.message
    pushLog(state.lastError)
    if (!win || win.isDestroyed()) createWindow()
    win.show()
    pushStatus()
    return
  }
  for (const timer of timers) clearInterval(timer)
  allowQuit = true
  // Owned children have stopped and logs are flushed. Do not enter another
  // cancellable window-close cycle and leave an invisible instance holding the lock.
  app.exit(0)
}
app.on('window-all-closed', shutdown)
app.on('before-quit', (event) => {
  if (!allowQuit) {
    event.preventDefault()
    shutdown()
  }
})
process.on('unhandledRejection', (err) => {
  state.lastError = String(err?.message || err)
  pushLog(state.lastError)
  pushStatus()
})
