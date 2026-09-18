import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deriveKeys,
  saltOf,
  slotSalt,
  slotBoxKey,
  targetOf,
  frame2,
  hsClientInit,
  hsExitRespond,
  hsClientFinish,
  HS_MSG1_LEN,
  HS_MSG2_LEN,
  HS_TS_SKEW_MS,
  FRAME,
  OFFER_SCHEMA,
  MAX_SLOTS
} from '../../src/common.mjs'
import { mergeOffer, pickDp, newPeerSlots } from '../../src/offer.mjs'
import { createPlaneHealth } from '../../src/health.mjs'

// Deterministic cross-implementation vectors for the Android core (app-android/core).
//
// Only facts that do not depend on randomness belong in the tracked file: keys, salts, targets and the
// protocol constants. Envelope interop is random-nonce by design, so it is checked at run time in both
// directions by scripts/dev/verify-vectors.mjs (Node seals → Go unseals, Go seals → Node unseals).
//
//   node scripts/dev/gen-vectors.mjs            # write app-android/core/proto/testdata/v1.json
//   node scripts/dev/gen-vectors.mjs --print    # print instead of writing (diff the result)
export const TEST_PSK = 'vector-test-psk-not-a-secret-0123456789abcdef'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const vectorsFile = path.join(root, 'app-android', 'core', 'testdata', 'v1.json')

const hex = (buf) => Buffer.from(buf).toString('hex')
// length prefix (4) + nonce (24) + MAC (16) + version/sequence/type/streamId (14)
// Offer policy: merging the two rendezvous channels, picking a plane, learning slots from `peers`.
// The expected results are produced by the Node implementation, so the Go port is pinned to it.
function buildOfferVectors() {
  const native = { t: 'mgt', host: '203.0.113.1', port: 49001, protocol: 4 }
  const reality = { t: 'reality', host: '203.0.113.1', port: 443, uuid: 'uuid-x', pbk: 'pbk-x', sni: 'www.microsoft.com', sid: 'sid-x', fp: 'chrome' }
  const hy2 = { t: 'hy2', host: '203.0.113.1', port: 443, pw: 'pw-x', obfs: 'obfs-x', sni: 'magnetgate', ca: ['-----BEGIN CERTIFICATE-----x'] }
  const cases = [
    { name: 'first offer is accepted', prev: null, incoming: { v: 3, ts: 1000, slot: 1, node: 'fi-1', country: 'FI', dp: [native], peers: [{ slot: 0, ts: 999 }] } },
    { name: 'newer generation replaces', prev: { v: 3, ts: 1000, dp: [native] }, incoming: { v: 3, ts: 2000, dp: [reality, native] } },
    { name: 'older generation is kept', prev: { v: 3, ts: 2000, dp: [reality] }, incoming: { v: 3, ts: 1000, dp: [native] } },
    { name: 'same generation unions by type', prev: { v: 3, ts: 2000, dp: [reality, native] }, incoming: { v: 3, ts: 2000, dp: [hy2] } },
    { name: 'same generation refreshes its own type', prev: { v: 3, ts: 2000, dp: [{ ...native, port: 1 }] }, incoming: { v: 3, ts: 2000, dp: [{ ...native, port: 2 }] } },
    { name: 'wrong schema is refused', prev: { v: 3, ts: 1000, dp: [native] }, incoming: { v: 4, ts: 2000, dp: [native] } },
    { name: 'missing timestamp is refused', prev: null, incoming: { v: 3, dp: [native] } },
    { name: 'missing dp is refused', prev: null, incoming: { v: 3, ts: 2000 } }
  ]
  const merge = cases.map((c) => ({
    name: c.name,
    prev: c.prev,
    incoming: c.incoming,
    want: mergeOffer(c.prev, c.incoming)
  }))

  const pick = [
    { pref: ['reality', 'hy2', 'mgt'], dp: [native], want: 'mgt' },
    { pref: ['reality', 'hy2', 'mgt'], dp: [native, hy2], want: 'hy2' },
    { pref: ['reality', 'hy2', 'mgt'], dp: [hy2, reality, native], want: 'reality' },
    { pref: ['reality', 'mgt'], dp: [hy2], want: null },
    { pref: ['reality'], dp: [], want: null }
  ].map((c) => ({ ...c, want: pickDp({ dp: c.dp }, c.pref)?.t ?? null }))

  // peer lists are well formed here (integer slots): how each side treats a hostile entry is its own
  // policy test, not part of the shared contract
  const peers = [
    { known: [0], peers: [{ slot: 1, ts: 1 }, { slot: 3, ts: 1 }], want: [1, 3] },
    { known: [0, 1], peers: [{ slot: 1, ts: 1 }, { slot: 0, ts: 1 }], want: [] },
    { known: [], peers: [{ slot: 2, ts: 1 }, { slot: 2, ts: 1 }], want: [2] },
    { known: [], peers: [{ slot: -1, ts: 1 }, { slot: 16, ts: 1 }, { slot: 4, ts: 1 }], want: [4] },
    { known: [], peers: [], want: [] }
  ].map((c) => ({ ...c, want: newPeerSlots(c.known, c.peers, MAX_SLOTS) }))

  return { merge, pick, peers }
}

