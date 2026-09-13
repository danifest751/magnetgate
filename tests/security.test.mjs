import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { isBlockedIp, encodeAddress, decodeAddress, resolveTarget } from '../src/address.mjs'
import { ReliableStream } from '../src/udpsess.mjs'
import { frame2, makeCodecV2, FRAME } from '../src/common.mjs'

test('frame routing metadata and replay cannot bypass authentication', () => {
  const key = crypto.randomBytes(32)
  const frame = frame2(key, FRAME.DATA, 1, Buffer.from('hello'))
  const modified = Buffer.from(frame)
  modified[5] ^= 1
  let killed = false,
    count = 0
  makeCodecV2(
    key,
    () => count++,
    () => {
      killed = true
    }
  ).push(modified)
  assert.equal(count, 0)
  assert.equal(killed, true)
  const codec = makeCodecV2(
    key,
    () => count++,
    () => {
      killed = true
    }
  )
  killed = false
  codec.push(frame)
  codec.push(frame)
  assert.equal(count, 1)
  assert.equal(killed, true)
})

test('egress normalizes mapped and expanded IPv6 and checks resolved names', async () => {
  for (const ip of [
    '127.0.0.1',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
    'fd00::1',
    'fe80::1',
    'localhost'
  ])
    assert.equal(isBlockedIp(ip), true, ip)
  for (const ip of ['1.1.1.1', '2606:4700:4700::1111']) assert.equal(isBlockedIp(ip), false, ip)
  await assert.rejects(
    resolveTarget('example.test', false, async () => [{ address: '127.0.0.1', family: 4 }]),
    /blocked/
  )
  await assert.rejects(
    resolveTarget('example.test', false, async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '::1', family: 6 }
    ]),
    /blocked/
  )
})

test('SOCKS address roundtrip preserves IPv4, IPv6 and DNS destinations', () => {
  for (const host of ['1.2.3.4', 'example.test', '2001:4860:4860:0:0:0:0:8888']) {
    const decoded = decodeAddress(encodeAddress(host, 443, Buffer.from('payload')))
    assert.equal(decoded.host, host)
    assert.equal(decoded.port, 443)
    assert.equal(decoded.data.toString(), 'payload')
  }
  assert.equal(decodeAddress(Buffer.from([3, 10, 1])), null)
  assert.throws(() => encodeAddress('a', 65536))
})

test('reliable UDP handles malformed ACK and rejects far-future sequence without throwing', () => {
  for (const cmd of [3, 4]) {
    const stream = new ReliableStream({ send() {} }, { host: '127.0.0.1', port: 1234 }, 7)
    const packet = Buffer.alloc(cmd === 3 ? 11 : 10)
    packet[0] = 0x4d
    packet.writeUInt32BE(7, 1)
    packet[5] = cmd
    packet.writeUInt32BE(99999, 6)
    try {
      assert.doesNotThrow(() => stream.onDatagram(packet, { address: '127.0.0.1', port: 1234 }))
      assert.equal(stream.closed, true)
      assert.equal(stream.recvBuf.size, 0)
    } finally {
      stream.destroy()
    }
  }
})
