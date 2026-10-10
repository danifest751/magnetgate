const { test } = require('node:test')
// these tests check the Russian strings; the English default is covered by i18n.test.cjs
require('../renderer/i18n.js').setLanguage('ru')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

// Exercise the real main-process lifecycle with no Electron, child processes or network.
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnetgate-lifecycle-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const observed = {
    quits: 0,
    clientStops: 0,
    shows: 0,
    statuses: [],
    handlers: {},
    starts: 0,
    modes: []
  }
  observed.spawns = []
  observed.wakes = new Map()
  observed.focuses = 0
  observed.restores = 0
  observed.windows = 0
  observed.minimized = false
  observed.destroyed = false
  let engine
  class FakeEngine {
    constructor(options) {
      engine = this
      this.onExit = options.onExit
      this.running = true
      this.ready = true
      this.child = { pid: 1234 }
      this.generation = 1
      this.fail = true
    }
    cancelStart() {}
    async stop() {
      if (this.fail) throw new Error('owned TUN still stopping')
      this.running = false
      this.ready = false
    }
    async start(_cfg, beforeStart) {
      await beforeStart()
      if (observed.startError) throw observed.startError
      observed.starts++
      this.running = true
      this.ready = true
      return true
    }
  }
  const app = {
    isPackaged: false,
    getPath: () => dir,
    setPath() {},
    requestSingleInstanceLock: () => options.ownsInstance !== false,
    isReady: () => true,
    whenReady: () => new Promise(() => {}),
    on: (name, fn) => {
      observed.handlers[name] = fn
    },
    quit: () => {
      throw new Error('Cleanup must finish before the final app.exit')
    },
    exit: (code) => {
      assert.equal(code, 0)
      observed.quits++
    }
  }
  const context = vm.createContext({
    require: (name) => {
      if (name === 'electron')
        return {
          app,
          ipcMain: { handle() {} },
          shell: {},
          BrowserWindow: class {
            constructor() {
              observed.windows++
              observed.destroyed = false
            }
            isDestroyed() {
              return observed.destroyed
            }
            isMinimized() {
              return observed.minimized
            }
            restore() {
              observed.restores++
              observed.minimized = false
            }
            show() {
              observed.shows++
            }
            focus() {
              observed.focuses++
            }
            removeMenu() {}
            loadFile() {}
            on() {}
            webContents = {
              setWindowOpenHandler() {},
              on() {},
              once() {},
              session: { setPermissionRequestHandler() {} }
            }
          }
        }
      if (name === './engine.cjs')
        return {
          EngineController: FakeEngine,
          stopChild: async (child) => {
            if (child) observed.clientStops++
            child?.emit?.('exit', 0)
          },
          command: async (exe, args) => {
            if ((exe === 'curl.exe' || exe === '/usr/bin/curl') && observed.probe) return observed.probe(args)
            if (exe === '/usr/sbin/netstat') return observed.inspect ? observed.inspect() :
              'Destination Gateway Flags Netif\ndefault 192.168.1.1 UGSc en0'
            if (args.includes('-Command')) return observed.inspect ? observed.inspect() : ''
            return JSON.stringify({ recoveryRequired: false, protected: false })
          }
        }
      if (name === 'node:child_process')
        return {
          spawn: (exe, args, options) => {
            const child = new EventEmitter()
            child.stdout = new EventEmitter()
            child.stderr = new EventEmitter()
            observed.spawns.push({ exe, args, options, child })
            return child
          }
        }
      if (name === './mode.cjs')
        return {
          ...require('../mode.cjs'),
          switchMode: async (api, mode, signal) => {
            observed.modes.push(mode)
            if (observed.modeAction) await observed.modeAction(api, mode, signal)
          }
        }
      if (name === './log.cjs')
        return {
          rotatingLog: () => ({ append() {}, flush: async () => observed.flushLog?.() })
        }
      if (name === './mac-engine.cjs') return { MacEngine: class {
        async prepare() { if (observed.authorize) await observed.authorize() }
        async close() {}
      } }
      if (name.startsWith('./')) return require(path.join(__dirname, '..', name))
      return require(name)
    },
    __dirname: path.join(__dirname, '..'),
    process: { env: {}, platform: options.platform || 'win32', execPath: 'fixture.exe', on() {} },
    setInterval,
    clearInterval,
    setTimeout: fn => { const id = Symbol(); observed.wakes.set(id, fn); return id },
    clearTimeout: id => observed.wakes.delete(id),
    Buffer,
    AbortController,
    observed
  })
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8') +
      `
    win = {isDestroyed:()=>observed.destroyed, isMinimized:()=>observed.minimized,
      restore:()=>{observed.restores++;observed.minimized=false}, focus:()=>observed.focuses++,
      show:()=>observed.shows++, webContents:{send:(ch,s)=>{if(ch==='status')observed.statuses.push(s)}}};
    clientProc = {}; state.clientRunning = true;
    globalThis.api = {shutdown, runVpn, state, applyVpn, pollEgress, saveConfig, startClient, stopClient,
      flushWake() {
        for (const [id,fn] of [...observed.wakes]) {observed.wakes.delete(id);fn();}
      },
      async settle() {
        for (;;) {
          const pending=operation;this.flushWake();await pending;
          if(pending===operation&&!observed.wakes.size)return;
        }
      },
      publishEndpoints(includeFi=false) {
        const exits=[{id:'fixture',ts:Date.now(),country:'NL',
          dp:[{t:'mgt',host:'203.0.113.1',port:49001,protocol:4}]}];
        if(includeFi)exits.push({id:'fi',ts:Date.now(),country:'FI',
          dp:[{t:'mgt',host:'203.0.113.2',port:49001,protocol:4}]});
        atomicJson(DP_FILE,{v:4,exits});
      },
      prepareLive(cfg, endpoints) {
        cfg=saveConfig(cfg);
        const dp=endpoints || [{t:'mgt',host:'203.0.113.1',port:49001,protocol:4,exitId:'fixture'}];
        atomicJson(DP_FILE,{v:4,exits:dp.map(d=>({id:d.exitId,ts:Date.now(),country:d.country,dp:[d]}))});
        state.vpnOn=true;state.vpnHealthy=true;state.activeMode=cfg.vpnMode;
        appliedConfig=cfg;activeEngineSig=engineSignature(cfg,readDp());
        lastSig=JSON.stringify({dp:readDp(),cfg});
        return cfg;
      }};
  `,
    context
  )
  return { ...context.api, engine, observed }
}

