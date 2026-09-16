// Unit tests for the crypto/codec core. Run: npm test  (node:test, Node >= 18)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  deriveKeys,
  saltOf,
  targetOf,
  signer,
  bep44Verify,
  seal,
  unseal,
  connKeys,
  frame2,
  makeFrameEncoder,
  makeCodecV2,
  FRAME,
  hsClientInit,
  hsExitRespond,
  hsClientFinish
} from '../src/common.mjs'
import { nostrKeys, buildEvent } from '../src/nostr.mjs'
import { pickDp, mergeOffer } from '../src/offer.mjs'
import { schnorr } from '@noble/curves/secp256k1.js'

const KEY = crypto.randomBytes(32)

// collect frames decoded from a codec fed the given wire bytes (optionally in pieces)
function decodeAll(key, wire, chunkSize = 0) {
  const out = []
  let killed = false
  const codec = makeCodecV2(
    key,
    (type, id, plain) => out.push({ type, id, plain }),
    () => {
      killed = true
    }
  )
  if (chunkSize > 0) {
    for (let i = 0; i < wire.length; i += chunkSize) codec.push(wire.subarray(i, i + chunkSize))
  } else {
    codec.push(wire)
  }
  return { out, killed }
}

test('DATA frame roundtrip across lengths 0..5000 (C2: padding must not corrupt >=512 B)', () => {
  for (let n = 0; n <= 5000; n++) {
    const plain = crypto.randomBytes(n)
    const wire = frame2(KEY, FRAME.DATA, 7, plain)
    const { out, killed } = decodeAll(KEY, wire)
    assert.equal(killed, false, `killed at n=${n}`)
    assert.equal(out.length, 1, `frame count at n=${n}`)
    assert.equal(out[0].type, FRAME.DATA)
    assert.equal(out[0].id, 7)
    assert.ok(out[0].plain.equals(plain), `payload mismatch at n=${n} (got ${out[0].plain.length})`)
  }
})

test('TLS ClientHello sized frame (517 B) survives — the exact HTTPS-breaking case', () => {
  const plain = crypto.randomBytes(517)
  const wire = frame2(KEY, FRAME.DATA, 1, plain)
  const { out } = decodeAll(KEY, wire)
  assert.ok(out[0].plain.equals(plain))
})

test('padding quantizes wire size to buckets (does not leak exact length)', () => {
  const a = frame2(KEY, FRAME.DATA, 1, crypto.randomBytes(100))
  const b = frame2(KEY, FRAME.DATA, 1, crypto.randomBytes(200))
  assert.equal(a.length, b.length, 'two payloads in the same bucket must share a wire size')
})

test('codec reassembles frames split across arbitrary chunk boundaries', () => {
  const encode = makeFrameEncoder(KEY)
  const parts = [
    encode(FRAME.OPEN, 1, Buffer.from(JSON.stringify({ host: 'example.com', port: 443 }))),
    encode(FRAME.DATA, 1, crypto.randomBytes(1300)),
    encode(FRAME.PING, 0, Buffer.from('p')),
    encode(FRAME.DATA, 1, crypto.randomBytes(3000))
  ]
  const wire = Buffer.concat(parts)
  for (const cs of [1, 3, 7, 45, 64, 500]) {
    const { out, killed } = decodeAll(KEY, wire, cs)
    assert.equal(killed, false, `killed at chunkSize=${cs}`)
    assert.equal(out.length, 4, `frame count at chunkSize=${cs}`)
    assert.equal(out[0].type, FRAME.OPEN)
    assert.equal(out[2].type, FRAME.PING)
  }
})

test('non-DATA frames are not padded/stripped', () => {
  for (const t of [FRAME.OPEN, FRAME.CLOSE, FRAME.PING, FRAME.PONG, FRAME.UDP_ASSOC]) {
    const plain = crypto.randomBytes(50)
    const { out } = decodeAll(
      KEY,
      frame2(KEY, t, [FRAME.PING, FRAME.PONG].includes(t) ? 0 : 3, plain)
    )
    assert.ok(out[0].plain.equals(plain), `type ${t} payload mismatch`)
  }
})

test('wrong key or tampered ciphertext triggers onKill (auth holds)', () => {
  const wire = frame2(KEY, FRAME.DATA, 1, crypto.randomBytes(300))
  assert.equal(decodeAll(crypto.randomBytes(32), wire).killed, true, 'wrong key must kill')
  const tampered = Buffer.from(wire)
  tampered[tampered.length - 1] ^= 0xff
  assert.equal(decodeAll(KEY, tampered).killed, true, 'tampered MAC must kill')
})

