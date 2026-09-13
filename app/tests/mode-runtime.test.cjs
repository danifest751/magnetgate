const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { buildVpnConfig } = require('../vpn-config.cjs')
const { waitForEngineReady } = require('../ready.cjs')
const { switchMode } = require('../mode.cjs')
const { stopChild } = require('../engine.cjs')
const { validateConfig } = require('../../src/config.cjs')
const root = path.resolve(__dirname, '../..')
const exe = path.join(root, 'tools/sing-box/sing-box.exe')

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
async function freePort() {
  const server = net.createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function fakeOutbound(t, label) {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0),
      stage = 0
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data])
      if (stage === 0 && buffer.length >= 2 && buffer.length >= 2 + buffer[1]) {
        buffer = buffer.subarray(2 + buffer[1])
        stage = 1
        socket.write(Buffer.from([5, 0]))
      }
      if (stage === 1 && buffer.length >= 5) {
        const size = buffer[3] === 3 ? 7 + buffer[4] : buffer[3] === 1 ? 10 : 22
        if (buffer.length < size) return
        stage = 2
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
        socket.write('route=' + label)
      }
    })
  })
  const port = await listen(server)
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    server.close()
  })
  return { type: 'socks', tag: label, server: '127.0.0.1', server_port: port, version: '5' }
}
async function routedSocket(port, domain) {
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.on('error', () => {})
  try {
    await once(socket, 'connect')
    const name = Buffer.from(domain)
    // Send SOCKS greeting + CONNECT together to exercise actual relay buffering too.
    socket.write(
      Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, name.length]), name, Buffer.from([0, 80])])
    )
    await new Promise((resolve, reject) => {
      let data = ''
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('routing probe timeout'))
      }, 3000)
      socket.on('data', (part) => {
        data += part.toString()
        if (data.includes('route=')) {
          const label = data.match(/route=(proxy|direct)/)?.[1]
          if (label) {
            socket.route = label
            clearTimeout(timer)
            resolve()
          }
        }
      })
      socket.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      socket.once('close', () => {
        clearTimeout(timer)
        if (!socket.route) reject(new Error('routing probe closed'))
      })
    })
    return socket
  } catch (err) {
    socket.destroy()
    throw err
  }
}

test(
  'real sing-box changes policies and closes old flows without replacing the process',
  { skip: process.platform !== 'win32' || !fs.existsSync(exe) },
  async (t) => {
    const cleanups = []
    t.after(async () => {
      const errors = []
      for (const cleanup of cleanups.reverse())
        try {
          await cleanup()
        } catch (err) {
          errors.push(err)
        }
      if (errors.length) throw new AggregateError(errors, 'fixture cleanup failed')
    })
    const owner = { after: (fn) => cleanups.push(fn) }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnetgate-mode-runtime-'))
    owner.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const proxy = await fakeOutbound(owner, 'proxy'),
      direct = await fakeOutbound(owner, 'direct')
    const clashPort = await freePort(),
      probePort = await freePort(),
      routePort = await freePort()
    const cfg = buildVpnConfig({
      root,
      cfg: validateConfig({
        vpnMode: 'full',
        probePort,
        directDomains: ['direct.test', 'overlap.test'],
        tunnelDomains: ['tunnel.test', 'overlap.test']
      }),
      dp: [{ t: 'mgt', host: '203.0.113.1', port: 49001, protocol: 4, exitId: 'fixture' }],
      bypass: [],
      clashPort,
      clashSecret: 'runtime-fixture',
      clientPath: 'not-a-running-process.exe'
    })
    // No TUN, system routes, firewall, real proxy or public DNS in this integration fixture.
    cfg.inbounds = cfg.inbounds.filter((i) => i.type !== 'tun')
    cfg.inbounds.push({
      type: 'socks',
      tag: 'route-test',
      listen: '127.0.0.1',
      listen_port: routePort
    })
    cfg.outbounds = [proxy, direct]
    cfg.route.auto_detect_interface = false
    cfg.dns.servers = [
      {
        type: 'hosts',
        tag: 'proxy-dns',
        predefined: Object.fromEntries(
          ['default.test', 'direct.test', 'tunnel.test', 'overlap.test'].map((name) => [
            name,
            ['198.51.100.1']
          ])
        )
      }
    ]
    const file = path.join(dir, 'config.json')
    fs.writeFileSync(file, JSON.stringify(cfg))
    const child = spawn(exe, ['run', '-c', file], { windowsHide: true, cwd: dir })
    let output = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (b) => (output += b))
    owner.after(() => stopChild(child))
    await waitForEngineReady(child, cfg, new AbortController().signal, 10000).catch((err) => {
      throw new Error(err.message + ' ' + output)
    })
    const pid = child.pid,
      api = { port: clashPort, secret: 'runtime-fixture' }
    async function check(domain, wanted, port = routePort) {
      const socket = await routedSocket(port, domain)
      assert.equal(socket.route, wanted)
      socket.destroy()
    }
    await check('default.test', 'proxy')
    await check('direct.test', 'direct')
    await check('overlap.test', 'direct')
    const oldFull = await routedSocket(routePort, 'default.test')
    const fullClosed = once(oldFull, 'close', { signal: AbortSignal.timeout(5000) })
    const start = Date.now()
    await switchMode(api, 'split', new AbortController().signal)
    await fullClosed
    const splitMs = Date.now() - start
    await check('default.test', 'direct')
    await check('tunnel.test', 'proxy')
    await check('overlap.test', 'proxy')
    await check('default.test', 'proxy', probePort)
    const oldSplit = await routedSocket(routePort, 'default.test')
    const splitClosed = once(oldSplit, 'close', { signal: AbortSignal.timeout(5000) })
    const back = Date.now()
    await switchMode(api, 'full', new AbortController().signal)
    await splitClosed
    const fullMs = Date.now() - back
    await check('default.test', 'proxy')
    await check('direct.test', 'direct')
    assert.equal(child.pid, pid)
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
    t.diagnostic(
      `Loopback fixture: Full->Split ${splitMs} ms; Split->Full ${fullMs} ms; same PID ${pid}`
    )
  }
)