test('macOS live mode changes do not mistake the owned utun for another VPN', async t => {
  const f = fixture(t, { platform: 'darwin' })
  f.engine.fail = false
  f.observed.inspect = () => { throw new Error('Cold-only inspection called on an owned TUN') }
  f.saveConfig({ vpnMode: 'full', exits: [{ psk: 'fixture-key' }] })
  await f.startClient()
  f.prepareLive({ vpnMode: 'full', killSwitch: true, exits: [{ psk: 'fixture-key' }] })
  assert.equal(f.saveConfig({ vpnMode: 'split', exits: [{ psk: 'fixture-key' }] }).killSwitch, false)
  await f.runVpn(false)
  assert.equal(f.state.vpnOn, true)
  assert.deepEqual(f.observed.modes, ['split'])
  assert.equal(f.observed.starts, 0)
})

test('macOS authorization denial stops automatic retry until the next Connect', async t => {
  const f = fixture(t, { platform: 'darwin' })
  f.engine.fail = false
  f.engine.running = f.engine.ready = false
  f.saveConfig({ exits: [{ psk: 'fixture-key' }] })
  await f.runVpn(false)
  f.observed.authorize = () => { throw Object.assign(new Error('Authorization declined'), { code: 'MAC_AUTH_REQUIRED' }) }
  f.publishEndpoints()
  f.observed.spawns[0].child.emit('message', { type: 'endpoints-updated' })
  await f.settle()
  assert.equal(f.state.vpnOn, false)
  assert.match(f.state.lastError, /declined/)
  assert.equal(f.observed.starts, 0)
  const count = f.observed.spawns.length
  await f.settle()
  assert.equal(f.observed.spawns.length, count)
  assert.equal(f.observed.wakes.size, 0)
})