test('seal/unseal roundtrip and seq-bound nonce', () => {
  const boxKey = crypto.randomBytes(32)
  const msg = Buffer.from(JSON.stringify({ v: 2, host: '1.2.3.4', port: 49001, ts: Date.now() }))
  const ct = seal(boxKey, msg, 42)
  assert.ok(unseal(boxKey, ct, 42).equals(msg))
  assert.equal(unseal(boxKey, ct, 43), null, 'wrong seq must fail to open')
})

test('deriveKeys is deterministic and connKeys directions differ', () => {
  const a = deriveKeys('psk-abc')
  const b = deriveKeys('psk-abc')
  assert.ok(a.pk.equals(b.pk) && a.sk.equals(b.sk) && a.boxKey.equals(b.boxKey))
  assert.ok(!a.pk.equals(deriveKeys('psk-xyz').pk))
  const salt = crypto.randomBytes(8)
  const k = connKeys(a.boxKey, salt)
  assert.ok(!k.c2e.equals(k.e2c), 'c2e and e2c must differ')
  assert.ok(connKeys(a.boxKey, salt).c2e.equals(k.c2e), 'connKeys must be deterministic')
})

test('BEP44 sign/verify and target derivation', () => {
  const { pk, sk } = deriveKeys('psk-abc')
  const value = crypto.randomBytes(120)
  const sig = signer(sk)(value)
  assert.equal(bep44Verify(sig, value, pk), true)
  const bad = Buffer.from(value)
  bad[0] ^= 1
  assert.equal(bep44Verify(sig, bad, pk), false)
  assert.equal(bep44Verify(sig, value, crypto.randomBytes(32)), false)
  assert.equal(targetOf(pk, saltOf('psk-abc')).length, 20)
})

test('forward-secret handshake: client and exit derive matching keys', () => {
  const { boxKey } = deriveKeys('hs-psk')
  const init = hsClientInit(boxKey)
  const resp = hsExitRespond(boxKey, init.msg1)
  assert.ok(resp, 'exit must accept a valid msg1')
  const fin = hsClientFinish(boxKey, resp.msg2, init.ceSk, init.cePk)
  assert.ok(fin, 'client must accept a valid msg2')
  assert.ok(resp.keys.c2e.equals(fin.keys.c2e), 'c2e must match')
  assert.ok(resp.keys.e2c.equals(fin.keys.e2c), 'e2c must match')
  // a real DATA frame round-trips across the negotiated keys
  const payload = crypto.randomBytes(1500)
  let got = null
  makeCodecV2(
    resp.keys.c2e,
    (t, id, p) => {
      got = p
    },
    () => {}
  ).push(frame2(fin.keys.c2e, FRAME.DATA, 1, payload))
  assert.ok(got && got.equals(payload))
})

test('forward secrecy: every session negotiates fresh ephemeral keys', () => {
  const { boxKey } = deriveKeys('hs-psk')
  const a = hsExitRespond(boxKey, hsClientInit(boxKey).msg1)
  const b = hsExitRespond(boxKey, hsClientInit(boxKey).msg1)
  assert.ok(!a.keys.c2e.equals(b.keys.c2e), 'two sessions must not share keys')
})

test('handshake rejects wrong PSK and tampering', () => {
  const { boxKey } = deriveKeys('hs-psk')
  const wrong = deriveKeys('other-psk').boxKey
  const init = hsClientInit(boxKey)
  assert.equal(hsExitRespond(wrong, init.msg1), null, 'wrong PSK must be rejected')
  const bad = Buffer.from(init.msg1)
  bad[30] ^= 0xff
  assert.equal(hsExitRespond(boxKey, bad), null, 'tampered msg1 must be rejected')
  const resp = hsExitRespond(boxKey, init.msg1)
  const badMsg2 = Buffer.from(resp.msg2)
  badMsg2[30] ^= 0xff
  assert.equal(
    hsClientFinish(boxKey, badMsg2, init.ceSk, init.cePk),
    null,
    'tampered msg2 must be rejected'
  )
})

test('handshake exposes a stable client ephemeral key for replay detection', () => {
  const { boxKey } = deriveKeys('hs-psk')
  const init = hsClientInit(boxKey)
  const r1 = hsExitRespond(boxKey, init.msg1)
  const r2 = hsExitRespond(boxKey, init.msg1) // replay of the same msg1
  assert.ok(
    r1.cePk.equals(r2.cePk),
    'replayed msg1 yields the same cePk so the caller cache blocks it'
  )
})

test('nostr identity is deterministic from the PSK (valid 32-byte x-only pubkey)', () => {
  const a = nostrKeys('psk-abc')
  const b = nostrKeys('psk-abc')
  assert.equal(a.pkHex, b.pkHex)
  assert.equal(a.pkHex.length, 64)
  assert.notEqual(nostrKeys('psk-xyz').pkHex, a.pkHex)
})

