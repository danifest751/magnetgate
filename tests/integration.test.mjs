import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import dgram from 'node:dgram'
import crypto from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { createExitHandler } from '../src/exit-session.mjs'
import { connectNative } from '../src/native-client.mjs'
import { startSocks5Server } from '../src/socks5.mjs'
import { socks5Connect, DpPool } from '../src/dp-supervisor.mjs'
import { encodeAddress, decodeAddress } from '../src/address.mjs'
import { ExitUdpMux } from '../src/udpsess.mjs'

const listen = async (server) => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

test(
  'data-plane pool retries startup and engine failure without an idle eviction',
  { timeout: 4000 },
  async (t) => {
    const echo = net.createServer((sock) => sock.pipe(sock)),
      targetPort = await listen(echo)
    t.after(() => echo.close())
    const socks = startSocks5Server(0, async (target) => {
      const sock = net.connect(target.port, target.host)
      await once(sock, 'connect')
      sock.pause()
      return { sock }
    })
    const socksPort = await listen(socks)
    t.after(() => socks.close())
    let ready = false,
      calls = 0
    const pool = new DpPool({
      engineFactory: () => ({
        socksPort,
        ensure: async () => {
          calls++
          return ready
        },
        stop: async () => {}
      })
    })
    t.after(() => pool.stop())
    const dp = { t: 'fixture' },
      target = { host: '127.0.0.1', port: targetPort }
    await assert.rejects(pool.connect(dp, target), /restart/)
    ready = true
    const first = await pool.connect(dp, target)
    first.sock.destroy()
    ready = false
    await assert.rejects(pool.connect(dp, target), /restart/)
    ready = true
    const second = await pool.connect(dp, target)
    second.sock.destroy()
    assert.equal(calls, 4)
  }
)
async function fixture(t, options = {}) {
  const boxKey = crypto.randomBytes(32)
  const handler = createExitHandler({ boxKey, allowPrivate: true, ...options })
  const server = net.createServer(handler),
    port = await listen(server)
  const session = await connectNative({ host: '127.0.0.1', port, protocol: 4 }, boxKey)
  t.after(() => {
    session.destroy()
    handler.close()
    server.close()
  })
  return { handler, session, port, boxKey }
}

test('native handshake, multiplexed TCP and upstream rejection', { timeout: 10000 }, async (t) => {
  const { session } = await fixture(t)
  const echo = net.createServer((sock) => sock.pipe(sock)),
    port = await listen(echo)
  t.after(() => echo.close())
  await Promise.all(
    Array.from({ length: 8 }, async (_, i) => {
      const { sock } = await session.openStream({ host: '127.0.0.1', port })
      const payload = crypto.randomBytes(65536 + i),
        parts = []
      const done = new Promise((resolve) =>
        sock.on('data', (chunk) => {
          parts.push(chunk)
          if (parts.reduce((n, p) => n + p.length, 0) === payload.length) resolve()
        })
      )
      sock.write(payload)
      await done
      assert.deepEqual(Buffer.concat(parts), payload)
      sock.destroy()
    })
  )
  await assert.rejects(session.openStream({ host: '127.0.0.1', port: 65536 }), /closed/)
  assert.equal(session.closed, false)
})

test(
  'native TCP half-close preserves the final response and releases the stream',
  { timeout: 4000 },
  async (t) => {
    const { session } = await fixture(t)
    const target = net.createServer({ allowHalfOpen: true }, (sock) => {
      let body = ''
      sock.on('data', (b) => (body += b))
      sock.on('end', () => sock.end('reply:' + body))
    })
    const port = await listen(target)
    t.after(() => target.close())
    const { sock } = await session.openStream({ host: '127.0.0.1', port })
    const received = []
    sock.on('data', (b) => received.push(b))
    const ended = once(sock, 'end')
    sock.end('request')
    await ended
    assert.equal(Buffer.concat(received).toString(), 'reply:request')
    await new Promise((r) => setImmediate(r))
    assert.equal(session.streams.size, 0)
    const second = await session.openStream({ host: '127.0.0.1', port })
    second.sock.destroy()
    assert.equal(session.closed, false)
  }
)

