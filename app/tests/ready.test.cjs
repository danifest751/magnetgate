const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const http = require('node:http')
const { once, EventEmitter } = require('node:events')
const { waitForEngineReady } = require('../ready.cjs')
const { stopChild } = require('../engine.cjs')
async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
async function endpoints(t, { status = 200, greeting = true } = {}) {
  const control = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture')
    res.writeHead(status)
    res.end('{}')
  })
  const controlPort = await listen(control)
  const socks = net.createServer((sock) =>
    sock.once('data', () => sock.end(greeting ? Buffer.from([5, 0]) : Buffer.from([5, 255])))
  )
  const socksPort = await listen(socks)
  t.after(() => {
    control.closeAllConnections()
    control.close()
    socks.close()
  })
  return {
    experimental: {
      clash_api: { external_controller: `127.0.0.1:${controlPort}`, secret: 'fixture' }
    },
    inbounds: [{ tag: 'health-in', listen_port: socksPort }]
  }
}
test('readiness requires authenticated control and a working SOCKS greeting', async (t) => {
  const cfg = await endpoints(t)
  await waitForEngineReady(
    { exitCode: null, signalCode: null },
    cfg,
    new AbortController().signal,
    2000
  )
})
test('control authorization failure never reports TUN ready', async (t) => {
  const cfg = await endpoints(t, { status: 401 })
  await assert.rejects(
    waitForEngineReady({ exitCode: null, signalCode: null }, cfg, new AbortController().signal, 20),
    /did not become ready/
  )
})
test('a control endpoint without a usable SOCKS inbound is not ready', async (t) => {
  const cfg = await endpoints(t, { greeting: false })
  await assert.rejects(
    waitForEngineReady({ exitCode: null, signalCode: null }, cfg, new AbortController().signal, 20),
    /did not become ready/
  )
})
test('readiness aborts immediately on Disconnect', async (t) => {
  const cfg = await endpoints(t, { greeting: false }),
    controller = new AbortController()
  const waiting = waitForEngineReady({ exitCode: null, signalCode: null }, cfg, controller.signal)
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
})
test('stop waits for actual Windows process exit after taskkill returns', async () => {
  const child = new EventEmitter()
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null })
  let requested = false
  const waiting = stopChild(child, {
    platform: 'win32',
    timeoutMs: 1000,
    execute: async () => {
      requested = true
      setTimeout(() => {
        child.exitCode = 1
        child.emit('exit', 1)
      }, 25)
    }
  })
  await waiting
  assert.equal(requested, true)
  assert.equal(child.exitCode, 1)
})
test('stop timeout removes listeners and reports the owned PID', async () => {
  const child = new EventEmitter()
  Object.assign(child, { pid: 321, exitCode: null, signalCode: null })
  await assert.rejects(
    stopChild(child, { platform: 'win32', timeoutMs: 10, execute: async () => {} }),
    /321.*still stopping/
  )
  assert.equal(child.listenerCount('exit'), 0)
})

test('taskkill error still waits for the owned process to exit', async () => {
  const child = new EventEmitter()
  Object.assign(child, { pid: 456, exitCode: null, signalCode: null })
  await stopChild(child, {
    platform: 'win32',
    timeoutMs: 1000,
    execute: async () => {
      setTimeout(() => {
        child.exitCode = 1
        child.emit('exit', 1)
      }, 25)
      throw new Error('taskkill timeout')
    }
  })
  assert.equal(child.exitCode, 1)
})

test('overall deadline interrupts an HTTP probe with unfinished headers', async (t) => {
  const cfg = await endpoints(t)
  const connections = new Set()
  const trickle = net.createServer((sock) => {
    connections.add(sock)
    sock.write('HTTP/1.1 200 OK\r\nX-Pending: ')
    const timer = setInterval(() => sock.write('x'), 5)
    sock.once('close', () => {
      clearInterval(timer)
      connections.delete(sock)
    })
  })
  const port = await listen(trickle)
  t.after(() => {
    for (const sock of connections) sock.destroy()
    trickle.close()
  })
  cfg.experimental.clash_api.external_controller = `127.0.0.1:${port}`
  const started = Date.now()
  await assert.rejects(
    waitForEngineReady({ exitCode: null, signalCode: null }, cfg, new AbortController().signal, 50),
    /did not become ready/
  )
  assert.ok(Date.now() - started < 1000, 'deadline must interrupt an active probe')
})