test('nostr event id and schnorr signature verify', () => {
  const { sk, pkHex } = nostrKeys('psk-abc')
  const ev = buildEvent(
    sk,
    pkHex,
    [
      ['d', 'x'],
      ['mgt-seq', '7']
    ],
    'payload'
  )
  const id = crypto
    .createHash('sha256')
    .update(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))
    .digest('hex')
  assert.equal(ev.id, id, 'id must be sha256 of the serialized event')
  const ok = schnorr.verify(
    Buffer.from(ev.sig, 'hex'),
    Buffer.from(ev.id, 'hex'),
    Buffer.from(ev.pubkey, 'hex')
  )
  assert.equal(ok, true, 'signature must verify over the id bytes')
})

test('sealed offer v3 survives the Nostr content path (base64 + seq tag, MAC-checked)', () => {
  const { boxKey } = deriveKeys('psk-abc')
  const offer = { v: 3, ts: Date.now(), dp: [{ t: 'mgt', host: '1.2.3.4', port: 49001, udp: 1 }] }
  const seq = 123
  const sealed = seal(boxKey, Buffer.from(JSON.stringify(offer)), seq)
  const ct = Buffer.from(sealed.toString('base64'), 'base64') // publish -> content -> subscribe
  const plain = unseal(boxKey, ct, seq)
  assert.ok(plain, 'must decrypt with the right seq')
  const got = JSON.parse(plain.toString())
  assert.equal(got.v, 3)
  assert.equal(got.dp[0].host, '1.2.3.4')
  assert.equal(unseal(boxKey, ct, seq + 1), null, 'a tampered seq must fail the MAC')
})

// ---- Phase 3: rendezvous split (compact DHT offer + hy2-bearing Nostr offer) ----

test('offer channels seal under disjoint nonces (DHT seq vs Nostr "n"+seq)', () => {
  const { boxKey } = deriveKeys('psk-split')
  const seq = 1757_000_000
  const dhtPlain = Buffer.from(
    JSON.stringify({ v: 3, ts: 1, dp: [{ t: 'reality' }, { t: 'mgt' }] })
  )
  const nostrPlain = Buffer.from(
    JSON.stringify({ v: 3, ts: 1, dp: [{ t: 'reality' }, { t: 'hy2', ca: 'PEM' }, { t: 'mgt' }] })
  )
  const sDht = seal(boxKey, dhtPlain, seq)
  const sNostr = seal(boxKey, nostrPlain, 'n' + seq)
  // each opens only under its own seq domain
  assert.ok(unseal(boxKey, sDht, seq).equals(dhtPlain))
  assert.ok(unseal(boxKey, sNostr, 'n' + seq).equals(nostrPlain))
  // the differing plaintexts never share a nonce: cross-domain open fails (no nonce reuse)
  assert.equal(unseal(boxKey, sNostr, seq), null, 'Nostr offer must not open under the DHT seq')
  assert.equal(unseal(boxKey, sDht, 'n' + seq), null, 'DHT offer must not open under the Nostr seq')
})

test('pickDp honours the preference order', () => {
  const o = { v: 3, ts: 1, dp: [{ t: 'mgt' }, { t: 'hy2' }, { t: 'reality' }] }
  assert.equal(pickDp(o, ['reality', 'hy2', 'mgt']).t, 'reality')
  assert.equal(pickDp(o, ['hy2', 'mgt']).t, 'hy2')
  assert.equal(pickDp(o, ['mgt']).t, 'mgt')
  assert.equal(pickDp({ dp: [{ t: 'mgt' }] }, ['reality']), null)
})

test('mergeOffer unions same-generation offers so the Nostr-only hy2 survives the DHT offer', () => {
  const ts = Date.now()
  const dht = {
    v: 3,
    ts,
    dp: [
      { t: 'reality', sid: 'a' },
      { t: 'mgt', port: 49001 }
    ]
  }
  const nostr = {
    v: 3,
    ts,
    dp: [
      { t: 'reality', sid: 'a' },
      { t: 'hy2', ca: 'PEM', sni: 'magnetgate' },
      { t: 'mgt', port: 49001 }
    ]
  }
  // DHT first, then the hy2-bearing Nostr offer of the same generation
  let held = mergeOffer(null, dht)
  assert.equal(pickDp(held, ['hy2']), null, 'DHT offer alone has no hy2')
  held = mergeOffer(held, nostr)
  assert.equal(pickDp(held, ['hy2']).ca, 'PEM', 'hy2 present after merge')
  // a subsequent DHT re-arrival (polled every few seconds) must NOT clobber hy2
  held = mergeOffer(held, dht)
  assert.equal(pickDp(held, ['hy2']).ca, 'PEM', 'hy2 still present after DHT re-arrival')
  assert.equal(pickDp(held, ['reality', 'hy2', 'mgt']).t, 'reality')
})

