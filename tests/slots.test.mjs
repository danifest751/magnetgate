// Multi-node slots (docs/design-multi-node.md). The whole compatibility story rests on one thing:
// slot 0 must reproduce the single-node values exactly, so an existing deployment needs no migration.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_SLOTS,
  asSlot,
  deriveKeys,
  saltOf,
  slotSalt,
  slotBoxKey,
  targetOf
} from '../src/common.mjs'
import { mergeOffer } from '../src/offer.mjs'

const PSK = '0123456789abcdef0123456789abcdef'

test('slot 0 is byte-identical to the single-node derivation', () => {
  assert.deepEqual(slotSalt(PSK, 0), saltOf(PSK), 'slot 0 salt must equal saltOf')
  assert.deepEqual(slotBoxKey(PSK, 0), deriveKeys(PSK).boxKey, 'slot 0 box key must equal boxKey')
  assert.deepEqual(slotSalt(PSK), saltOf(PSK), 'the default slot is 0')
  assert.deepEqual(slotBoxKey(PSK), deriveKeys(PSK).boxKey)
})

test('every slot gets a distinct salt, box key and target', () => {
  const { pk } = deriveKeys(PSK)
  const salts = new Set()
  const keys = new Set()
  const targets = new Set()
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const salt = slotSalt(PSK, slot)
    salts.add(salt.toString('hex'))
    keys.add(slotBoxKey(PSK, slot).toString('hex'))
    targets.add(targetOf(pk, salt).toString('hex'))
  }
  assert.equal(salts.size, MAX_SLOTS)
  assert.equal(keys.size, MAX_SLOTS)
  assert.equal(targets.size, MAX_SLOTS, 'two slots must never collide on the rendezvous target')
  // deterministic, and different PSKs give different spaces
  assert.deepEqual(slotSalt(PSK, 3), slotSalt(PSK, 3))
  assert.notDeepEqual(slotSalt(PSK, 3), slotSalt('another-psk-entirely', 3))
})

test('slot values outside the range are rejected', () => {
  for (const bad of [-1, MAX_SLOTS, 1.5, 'x', null])
    assert.throws(() => asSlot(bad), /invalid node slot/)
  assert.equal(asSlot('2'), 2, 'numeric strings are accepted')
})

test('config normalises the slot list and rejects out-of-range values', async () => {
  const mod = await import('../src/config.cjs')
  const validateConfig = mod.validateConfig ?? mod.default.validateConfig
  assert.deepEqual(validateConfig({ slots: [2, 0, 2, 1] }).slots, [0, 1, 2], 'sorted and deduped')
  assert.deepEqual(validateConfig({}).slots, [], 'no slots by default')
  for (const bad of [{ slots: '0,1' }, { slots: [MAX_SLOTS] }, { slots: [-1] }, { slots: [1.5] }, { slots: Array(MAX_SLOTS + 1).fill(0) }])
    assert.throws(() => validateConfig(bad), /invalid slot/)
})

test('merging same-generation offers keeps the slot and node identity', () => {
  const older = { v: 3, ts: 1000, slot: 1, node: 'nl-2', dp: [{ t: 'mgt', host: 'a', port: 1 }] }
  const sameGen = { v: 3, ts: 1000, slot: 1, node: 'nl-2', dp: [{ t: 'hy2', host: 'b', port: 2 }] }
  const merged = mergeOffer(older, sameGen)
  assert.equal(merged.slot, 1)
  assert.equal(merged.node, 'nl-2')
  assert.equal(merged.dp.length, 2, 'the union still happens')
  // a newer generation replaces outright, including its identity
  const newer = { v: 3, ts: 2000, slot: 1, node: 'nl-9', dp: [{ t: 'mgt', host: 'c', port: 3 }] }
  assert.equal(mergeOffer(older, newer).node, 'nl-9')
})

test('newPeerSlots: only in-range, not-yet-known slots are added, once', async () => {
  const { newPeerSlots } = await import('../src/offer.mjs')
  assert.deepEqual(newPeerSlots([0], [{ slot: 1 }, { slot: 3 }]), [1, 3], 'sorted, new slots')
  assert.deepEqual(newPeerSlots([0, 1], [{ slot: 1 }, { slot: 0 }]), [], 'known slots are skipped')
  assert.deepEqual(newPeerSlots([], [{ slot: 2 }, { slot: 2 }]), [2], 'duplicates collapse')
  // anything a node should not be able to talk a client into
  assert.deepEqual(
    newPeerSlots([], [{ slot: -1 }, { slot: 16 }, { slot: 1.5 }, { slot: 'x' }, {}, null, { slot: 4 }]),
    [4]
  )
  assert.deepEqual(newPeerSlots([], undefined), [], 'no peers list is not an error')
  assert.deepEqual(newPeerSlots([], [{ slot: 15 }], 16), [15], 'the top slot is still valid')
})

test('nostr: two slots never share a replaceable-event key, and slot 0 keeps the old tag', async () => {
  const crypto = await import('node:crypto')
  const { nostrTagOf } = await import('../src/nostr.mjs')
  const legacy = crypto
    .createHash('sha256')
    .update('mgt-nostr-d:' + PSK)
    .digest('hex')
    .slice(0, 32)
  assert.equal(nostrTagOf(PSK, 0), legacy, 'slot 0 must keep the legacy d tag (old clients)')
  assert.equal(nostrTagOf(PSK), legacy, 'no slot means slot 0')
  const tags = new Set()
  for (let slot = 0; slot < 4; slot++) tags.add(nostrTagOf(PSK, slot))
  assert.equal(tags.size, 4, 'every slot needs its own d tag or the nodes overwrite each other')
  assert.notEqual(nostrTagOf(PSK, 1), nostrTagOf('another-psk', 1), 'different PSKs stay separate')
})

test('newPeerSlots: a malformed slot is ignored, never read as slot 0', async () => {
  const { newPeerSlots } = await import('../src/offer.mjs')
  // Number(null) === 0, so the earlier lax version silently opted a client into slot 0; the Node side
  // and the Go port now both require a real integer (app-android/core/offer TestParsePeersIsStrict)
  assert.deepEqual(
    newPeerSlots([], [{ slot: null }, { slot: '2' }, {}, { ts: 5 }, { slot: 0 }]),
    [0],
    'only the entry with a real integer slot survives'
  )
})
