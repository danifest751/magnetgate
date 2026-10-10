const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron')
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
const { accumulate, rate } = require('./stats.cjs')
const { PeerHost } = require('./peer-host.cjs')
const { PublicAccess } = require('./public-access.cjs')
// messages the main process shows to the user follow the language the renderer chose
const I18n = require('./renderer/i18n.js')
const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
const PLATFORM = process.platform || 'win32'
const { platformConfig, platformPaths, macTunnel } = require('./platform.cjs')
const paths = platformPaths(RES, PLATFORM)
const {
  summarize: summarizeCountries,
  summarizeNodes,
  select: selectCountry
} = require(path.join(RES, 'src', 'countries.cjs'))
if (process.env.MAGNETGATE_APP_TEST_DIR)
  app.setPath('userData', process.env.MAGNETGATE_APP_TEST_DIR)
const { DEFAULT_CONFIG, validateConfig, freshEndpoints } = require(
  path.join(RES, 'src', 'config.cjs')
)
const CONFIG = path.join(app.getPath('userData'), 'magnetgate.config.json')
const publicAccess = new PublicAccess(app.getPath('userData'), safeStorage)
const DP_FILE = path.join(app.getPath('userData'), 'current-dp.json')
// holds every exit PSK while the client child runs, so it must not outlive the session
const RUNTIME_FILE = path.join(app.getPath('userData'), 'runtime-client.json')
const LOG_DIR = path.join(app.getPath('userData'), 'logs')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, 'magnetgate.log'),
  diskLog = rotatingLog(LOG_FILE)
const SB_DIR = path.join(RES, 'tools', 'sing-box'),
  SB_EXE = paths.engine
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
const clientStopping = new Set()
const state = {
  platform: PLATFORM,
  killSwitchSupported: paths.killSwitchSupported,
  authorizing: false,
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
  stats: { conns: 0, up: 0, down: 0, upTotal: 0, downTotal: 0, upBps: 0, downBps: 0, planes: [] },
  countries: [],
  nodes: [],
  country: '',
  countryFallback: false,
  connectionSource: 'servers',
  peer: { configured: false, state: 'OFFLINE', countries: [], policy: { enabled: false } }
}
const peerHost = new PeerHost({ root: RES, profile: path.join(app.getPath('userData'), 'peer'),
  onStatus: value => {
    state.peer = value
    if (state.connectionSource === 'peers') {
      state.countries = value.countries || []
      if (!value.guestConnected) { state.vpnHealthy = false; requestTick() }
    }
    pushStatus()
  } })
function safeSend(channel, value) {
  if (win && !win.isDestroyed() && !quitting) win.webContents.send(channel, value)
}
// sing-box writes one ERROR per failed outbound connection. A torrent client alone produced ~20k
// lines in 1.5 hours, which rotated this log away every few hours — a three-day history did not
// survive and genuine tunnel events were buried in it. Collapse the repetitive connection errors
// into a periodic summary instead; MAGNETGATE_PERSIST_NOISE=1 keeps every line for debugging.
// Three classes are known to be per-packet and harmless:
//   - a destination dial that failed (unreachable peer/endpoint),
//   - a DNS packet the hijacker could not parse (a burst while the TUN comes up),
//   - a one-off outbound handshake timeout.
const NOISE =
  /connection:.*open connection to .* using outbound\/|outbound\/[a-z0-9-]+\[[^\]]*\]: (dial|read) tcp |router: process DNS packet: unpack request|report handshake success: connection timed out/
const NOISE_PERSIST = process.env.MAGNETGATE_PERSIST_NOISE === '1'
const NOISE_SUMMARY_MS = 5 * 60 * 1000
const NOISE_SUMMARY_COUNT = 1000
let noiseCount = 0,
  noiseReported = 0,
  noiseAt = 0