test('mergeOffer: newer generation replaces, older is ignored, invalid keeps prev', () => {
  const t0 = 1_000_000
  const prev = { v: 3, ts: t0, dp: [{ t: 'reality' }, { t: 'hy2', ca: 'X' }, { t: 'mgt' }] }
  const newer = { v: 3, ts: t0 + 1, dp: [{ t: 'reality' }, { t: 'mgt' }] }
  const replaced = mergeOffer(prev, newer)
  assert.equal(replaced.ts, t0 + 1)
  assert.equal(
    pickDp(replaced, ['hy2']),
    null,
    'a new generation drops the stale hy2 until Nostr refreshes it'
  )
  const older = { v: 3, ts: t0 - 1, dp: [{ t: 'reality' }] }
  assert.equal(mergeOffer(prev, older), prev, 'older generation is ignored')
  assert.equal(
    mergeOffer(prev, { v: 2, ts: t0 + 5 }),
    null,
    'invalid offer -> null (caller keeps prev)'
  )
  assert.equal(mergeOffer(prev, null), null)
})

test('S7: stale engine configs of dead processes are swept, live and unrelated files are kept', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const { sweepStaleConfigs } = await import('../src/dp-supervisor.mjs')

  const dir = os.tmpdir()
  const tag = crypto.randomBytes(4).toString('hex')
  // a pid that has certainly exited by the time sweepStaleConfigs() runs
  const gone = spawnSync(process.execPath, ['-e', '0'])
  const dead = path.join(dir, `magnetgate-dp-${gone.pid}-${tag}.json`)
  const live = path.join(dir, `magnetgate-dp-${process.pid}-${tag}.json`)
  const unrelated = path.join(dir, `zz-not-a-magnetgate-config-${tag}.json`)
  for (const f of [dead, live, unrelated]) fs.writeFileSync(f, '{"credentials":"x"}')

  const before = fs.existsSync(dead)
  sweepStaleConfigs()

  assert.equal(before, true, 'precondition: the dead-pid config exists')
  assert.equal(fs.existsSync(dead), false, 'a dead process config must be removed')
  assert.equal(fs.existsSync(live), true, 'our own live config must be kept')
  assert.equal(fs.existsSync(unrelated), true, 'unrelated temp files must be kept')
  fs.unlinkSync(live)
  fs.unlinkSync(unrelated)
})

test('S8: log lines fingerprint the destination instead of writing it in clear', async () => {
  const { hostForLog } = await import('../src/common.mjs')
  const a = hostForLog('example.com')
  assert.match(a, /^[0-9a-f]{8}$/, 'default log form is an 8-hex fingerprint')
  assert.equal(a, hostForLog('example.com'), 'the fingerprint is stable')
  assert.notEqual(a, hostForLog('example.org'), 'different hosts stay distinguishable')
  assert.notEqual(a, 'example.com', 'the host itself must not appear')
})

test('S12: the frame size limit is exact and enforced after padding', async () => {
  const { frame2, MAX_FRAME_BYTES } = await import('../src/common.mjs')
  // non-DATA overhead is exactly 58 bytes (4 len + 24 nonce + 16 mac + 14 header)
  const maxPing = frame2(KEY, FRAME.PING, 0, Buffer.alloc(MAX_FRAME_BYTES - 58), 1n)
  assert.equal(maxPing.length, MAX_FRAME_BYTES, 'a PING frame may fill the limit exactly')
  assert.throws(
    () => frame2(KEY, FRAME.PING, 0, Buffer.alloc(MAX_FRAME_BYTES - 57), 1n),
    /frame too large/
  )
  // DATA is padded up to a 4096 bucket, so an oversized plaintext must be rejected before padding
  assert.throws(
    () => frame2(KEY, FRAME.DATA, 1, Buffer.alloc(MAX_FRAME_BYTES), 2n),
    /frame too large/
  )
  const big = Buffer.alloc(1024 * 1024 + 517, 7)
  const wire = frame2(KEY, FRAME.DATA, 1, big, 0n)
  assert.ok(wire.length <= MAX_FRAME_BYTES, `encoded frame is ${wire.length} B`)
  const { out, killed } = decodeAll(KEY, wire, 64 * 1024)
  assert.equal(killed, false, 'the peer must accept a frame this side produced')
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].plain, big, 'a large padded frame round-trips byte for byte')
})