test('fresh endpoint notification starts VPN without waiting for the polling interval', async (t) => {
  const f = fixture(t)
  f.engine.fail = false
  await f.stopClient()
  f.engine.running = f.engine.ready = false
  f.saveConfig({ exits: [{ name: 'fixture', psk: 'fixture-access-key' }] })
  await f.runVpn(false)
  assert.equal(f.observed.starts, 0)
  const { child, options } = f.observed.spawns[0]
  assert.ok(options.stdio.includes('ipc'))
  f.publishEndpoints()
  child.emit('message', { type: 'endpoints-updated' })
  await new Promise(setImmediate)
  assert.equal(f.observed.starts, 0)
  f.publishEndpoints(true)
  child.emit('message', { type: 'endpoints-updated' })
  assert.equal(f.observed.wakes.size, 1)
  await f.settle()
  assert.equal(f.observed.starts, 1)
  assert.equal(f.state.countries.length, 2)
  // Duplicate notifications don't replace an unchanged engine.
  child.emit('message', { type: 'endpoints-updated' })
  child.emit('message', { type: 'endpoints-updated' })
  await f.settle()
  assert.equal(f.observed.starts, 1)
  await f.runVpn(true)
  child.emit('message', { type: 'endpoints-updated' })
  await f.settle()
  assert.equal(f.observed.starts, 1)
  assert.equal(f.state.vpnOn, false)
})

test('endpoint messages from a replaced discovery child cannot start VPN', async (t) => {
  const f = fixture(t)
  f.engine.fail = false
  await f.stopClient()
  f.engine.running = f.engine.ready = false
  f.saveConfig({ exits: [{ name: 'fixture', psk: 'fixture-access-key' }] })
  await f.runVpn(false)
  const old = f.observed.spawns[0].child
  await f.stopClient()
  await f.startClient()
  f.publishEndpoints()
  old.emit('message', { type: 'endpoints-updated' })
  f.observed.spawns[1].child.emit('message', { type: 'unknown' })
  await f.settle()
  assert.equal(f.observed.starts, 0)
  f.observed.spawns[1].child.emit('message', { type: 'endpoints-updated' })
  await f.settle()
  assert.equal(f.observed.starts, 1)
  await f.runVpn(true)
})

test('native discovery restarts for changed country or slots without a spurious stop error', async (t) => {
  const f = fixture(t)
  const cfg = f.saveConfig({ exits: [{ name: 'fixture', psk: 'fixture-access-key' }], country: 'NL', slots: [0] })
  await f.stopClient()
  await f.startClient()
  await f.startClient()
  assert.equal(f.observed.spawns.length, 1)
  f.saveConfig({ ...cfg, country: 'FI' })
  await f.startClient()
  assert.equal(f.observed.spawns.length, 2)
  f.saveConfig({ ...cfg, country: 'FI', slots: [0, 1] })
  await f.startClient()
  assert.equal(f.observed.spawns.length, 3)
  assert.equal(f.state.lastError, null)
  await f.stopClient()
  assert.equal(f.state.lastError, null)
})

test('discovery overlaps tunnel inspection but early endpoints cannot start TUN before it passes', async (t) => {
  const f = fixture(t)
  f.engine.fail = false
  await f.stopClient()
  f.engine.running = f.engine.ready = false
  f.saveConfig({ exits: [{ name: 'fixture', psk: 'fixture-access-key' }] })
  let release
  f.observed.inspect = () => new Promise(resolve => { release = resolve })
  const connecting = f.runVpn(false)
  await new Promise(setImmediate)
  assert.equal(f.observed.spawns.length, 1)
  f.publishEndpoints()
  const child = f.observed.spawns[0].child
  child.emit('message', { type: 'endpoints-updated' })
  child.emit('message', { type: 'endpoints-updated' })
  f.flushWake()
  await new Promise(setImmediate)
  assert.equal(f.observed.starts, 0)
  release('')
  await connecting
  await f.settle()
  assert.equal(f.observed.starts, 1)
  await f.runVpn(true)
})

