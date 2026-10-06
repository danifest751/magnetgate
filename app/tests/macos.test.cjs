const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const path = require('node:path')
const { once } = require('node:events')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const { peer } = require('../mac-protocol.cjs')
const { safeConfig } = require('../mac-helper.cjs')
const { MacEngine, authorizationScript } = require('../mac-engine.cjs')
const { platformConfig, platformPaths, macTunnel } = require('../platform.cjs')
const { buildVpnConfig } = require('../vpn-config.cjs')
const { validateConfig } = require('../../src/config.cjs')
const { waitForEngineReady } = require('../ready.cjs')
const { stopChild, command } = require('../engine.cjs')
const { connectionView } = require('../renderer/state.js')
const root = path.resolve(__dirname, '../..')
const input = () => ({ cfg: validateConfig({}), clashPort: 19090, clashSecret: 'a'.repeat(32),
  bypass: ['203.0.113.1'], snapshot: { v: 4, exits: [{ id: 'fixture', ts: Date.now(),
    dp: [{ t: 'mgt', protocol: 4, host: '203.0.113.1', port: 49001 }] }] } })

test('macOS shares current routing policy and lets the OS allocate utun', () => {
  const request = input()
  request.cfg.killSwitch = true
  request.cfg.vpnMode = 'split'
  const conf = safeConfig(root, request)
  assert.equal(conf.inbounds[0].interface_name, undefined)
  assert.equal(conf.experimental.clash_api.default_mode, 'Rule')
  assert.ok(conf.route.rules.some(rule => rule.clash_mode === 'Global' && rule.outbound === 'proxy'))
  assert.ok(conf.route.rules.some(rule => rule.clash_mode === 'Rule' && rule.outbound === 'direct'))
  const expected = buildVpnConfig({ root, cfg: { ...request.cfg, killSwitch: false },
    dp: request.snapshot.exits[0].dp.map(d => ({ ...d, exitId: 'fixture' })),
    bypass: request.bypass, clashPort: request.clashPort, clashSecret: request.clashSecret,
    clientPath: process.execPath, platform: 'darwin' })
  assert.deepEqual(conf, expected)
})

test('macOS root helper cannot accept arbitrary config paths, commands or privileged ports', () => {
  const request = input()
  request.config = { log: { output: '/etc/hosts' }, experimental: { cache_file: { path: '/etc/passwd' } } }
  request.exe = '/bin/sh'; request.args = ['-c', 'arbitrary-command']
  const conf = safeConfig(root, request)
  assert.equal(conf.log.output, undefined)
  assert.equal(conf.experimental.cache_file, undefined)
  assert.throws(() => safeConfig(root, { ...request, clashPort: 22 }))
  assert.throws(() => safeConfig(root, { ...request, cfg: { ...request.cfg, probePort: 80 } }))
  assert.throws(() => safeConfig(root, { ...request, clashSecret: 'bad' }))
  assert.throws(() => safeConfig(root, { ...request, snapshot: { v: 3, exits: [] } }))
})

test('macOS routing inspection handles split default routes and optional expiry columns', () => {
  const header = 'Routing tables\nInternet:\nDestination Gateway Flags Netif Expire\n'
  assert.equal(macTunnel(header + 'default 192.168.1.1 UGSc en0\n0/1 172.19.0.1 UGSc utun4 30'), 'utun4')
  assert.equal(macTunnel(header + 'default link#12 UCSg utun2 0'), 'utun2')
  assert.equal(macTunnel(header + 'default 192.168.1.1 UGSc en0'), null)
  assert.throws(() => macTunnel('unexpected command output'))
})

test('macOS cannot enable the Windows firewall and UI exposes authorization as cancellable', () => {
  const cfg = platformConfig({ killSwitch: true, exits: [{}] }, 'darwin')
  assert.equal(cfg.killSwitch, false)
  assert.equal(platformPaths(root, 'darwin').killSwitchSupported, false)
  assert.equal(path.basename(platformPaths(root, 'darwin').engine), 'sing-box')
  assert.equal(path.basename(platformPaths(root, 'win32').engine), 'sing-box.exe')
  const view = connectionView(cfg, { vpnOn: true, phase: 'authorizing' })
  assert.equal(view.busy, true); assert.equal(view.connected, false)
  assert.equal(view.button, 'Отменить')
  assert.match(view.detail, /macOS/)
})

