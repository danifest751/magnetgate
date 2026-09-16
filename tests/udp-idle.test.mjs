import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ExitUdpMux, UDP_CMD } from '../src/udpsess.mjs'

const MAGIC = 0x4d
function hello(conv) {
  const head = Buffer.alloc(10)
  head[0] = MAGIC
  head.writeUInt32BE(conv, 1)
  head[5] = UDP_CMD.HELLO
  head.writeUInt32BE(0, 6)
  return head
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('S9: an idle UDP stream is evicted, an active one is kept', async () => {
  let spawned = 0
  const mux = new ExitUdpMux({
    port: 0,
    boxKey: Buffer.alloc(32),
    onConn: () => spawned++,
    idleMs: 60
  })
  try {
    const peer = { address: '127.0.0.1', port: 41234 }
    mux.onDatagram(hello(0x11111111), peer)
    mux.onDatagram(hello(0x22222222), peer)
    assert.equal(spawned, 2, 'each new conv spawns a stream')
    assert.equal(mux.streams.size, 2)

    // let both streams age past idleMs, then mark only one as active again
    await sleep(90)
    const kept = mux.streams.get('286331153@127.0.0.1:41234') // conv 0x11111111
    assert.ok(kept, 'stream is registered')
    kept.stream.lastActive = Date.now()

    const evicted = mux.evictIdle()

    assert.equal(evicted, 1, 'exactly the quiet stream is evicted')
    assert.equal(mux.streams.size, 1, 'the evicted entry is gone from the map')
    assert.ok(kept.stream.closed === false, 'the recently active stream stays open')
    assert.equal(mux.streams.has('286331153@127.0.0.1:41234'), true)
  } finally {
    for (const { stream } of mux.streams.values()) stream.destroy()
    mux.close()
    mux.udp.close()
  }
})

test('S9: idle eviction is disabled when idleMs is 0', () => {
  const mux = new ExitUdpMux({ port: 0, boxKey: Buffer.alloc(32), onConn: () => {}, idleMs: 0 })
  try {
    assert.equal(mux.idleMs, 0)
    assert.equal(mux.sweep, null, 'no sweep timer when eviction is disabled')
    assert.equal(mux.evictIdle(), 0)
  } finally {
    mux.close()
    mux.udp.close()
  }
})