test('failed inspection or another tunnel cleans up discovery and cannot be bypassed by queued endpoints', async (t) => {
  for (const other of [false, true]) {
    const f = fixture(t)
    f.engine.fail = false
    await f.stopClient()
    f.engine.running = f.engine.ready = false
    f.saveConfig({ exits: [{ name: 'fixture', psk: 'fixture-access-key' }] })
    let release
    f.observed.inspect = () => new Promise((resolve, reject) => {
      release = () => other ? resolve('"OtherVPN"') : reject(new Error('inspection unavailable'))
    })
    const connecting = f.runVpn(false)
    const rejected = assert.rejects(connecting, other ? /Turn off OtherVPN/ : /Could not inspect/)
    await new Promise(setImmediate)
    assert.equal(f.observed.spawns.length, 1)
    f.publishEndpoints()
    f.observed.spawns[0].child.emit('message', { type: 'endpoints-updated' })
    f.flushWake()
    release()
    await rejected
    await f.settle()
    assert.equal(f.observed.starts, 0)
    assert.equal(f.state.clientRunning, false)
    assert.equal(f.state.vpnOn, false)
    assert.equal(f.observed.clientStops, 2)
  }
})

test('inspection finishing between nearby offers still waits for a single cold TUN configuration', async (t) => {
  const f = fixture(t)
  f.engine.fail = false
  await f.stopClient()
  f.engine.running = f.engine.ready = false
  f.saveConfig({ exits: [{ name: 'fixture', psk: 'fixture-access-key' }] })
  let release
  f.observed.inspect = () => new Promise(resolve => { release = resolve })
  const connecting = f.runVpn(false)
  await new Promise(setImmediate)
  const child = f.observed.spawns[0].child
  f.publishEndpoints()
  child.emit('message', { type: 'endpoints-updated' })
  release('')
  await connecting
  assert.equal(f.observed.starts, 0)
  f.publishEndpoints(true)
  child.emit('message', { type: 'endpoints-updated' })
  await f.settle()
  assert.equal(f.observed.starts, 1)
  assert.equal(f.state.countries.length, 2)
  await f.runVpn(true)
})

test('Disconnect during parallel discovery and inspection cannot activate a late endpoint', async (t) => {
  const f = fixture(t)
  f.engine.fail = false
  await f.stopClient()
  f.engine.running = f.engine.ready = false
  f.saveConfig({ exits: [{ name: 'fixture', psk: 'fixture-access-key' }] })
  let release
  f.observed.inspect = () => new Promise(resolve => { release = resolve })
  const connecting = f.runVpn(false)
  await new Promise(setImmediate)
  assert.equal(f.observed.spawns.length, 1)
  f.publishEndpoints()
  const child = f.observed.spawns[0].child
  child.emit('message', { type: 'endpoints-updated' })
  f.flushWake()
  const disconnecting = f.runVpn(true)
  release('')
  await Promise.all([connecting, disconnecting])
  child.emit('message', { type: 'endpoints-updated' })
  await f.settle()
  assert.equal(f.observed.starts, 0)
  assert.equal(f.state.phase, 'idle')
  assert.equal(f.state.clientRunning, false)
})

test('Full health accepts two known VPN exits but rejects direct or unselected egress', async (t) => {
  const endpoints = [
    { t: 'mgt', host: '203.0.113.10', port: 49001, protocol: 4, exitId: 'nl', country: 'NL' },
    { t: 'mgt', host: '203.0.113.20', port: 49001, protocol: 4, exitId: 'fi', country: 'FI' }
  ]
  const f = fixture(t)
  f.prepareLive({ vpnMode: 'full' }, endpoints)
  f.observed.probe = async args => args.includes('--socks5-hostname') ? '203.0.113.20' : '203.0.113.10'
  await f.pollEgress()
  assert.equal(f.state.vpnHealthy, true)
  assert.equal(f.state.viaExit, true)
  f.observed.probe = async args => args.includes('--socks5-hostname') ? '203.0.113.20' : '203.0.113.99'
  await f.pollEgress()
  assert.equal(f.state.vpnHealthy, false)
  f.prepareLive({ vpnMode: 'full', country: 'NL' }, endpoints)
  f.observed.probe = async args => args.includes('--socks5-hostname') ? '203.0.113.20' : '203.0.113.10'
  await f.pollEgress()
  assert.equal(f.state.vpnHealthy, false)
})

