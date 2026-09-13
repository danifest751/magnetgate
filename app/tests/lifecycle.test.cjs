const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

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
          },
          command: async (exe, args) =>
            exe === 'curl.exe' && observed.probe
              ? observed.probe(args)
              : JSON.stringify({ recoveryRequired: false, protected: false })
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
      if (name.startsWith('./')) return require(path.join(__dirname, '..', name))
      return require(name)
    },
    __dirname: path.join(__dirname, '..'),
    process: { env: {}, execPath: 'fixture.exe', on() {} },
    setInterval,
    clearInterval,
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
    globalThis.api = {shutdown, runVpn, state, applyVpn, pollEgress, saveConfig,
      prepareLive(cfg) {
        cfg=saveConfig(cfg);
        const dp=[{t:'mgt',host:'203.0.113.1',port:49001,protocol:4,exitId:'fixture'}];
        atomicJson(DP_FILE,{v:4,exits:[{id:'fixture',ts:Date.now(),dp}]});
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