test('administrator command quotes paths and clears inherited executable options', () => {
  const script = authorizationScript("/Applications/Some ' App/$HOME", '/helper.cjs', '/tmp/bootstrap.json')
  assert.ok(script.endsWith(' with administrator privileges'))
  const shell = JSON.parse(script.slice('do shell script '.length, -' with administrator privileges'.length))
  assert.ok(shell.startsWith('/usr/bin/env -i PATH='))
  assert.ok(shell.includes("'\\''")); assert.ok(shell.includes("/$HOME'"))
  assert.ok(shell.includes('ELECTRON_RUN_AS_NODE=1'))
})

async function connection(t, handle) {
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    peer(socket, 'a'.repeat(64), handle)
  })
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const socket = net.createConnection(server.address().port, '127.0.0.1')
  sockets.add(socket); await once(socket, 'connect')
  return socket
}

test('helper protocol authenticates before dispatching any command', async t => {
  let called = false
  const socket = await connection(t, () => { called = true; return true })
  socket.write(JSON.stringify({ token: 'b'.repeat(64), id: 1, op: 'start', value: {} }) + '\n')
  await once(socket, 'close')
  assert.equal(called, false)
})

test('helper protocol returns bounded replies and rejects pending requests on disconnect', async t => {
  let received
  const socket = await connection(t, (op, value) => {
    received = { op, value }
    if (op === 'hang') return new Promise(() => {})
    return { pid: 42 }
  })
  const channel = peer(socket, 'a'.repeat(64))
  assert.deepEqual(await channel.request('start', { fixture: true }), { pid: 42 })
  assert.deepEqual(received, { op: 'start', value: { fixture: true } })
  const pending = channel.request('hang')
  socket.destroy()
  await assert.rejects(pending, /disconnected/)
  await assert.rejects(channel.request('start', { oversized: 'x'.repeat(1024 * 1024) }), /unavailable/)
})

test('a late helper exit cannot clear a newer macOS engine session', () => {
  const child = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(),
    stderr: new EventEmitter(), exitCode: null, signalCode: null })
  const old = { child: child() }, current = { child: child() }
  const broker = new MacEngine()
  broker.child = current.child
  broker.notify('exit', { code: 0, signal: null }, old)
  assert.equal(old.child, null)
  assert.equal(broker.child, current.child)
  assert.equal(current.child.exitCode, null)
})

test('a lost macOS start reply keeps an owned handle and shutdown cannot claim success', async () => {
  const broker = new MacEngine()
  const session = { socket: { destroyed: false }, finished: Promise.resolve(1),
    cleanup() {}, channel: { request: () => new Promise(() => {}) } }
  broker.session = session
  broker.sessions.add(session)
  const child = broker.start(input())
  assert.equal(child, broker.child)
  assert.equal(child.exitCode, null)
  assert.equal(session.child, child)
  session.socket.destroyed = true
  await assert.rejects(broker.close(), /unconfirmed/)
  assert.equal(broker.child, child)
})

test('macOS root helper starts a real utun and restores the default route on disconnect',
  { skip: process.platform !== 'darwin' || process.env.MAGNETGATE_MAC_TUN_SMOKE !== '1' }, async t => {
    const before = await command('/sbin/route', ['-n', 'get', 'default'])
    const phases = []
    const broker = new MacEngine({ onAuthorizing: value => phases.push(value),
      authorize(_exe, args) {
        const shell = JSON.parse(args[1].slice('do shell script '.length, -' with administrator privileges'.length))
        const bootstrap = /'([^']+bootstrap.json)'$/.exec(shell)?.[1]
        assert.ok(bootstrap)
        return spawn('/usr/bin/sudo', ['-n', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
          process.execPath, path.resolve(__dirname, '../mac-helper.cjs'), bootstrap],
        { stdio: ['ignore', 'ignore', 'pipe'] })
      }
    })
    t.after(async () => { if (broker.child) await stopChild(broker.child); await broker.close() })
    const abort = new AbortController()
    await broker.prepare(abort.signal)
    assert.deepEqual(phases, [true, false])
    const request = input()
    request.cfg.vpnMode = 'split'
    const child = await broker.start(request)
    await waitForEngineReady(child, safeConfig(root, request), abort.signal)
    await stopChild(child)
    await broker.close()
    const after = await command('/sbin/route', ['-n', 'get', 'default'])
    const gateway = text => /gateway:\s*(\S+)/.exec(text)?.[1]
    const iface = text => /interface:\s*(\S+)/.exec(text)?.[1]
    assert.equal(gateway(after), gateway(before)); assert.equal(iface(after), iface(before))
  })