test('failed Disconnect retains cleanup state and retries without restarting VPN', async (t) => {
  const { runVpn, state, engine, observed } = fixture(t)
  await assert.rejects(runVpn(true), /still stopping/)
  assert.equal(state.vpnOn, false)
  assert.equal(state.stopRecoveryRequired, true)
  assert.equal(state.phase, 'stopping')
  assert.equal(observed.clientStops, 1)
  engine.fail = false
  await runVpn(true)
  assert.equal(state.stopRecoveryRequired, false)
  assert.equal(state.lastError, null)
  assert.equal(state.phase, 'idle')
})

test('Full Split round trip changes mode without a new engine', async (t) => {
  const f = fixture(t),
    cfg = f.prepareLive({ vpnMode: 'full' })
  f.saveConfig({ ...cfg, vpnMode: 'split' })
  await f.applyVpn()
  assert.equal(f.state.activeMode, 'split')
  f.saveConfig(cfg)
  await f.applyVpn()
  assert.deepEqual(f.observed.modes, ['split', 'full'])
  assert.equal(f.observed.starts, 0)
  assert.equal(f.engine.child.pid, 1234)
})
test('a rule change or strict guard transition still replaces the engine', async (t) => {
  const f = fixture(t),
    cfg = f.prepareLive({ vpnMode: 'full' })
  f.saveConfig({ ...cfg, directDomains: ['new.test'] })
  await f.applyVpn()
  f.saveConfig({ ...cfg, killSwitch: true })
  await f.applyVpn()
  f.saveConfig({ ...cfg, killSwitch: true, vpnMode: 'split' })
  await f.applyVpn()
  assert.equal(f.observed.starts, 3)
  assert.deepEqual(f.observed.modes, [])
})
test('failed switch stays pending and can retry even when user returns to old mode', async (t) => {
  const f = fixture(t),
    cfg = f.prepareLive({ vpnMode: 'full' })
  f.observed.modeAction = async () => {
    throw new Error('control failed')
  }
  f.saveConfig({ ...cfg, vpnMode: 'split' })
  await assert.rejects(f.applyVpn(), /control failed/)
  assert.equal(f.state.modePending, true)
  assert.equal(f.state.vpnHealthy, false)
  f.observed.modeAction = null
  f.saveConfig(cfg)
  await f.applyVpn()
  assert.equal(f.state.modePending, false)
  assert.deepEqual(f.observed.modes, ['split', 'full'])
  assert.equal(f.observed.starts, 0)
})
test('old health result cannot confirm a newly switched mode', async (t) => {
  const f = fixture(t),
    cfg = f.prepareLive({ vpnMode: 'full' }),
    probes = []
  f.observed.probe = () => new Promise((resolve) => probes.push(resolve))
  const old = f.pollEgress()
  assert.equal(probes.length, 2)
  f.saveConfig({ ...cfg, vpnMode: 'split' })
  await f.applyVpn()
  probes[0]('203.0.113.10')
  probes[1]('203.0.113.10')
  await old
  assert.equal(f.state.vpnHealthy, false)
  assert.equal(probes.length, 4)
  probes[2]('203.0.113.20')
  probes[3]('203.0.113.10')
  await new Promise(setImmediate)
  assert.equal(f.state.vpnHealthy, true)
  assert.equal(f.state.egress, '203.0.113.20')
})
test('late successful health cannot resurrect a stopped engine', async (t) => {
  const f = fixture(t)
  f.prepareLive({ vpnMode: 'full' })
  const probes = []
  f.observed.probe = () => new Promise((resolve) => probes.push(resolve))
  const pending = f.pollEgress()
  f.engine.ready = false
  f.engine.running = false
  f.engine.onExit(new Error('engine exited'))
  probes.forEach((resolve) => resolve('203.0.113.10'))
  await pending
  assert.equal(f.state.vpnHealthy, false)
  assert.equal(f.state.lastError, 'engine exited')
})