function writeLog(text) {
  logs.push(text)
  if (logs.length > 500) logs.shift()
  diskLog.append(text)
  safeSend('log', text)
}
function pushLog(line) {
  const raw = String(line)
  if (!NOISE_PERSIST && NOISE.test(raw)) {
    noiseCount++
    const now = Date.now()
    if (!noiseAt) noiseAt = now
    if (noiseCount - noiseReported >= NOISE_SUMMARY_COUNT || now - noiseAt >= NOISE_SUMMARY_MS) {
      const suppressed = noiseCount - noiseReported
      noiseReported = noiseCount
      noiseAt = now
      writeLog(
        new Date().toISOString() +
          ` [app] suppressed ${suppressed} repeated connection error(s) (unreachable destinations); last: ${raw.slice(0, 160)}`
      )
    }
    return
  }
  writeLog(new Date().toISOString() + ' ' + raw.slice(0, 8192))
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
          : state.authorizing
            ? 'authorizing'
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
  return platformConfig(validateConfig(JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^﻿/, ''))), PLATFORM)
}
function saveConfig(cfg) {
  const clean = platformConfig(validateConfig(cfg), PLATFORM)
  const old = loadConfig()
  atomicJson(CONFIG, clean)
  if (state.vpnOn && (old.connectionSource !== clean.connectionSource ||
      clean.connectionSource === 'peers' && old.country !== clean.country)) {
    invalidateHealth()
    state.modePending = true
    const token = ++intent
    engine.cancelStart()
    modeAbort?.abort()
    const change = operation.then(async () => {
      if (token !== intent || !state.vpnOn) return clean
      await stopClient()
      if (token === intent && state.vpnOn) {
        await startClient()
        if (token !== intent || !state.vpnOn) return clean
        await applyVpn()
      }
      return clean
    })
    operation = change.catch(() => {})
    return change
  }
  return clean
}
function readDp() {
  if (state.connectionSource === 'public') return publicAccess.endpoints()
  if (state.connectionSource === 'peers') {
    const e = peerHost.endpoint
    return e && peerHost.state.guestConnected ? [{ t: 'peer', protocol: 1, host: '127.0.0.1',
      port: e.port, username: e.username, password: e.password,
      exitId: 'peer', country: e.country, node: I18n.t('main.peerNode') }] : []
  }
  try {
    return freshEndpoints(JSON.parse(fs.readFileSync(DP_FILE, 'utf8')))
  } catch {
    return []
  }
}
function bypassIps(dp) {
  return [...new Set(dp.map((d) => d.host).filter(net.isIPv4))]
}
let macInput = null
const macEngine = PLATFORM === 'darwin' ? new (require('./mac-engine.cjs').MacEngine)({
  onAuthorizing: value => { state.authorizing = value; pushStatus() }
}) : null
const engine = new EngineController({
  ...(macEngine ? { spawnChild: () => macEngine.start(macInput) } : {}),
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
  if (!paths.killSwitchSupported) {
    if (!off && !status) throw new Error('Persistent kill switch is unavailable on this platform')
    guardReady = false
    state.guardRecoveryRequired = false
    state.trafficProtected = false
    return false
  }
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
    if (loadConfig().connectionSource === 'peers') args.push('-PeerExe', peerHost.executable)
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
  if (PLATFORM === 'darwin') {
    // Live settings changes reuse our existing TUN. Inspect foreign routes on a cold start;
    // an OS-allocated owned utun must not be mistaken for a competing VPN.
    if (engine.running) return null
    try { return macTunnel(await command('/usr/sbin/netstat', ['-rn', '-f', 'inet'], {}, 8000)) }
    catch (err) { throw new Error('Could not inspect tunnel state: ' + err.message) }
  }
  if (PLATFORM !== 'win32') throw new Error('Unsupported desktop platform')
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
  const cfg = loadConfig()
  state.connectionSource = cfg.connectionSource
  if (cfg.connectionSource === 'public') {
    if (clientProc) await stopClient()
    await peerHost.disconnect()
    await publicAccess.refresh()
    state.clientRunning = true
    state.rvReady = true
    return
  }
  if (cfg.connectionSource === 'peers') {
    if (clientProc) await stopClient()
    await peerHost.suspend(true)
    await peerHost.connect(cfg.country, cfg.localPort)
    state.clientRunning = true
    state.rvReady = true
    return
  }
  await peerHost.disconnect()
  const
    sig = JSON.stringify({
      exits: cfg.exits,
      bootstrap: cfg.bootstrap,
      localPort: cfg.localPort,
      transport: cfg.transport,
      slots: cfg.slots,
      country: cfg.country
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
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
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
    child.on('message', (message) => {
      if (clientProc === child && message?.type === 'endpoints-updated') requestTick()
    })
    for (const output of [child.stdout, child.stderr])
      output.on('data', (buf) => pushLog('[client] ' + String(buf).trim()))
    child.once('error', (err) => {
      if (clientProc === child) {
        clientProc = null
        state.clientRunning = false
        if (!clientStopping.has(child)) state.lastError = err.message
        pushStatus()
      }
    })
    child.once('exit', (code) => {
      if (clientProc === child) {
        clientProc = null
        state.clientRunning = false
        if (!clientStopping.has(child)) state.lastError = 'Discovery client stopped (' + code + ')'
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
  let peerError = null
  try { await peerHost.disconnect() } catch (err) { peerError = err }
  if (clientStarting) await clientStarting.catch(() => {})
  const old = clientProc
  clientStopping.add(old)
  try {
    await stopChild(old)
  } finally {
    clientStopping.delete(old)
  }
  if (clientProc === old) clientProc = null
  clientSig = null
  state.clientRunning = false
  // the runtime config carries every PSK: remove it as soon as the child is gone
  try {
    fs.unlinkSync(RUNTIME_FILE)
  } catch (err) {
    if (err.code !== 'ENOENT') pushLog('[client] could not remove the runtime config: ' + err.message)
  }
  if (peerError) throw peerError
}
async function applyVpn() {
  if (!state.vpnOn) return
  const dp = readDp()
  state.rvReady = dp.length > 0
  if (!dp.length) {
    if (engine.running && state.connectionSource !== 'peers') await engine.stop()
    state.vpnHealthy = false
    state.route = null
    state.countries = []
    state.nodes = []
    state.countryFallback = false
    lastSig = null
    pushStatus()
    return
  }
  const cfg = loadConfig()
  // Country preference: only the chosen country's endpoints are offered to the engine, while every
  // endpoint's address still bypasses the TUN (the client's own uplinks must never be captured).
  const selection = cfg.connectionSource === 'peers'
    ? { endpoints: dp.filter(d => !cfg.country || d.country === cfg.country),
      available: peerHost.state.countries || [], fallback: false }
    : selectCountry(dp, cfg.country)
  state.countries = selection.available
  state.nodes = summarizeNodes(dp)
  state.country = cfg.country
  state.countryFallback = selection.fallback
  const chosen = selection.endpoints
  const sig = JSON.stringify({ dp: chosen, cfg })
  if (sig === lastSig && engine.running && !state.modePending) return
  if (Date.now() < retryAt) return
  if (selection.fallback)
    pushLog(`Country ${cfg.country}: no live exits; using any`)
  const engineSig = engineSignature(cfg, chosen)
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
  const tunnelAlias = PLATFORM === 'darwin' ? '' : 'magnetgate-' + crypto.randomBytes(6).toString('hex')
  const conf = buildVpnConfig({
    root: RES,
    cfg,
    dp: chosen,
    bypass: bypassIps(dp),
    clashPort: CLASH_PORT,
    clashSecret: CLASH_SECRET,
    clientPath: process.execPath,
    tunnelAlias,
    platform: PLATFORM
  })
  // Validate candidate first. Strict policy survives process failure and credential rotation.
  const started = await engine.start(conf, async signal => {
    if (macEngine) {
      macInput = { cfg: { ...cfg, exits: [] }, bypass: bypassIps(dp),
        clashPort: CLASH_PORT, clashSecret: CLASH_SECRET,
        snapshot: { v: 4, exits: chosen.map(d => ({ id: d.exitId, ts: Date.now(), dp: [d] })) } }
      await macEngine.prepare(signal)
    }
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
    pushLog(
      'VPN engine ready with ' +
        chosen.length +
        ' endpoints' +
        (cfg.country ? ` (country ${cfg.country}${selection.fallback ? ', no live exit — any' : ''})` : '')
    )
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
    clearTimeout(tickWakeTimer)
    tickWakeTimer = null
  }
  const token = ++intent
  state.vpnOn = !off
  const result = operation
    .then(async () => {
      if (token !== intent) return
      if (off) {
        await stopProcesses()
        if (guardReady || (await firewall(false, true))) await firewall(true)
        resetTraffic()
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
        await peerHost.suspend(false)
        pushStatus()
        return
      }
      // Discovery doesn't alter Windows routes, so it can run during adapter inspection.
      // Both must finish before applyVpn or an endpoint-triggered tick may start the TUN.
      await peerHost.suspend(true)
      const [inspection, discovery] = await Promise.allSettled([checkOtherTunnel(), startClient()])
      if (token !== intent) return
      state.otherTunnel = inspection.status === 'fulfilled' ? inspection.value : null
      const failure =
        inspection.status === 'rejected' ? inspection.reason :
        discovery.status === 'rejected' ? discovery.reason :
        state.otherTunnel ? new Error('Turn off ' + state.otherTunnel + ' before connecting') : null
      if (failure) {
        // Block queued notifications even if owned-process cleanup itself fails.
        state.vpnOn = false
        try {
          await stopClient()
        } catch (err) {
          throw new Error(failure.message + '; client cleanup failed: ' + err.message)
        }
        throw failure
      }
      state.lastError = null
      retryAt = 0
      resetTraffic() // the volume line means "this connection"
      // An offer may have arrived just before inspection finished. Let its batch complete.
      if (!tickWakeTimer) await applyVpn()
    })
    .catch(async (err) => {
      await handleAuthorizationFailure(err)
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
let tickBusy = false,
  tickAgain = false,
  tickWakeTimer = null
// Fresh authenticated offers wake the same serialized lifecycle as the recovery timer.
function requestTick() {
  if (quitting || !state.vpnOn || tickWakeTimer) return
  // Nearby nodes often publish together. Batch the burst to avoid two cold TUN starts.
  tickWakeTimer = setTimeout(() => {
    tickWakeTimer = null
    if (tickBusy) tickAgain = true
    else tick()
  }, 100)
}
function tick() {
  if (tickBusy || tickWakeTimer || quitting || !state.vpnOn) return
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
      await handleAuthorizationFailure(err)
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
      if (tickAgain) {
        tickAgain = false
        requestTick()
      }
    })
  operation = result.catch(() => {})
}
async function handleAuthorizationFailure(err) {
  if (err.code !== 'MAC_AUTH_REQUIRED') return
  state.vpnOn = false
  clearTimeout(tickWakeTimer)
  tickWakeTimer = null
  invalidateHealth()
  try { await stopProcesses() }
  catch (cleanup) { err.message += '; cleanup failed: ' + cleanup.message }
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
        paths.curl,
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
    // Concurrent probes may use different live exits during urltest failover.
    // Accept that only when both addresses belong to the selected VPN nodes;
    // an ordinary ISP address must still fail Full-mode verification.
    const exitIps = new Set(selectCountry(readDp(), cfg.country).endpoints.map((d) => d.host))
    state.viaExit = !!(
      system && proxy && (system === proxy || (exitIps.has(system) && exitIps.has(proxy)))
    )
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
// volume carried by the current connection, kept across engine restarts (see app/stats.cjs)
let trafficBase = { up: 0, down: 0 }
function resetTraffic() {
  lastSample = null
  trafficBase = { up: 0, down: 0 }
  state.stats = { conns: 0, up: 0, down: 0, upTotal: 0, downTotal: 0, upBps: 0, downBps: 0, planes: [] }
}
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
            raw = { up: Number(j.uploadTotal) || 0, down: Number(j.downloadTotal) || 0 }
          // which data plane is actually carrying traffic right now: chains look like
          // ["exit-0-reality-0", "proxy"]. Knowing that a session silently fell back to the native
          // channel (PoC-level camouflage) matters more than the connection count.
          const planes = new Set()
          for (const c of Array.isArray(j.connections) ? j.connections : []) {
            for (const hop of Array.isArray(c.chains) ? c.chains : []) {
              const tag = String(hop)
              if (/reality/i.test(tag)) planes.add('reality')
              else if (/hy2|hysteria/i.test(tag)) planes.add('hysteria2')
              else if (/native|mgt/i.test(tag)) planes.add('mgt (native)')
            }
          }
          // keep the volume across engine restarts (mode switch, rotation, crash)
          const seconds = lastSample ? (now - lastSample.time) / 1000 : 0
          const acc = accumulate(trafficBase, lastSample, raw)
          trafficBase = acc.base
          state.stats = {
            conns: Array.isArray(j.connections) ? j.connections.length : 0,
            planes: [...planes],
            up: raw.up,
            down: raw.down,
            upTotal: acc.total.up,
            downTotal: acc.total.down,
            upBps: rate(lastSample?.up, raw.up, seconds),
            downBps: rate(lastSample?.down, raw.down, seconds)
          }
          lastSample = { time: now, ...raw }
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
handle('setLanguage', language => I18n.setLanguage(language))
handle('activatePublic', async code => {
  if (state.vpnOn || clientStarting) throw new Error(I18n.t('main.disconnectFirst'))
  await publicAccess.activate(code)
  const cfg = await saveConfig({ ...loadConfig(), connectionSource: 'public', country: '' })
  state.connectionSource = 'public'
  state.countries = summarizeCountries(publicAccess.endpoints())
  state.nodes = summarizeNodes(publicAccess.endpoints())
  pushStatus()
  return cfg
})
handle('setPeerPolicy', policy => peerHost.policy(policy))
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
    state.connectionSource = loadConfig().connectionSource
    void peerHost.start().catch(err => { state.peer = { ...state.peer, error: err.message }; pushStatus() })
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
  clearTimeout(tickWakeTimer)
  tickWakeTimer = null
  engine.cancelStart()
  modeAbort?.abort()
  ++intent
  state.vpnOn = false
  try {
    await operation
    await stopProcesses()
    await peerHost.close()
    await macEngine?.close()
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