test(
  'SOCKS preserves pipelined payload and later data during delayed upstream setup',
  { timeout: 10000 },
  async (t) => {
    const { session } = await fixture(t)
    const echo = net.createServer((sock) => sock.pipe(sock)),
      port = await listen(echo)
    t.after(() => echo.close())
    const socks = startSocks5Server(0, async (target) => {
      await new Promise((r) => setTimeout(r, 80))
      return session.openStream(target)
    })
    const proxy = await listen(socks)
    t.after(() => socks.close())
    const app = net.connect(proxy, '127.0.0.1')
    t.after(() => app.destroy())
    await once(app, 'connect')
    const received = []
    let size = 0
    const done = new Promise((resolve) =>
      app.on('data', (b) => {
        received.push(b)
        size += b.length
        if (size === 12 + 11) resolve()
      })
    )
    app.write(
      Buffer.concat([
        Buffer.from([5, 1, 0, 5, 1, 0]),
        encodeAddress('127.0.0.1', port),
        Buffer.from('first')
      ])
    )
    await new Promise((r) => setTimeout(r, 20))
    app.write(Buffer.from('second'))
    await done
    const all = Buffer.concat(received)
    assert.deepEqual(all.subarray(0, 2), Buffer.from([5, 0]))
    assert.equal(all[3], 0)
    assert.equal(all.subarray(12).toString(), 'firstsecond')
  }
)

test(
  'one native UDP association carries 1000 packets and cleans up control',
  { timeout: 15000 },
  async (t) => {
    const { session } = await fixture(t)
    const udp = dgram.createSocket('udp4')
    udp.on('message', (msg, info) => udp.send(msg, info.port, info.address))
    udp.bind(0, '127.0.0.1')
    await once(udp, 'listening')
    t.after(() => udp.close())
    const control = new EventEmitter()
    control.destroy = () => control.emit('close')
    let resolve
    const relay = session.openRelay(control, (payload) => resolve(decodeAddress(payload)))
    for (let i = 0; i < 1000; i++) {
      const reply = new Promise((r) => {
        resolve = r
      })
      relay.send(encodeAddress('localhost', udp.address().port, Buffer.from(String(i))))
      assert.equal((await reply).data.toString(), String(i))
    }
    assert.equal(session.relays.size, 1)
    control.destroy()
    assert.equal(session.relays.size, 0)
  }
)

test('pre-auth connections expire and release pending slots', { timeout: 3000 }, async (t) => {
  const handler = createExitHandler({
    boxKey: crypto.randomBytes(32),
    handshakeMs: 50,
    maxPending: 1
  })
  const server = net.createServer(handler),
    port = await listen(server)
  t.after(() => {
    handler.close()
    server.close()
  })
  const sock = net.connect(port, '127.0.0.1')
  await once(sock, 'connect')
  await once(sock, 'close')
  assert.deepEqual(handler.stats(), { active: 0, pending: 0 })
})

test('real SOCKS client rejects a failed destination', { timeout: 3000 }, async (t) => {
  const server = startSocks5Server(0, async () => {
    throw new Error('unavailable')
  })
  const port = await listen(server)
  t.after(() => server.close())
  await assert.rejects(socks5Connect(port, 'example.test', 443), /rejected/)
})

test(
  'reliable UDP carries authenticated native session over loopback',
  { timeout: 10000 },
  async (t) => {
    const boxKey = crypto.randomBytes(32),
      handler = createExitHandler({ boxKey, allowPrivate: true })
    const mux = new ExitUdpMux({ port: 0, boxKey, onConn: handler })
    await once(mux.udp, 'listening')
    t.after(() => {
      handler.close()
      for (const { stream } of mux.streams.values()) stream.destroy()
      mux.udp.close()
    })
    const session = await connectNative(
      { host: '127.0.0.1', port: mux.udp.address().port, protocol: 4, udp: 1 },
      boxKey,
      'udp'
    )
    t.after(() => session.destroy())
    const echo = net.createServer((sock) => sock.pipe(sock)),
      port = await listen(echo)
    t.after(() => echo.close())
    const { sock } = await session.openStream({ host: '127.0.0.1', port })
    sock.write('udp-native')
    const [data] = await once(sock, 'data')
    assert.equal(data.toString(), 'udp-native')
    sock.destroy()
  }
)