test('Disconnect during mode change cannot publish a completed switch afterward', async (t) => {
  const f = fixture(t),
    cfg = f.prepareLive({ vpnMode: 'full' })
  let entered
  const waiting = new Promise((resolve) => (entered = resolve))
  f.observed.modeAction = async (_api, _mode, signal) =>
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      entered()
    })
  f.saveConfig({ ...cfg, vpnMode: 'split' })
  const switching = f.applyVpn()
  await waiting
  f.engine.fail = false
  await f.runVpn(true)
  await switching
  assert.equal(f.state.vpnOn, false)
  assert.equal(f.state.activeMode, null)
  assert.equal(f.state.modePending, false)
  assert.equal(f.state.vpnHealthy, false)
  assert.equal(f.observed.starts, 0)
})

test('failed shutdown keeps the window and owned child available for retry', async (t) => {
  const { shutdown, state, engine, observed } = fixture(t)
  await shutdown()
  assert.equal(observed.quits, 0)
  assert.equal(observed.shows, 1)
  assert.equal(observed.clientStops, 1)
  assert.equal(state.stopRecoveryRequired, true)
  engine.fail = false
  await shutdown()
  assert.equal(observed.quits, 1)
})

test('renderer keeps Disconnect available after failed stop without a firewall guard', () => {
  const { needsDisconnect, connectionView } = require('../renderer/state.js')
  const state = {
    vpnOn: false,
    guardRecoveryRequired: false,
    stopRecoveryRequired: true,
    phase: 'stopping'
  }
  assert.equal(needsDisconnect(state), true)
  assert.equal(connectionView({ exits: [] }, state).button, 'Повторить отключение')
  assert.equal(connectionView({ exits: [] }, state).empty, false)
})

test('a repeated launch restores and focuses the existing window without starting VPN', (t) => {
  const { observed } = fixture(t)
  observed.minimized = true
  observed.handlers['second-instance']()
  assert.equal(observed.restores, 1)
  assert.equal(observed.shows, 1)
  assert.equal(observed.focuses, 1)
  assert.equal(observed.windows, 0)
  assert.equal(observed.starts, 0)
})

test('a repeated launch recreates a missing window without starting VPN', (t) => {
  const { observed } = fixture(t)
  observed.destroyed = true
  observed.handlers['second-instance']()
  assert.equal(observed.windows, 1)
  assert.equal(observed.focuses, 1)
  assert.equal(observed.starts, 0)
})

test('a duplicate instance exits without starting or stopping the primary VPN', (t) => {
  const { observed } = fixture(t, { ownsInstance: false })
  assert.equal(observed.quits, 1)
  assert.equal(observed.starts, 0)
  assert.equal(observed.clientStops, 0)
  assert.equal(observed.handlers['second-instance'], undefined)
})

test('successful shutdown exits only after the owned processes and log flush finish', async (t) => {
  const f = fixture(t)
  let release, releaseLog
  f.engine.stop = () =>
    new Promise((resolve) => {
      release = resolve
    })
  f.observed.flushLog = () =>
    new Promise((resolve) => {
      releaseLog = resolve
    })
  const closing = f.shutdown()
  await new Promise(setImmediate)
  assert.equal(f.observed.quits, 0)
  f.observed.handlers['second-instance']()
  assert.equal(f.observed.shows, 0)
  release()
  await new Promise(setImmediate)
  assert.equal(f.observed.quits, 0)
  releaseLog()
  await closing
  assert.equal(f.observed.quits, 1)
  assert.equal(f.observed.clientStops, 1)
})