// Health policy with an absolute clock: every step records what the implementation produced, so the Go
// port replays the same timeline and must agree on failures, pauses and usability.
function buildHealthVectors() {
  let clock = 1_000_000
  const tracker = createPlaneHealth({ now: () => clock })
  const steps = []
  const step = (op, exit, plane, atMs) => {
    clock = atMs
    let record = null
    if (op === 'fail') record = tracker.fail(exit, plane)
    else if (op === 'slow') record = tracker.slow(exit, plane)
    else tracker.ok(exit, plane)
    steps.push({
      op,
      exit,
      plane,
      atMs,
      record,
      usable: tracker.usable(exit, plane),
      degraded: tracker.degraded(exit, plane)
    })
  }
  step('fail', 'nl-1', 'reality', 1_000_000)
  step('fail', 'nl-1', 'reality', 1_010_000) // still inside the first pause
  step('fail', 'nl-1', 'hy2', 1_020_000) // a different plane of the same node is independent
  step('fail', 'fi-1', 'reality', 1_020_000) // and so is another node
  step('fail', 'nl-1', 'reality', 1_030_001) // first pause expired: second failure backs off further
  step('ok', 'nl-1', 'reality', 1_040_000) // a success clears the escalation
  step('fail', 'nl-1', 'reality', 1_050_000) // ...so this is a first failure again
  // a plane that answers slowly is not paused - it may be the only way out - but it loses its turn,
  // and answering at all ends the escalation from its earlier failures
  step('slow', 'fi-1', 'reality', 1_060_000)
  step('slow', 'nl-1', 'hy2', 1_060_000)
  step('ok', 'fi-1', 'reality', 1_070_000) // proving itself fast clears the demotion
  const cooling = tracker.cooling('nl-1')
  const coolingOther = tracker.cooling('fi-1')
  return { steps, cooling, coolingOther }
}

const FRAME_HDR_JS = 4 + 24 + 16 + 14

export function buildVectors(psk = TEST_PSK) {
  const { pk, boxKey } = deriveKeys(psk)
  const slots = []
  for (let slot = 0; slot < 4; slot++) {
    const salt = slotSalt(psk, slot)
    slots.push({
      slot,
      salt: hex(salt),
      target: hex(targetOf(pk, salt)),
      boxKey: hex(slotBoxKey(psk, slot))
    })
  }

  // Frame wire lengths are deterministic for a given payload size (only the nonce and the pad bytes are
  // random), which makes them a solid cross-implementation check on the framing layer: same buckets,
  // same header, same limit.
  const frameLengths = []
  for (const plainLen of [0, 1, 62, 63, 254, 255, 4094, 4095, 10000]) {
    const plain = Buffer.alloc(plainLen, 7)
    frameLengths.push({
      plainLen,
      data: frame2(boxKey, FRAME.DATA, 1, plain, 0n).length,
      open: frame2(boxKey, FRAME.OPEN, 1, plain, 0n).length
    })
  }
  // A recorded handshake: the random parts (ephemeral keys, nonces) are baked into the bytes, the
  // derived session keys are not. Both implementations must reproduce the same keys from the same
  // transcript, which pins the message layout, the KDF and the reply binding. The Go test reads the
  // timestamp out of msg1 and drives ExitRespond with it, so the vector never goes stale.
  const { msg1, ceSk, cePk } = hsClientInit(boxKey)
  const exitReply = hsExitRespond(boxKey, msg1)
  const clientSide = hsClientFinish(boxKey, exitReply.msg2, ceSk, cePk)
  const handshake = {
    msg1: hex(msg1),
    msg2: hex(exitReply.msg2),
    ceSk: hex(ceSk),
    cePk: hex(cePk),
    c2e: hex(clientSide.keys.c2e),
    e2c: hex(clientSide.keys.e2c)
  }

  return {
    comment: [
      'Deterministic protocol vectors shared by the Node client and the Android Go core.',
      'Generated by scripts/dev/gen-vectors.mjs from src/common.mjs; checked by',
      'app-android/core/proto/*_test.go and by scripts/dev/verify-vectors.mjs.',
      'The PSK is a test value and is not a secret.'
    ],
    psk,
    constants: {
      envelopeVersion: 4,
      offerSchema: OFFER_SCHEMA,
      maxSlots: MAX_SLOTS,
      maxSealDomain: 64,
      frameHeaderSize: FRAME_HDR_JS,
      maxFrameBytes: 4 * 1024 * 1024,
      minFrameLength: 54,
      hsMsg1Len: HS_MSG1_LEN,
      hsMsg2Len: HS_MSG2_LEN,
      hsTimestampSkewMs: HS_TS_SKEW_MS
    },
    keys: { pk: hex(pk), boxKey: hex(boxKey), salt0: hex(saltOf(psk)) },
    slots,
    frameLengths,
    handshake,
    offer: buildOfferVectors(),
    health: buildHealthVectors()
  }
}

const serialise = (vectors) => JSON.stringify(vectors, null, 2) + '\n'

export function writeVectors(file = vectorsFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, serialise(buildVectors()))
  return file
}

// Used by verify-vectors.mjs: regenerate only when the tracked file is missing or stale, so a KDF change
// shows up as a diff instead of being silently overwritten.
export function genVectorsIfStale(file = vectorsFile) {
  const wanted = serialise(buildVectors())
  let current = null
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch {}
  if (current === wanted) return { file, changed: false }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, wanted)
  return { file, changed: true }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  if (process.argv.includes('--print')) {
    process.stdout.write(serialise(buildVectors()))
  } else {
    const file = writeVectors()
    console.log(`vectors written: ${path.relative(root, file)} (${buildVectors().slots.length} slots)`)
  }
}
