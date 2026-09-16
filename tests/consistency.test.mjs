// Drift guard. Documentation and prose go stale silently; these invariants must not.
//
// A wrong `v` or a freshness window shorter than the publication interval does not fail any unit
// test вЂ” it fails in the field, hours later, in a way that looks like "the exit disappeared".
// Every number checked here is one that has already drifted at least once in this project.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const pick = (text, re, what) => {
  const m = re.exec(text)
  if (!m) throw new Error(`drift guard: could not find ${what} (pattern ${re})`)
  return Number(m[1])
}

const common = read('src/common.mjs')
const client = read('src/client.js')
const exit = read('src/exit.js')
const config = read('src/config.cjs')
const native = read('src/native-client.mjs')

test('drift: every wire version in the code agrees with the advertised one', () => {
  const envelope = pick(common, /Buffer\.from\(\[(\d+)\]\), nonce/, 'the sealed-envelope version byte')
  const handshake = pick(common, /pl\[40\] = (\d+)/, 'the handshake version byte')
  const frame = pick(common, /body\[0\] = (\d+)/, 'the frame version byte')
  const advertised = pick(exit, /protocol: (\d+)/, 'the protocol advertised in the offer')
  const required = pick(native, /dp\.protocol !== (\d+)/, 'the protocol the client requires')

  assert.equal(handshake, envelope, 'handshake and envelope version bytes')
  assert.equal(frame, envelope, 'frame and envelope version bytes')
  assert.equal(advertised, frame, 'the offer advertises a different protocol than the frames use')
  assert.equal(required, frame, 'the client requires a different protocol than the exit advertises')
})

test('drift: the sealed offer schema version matches on both sides', () => {
  const sealed = pick(exit, /JSON\.stringify\(\{ v: (\d+), ts: now, slot:/, 'the sealed offer schema')
  const accepted = pick(client, /o\.v !== (\d+)/, 'the offer schema the client accepts')
  assert.equal(sealed, accepted, 'the exit seals offer v' + sealed + ' but the client only accepts v' + accepted)
})

test('drift: the offer freshness window outlives the publication interval', () => {
  const ttlMs = pick(client, /const OFFER_TTL_MS = (\d+) \* 60 \* 1000/, 'OFFER_TTL_MS') * 60_000
  const publishMs = pick(exit, /setInterval\(publish, (\d+) \* 1000\)/, 'the publish interval') * 1000
  // the desktop-only snapshot filter is a second freshness window with the same requirement
  const snapshotMs = pick(config, /now - e\.ts < (\d+)/, 'the snapshot freshness window')

  assert.ok(ttlMs > publishMs, `client freshness ${ttlMs}ms must exceed the publish interval ${publishMs}ms`)
  assert.ok(
    snapshotMs > publishMs,
    `snapshot freshness ${snapshotMs}ms must exceed the publish interval ${publishMs}ms`
  )
  assert.ok(
    ttlMs - publishMs >= 5 * 60_000,
    'the freshness window needs margin: republishing once per interval must never let offers expire'
  )
})

test('drift: the client polls at least as fast as the offer can expire', () => {
  // whatever the poll strategy is, there must be one, and the timeout must not exceed the TTL
  const pollMs = pick(client, /const POLL_(?:FAST|SLOW)_MS = (\d+)/, 'POLL_FAST_MS/POLL_SLOW_MS')
  const ttlMs = pick(client, /const OFFER_TTL_MS = (\d+) \* 60 \* 1000/, 'OFFER_TTL_MS') * 60_000
  assert.ok(pollMs > 0 && pollMs < ttlMs, `poll interval ${pollMs}ms is not inside (0, ${ttlMs}ms)`)
})

test('drift: the documented Node version matches the engines field', () => {
  const engines = JSON.parse(read('package.json')).engines?.node
  assert.ok(engines, 'package.json declares no engines.node')
  const major = Number(/>=(\d+)\.(\d+)/.exec(engines)?.[1])
  assert.ok(major >= 20, `engines.node is ${engines}`)
  const readme = read('README.md')
  assert.ok(readme.includes(engines.match(/\d+\.\d+/)[0]), `README.md does not state the required Node ${engines}`)
  assert.ok(!/Node\.js 1[0-8]\b/.test(readme), 'README.md still recommends an unsupported Node version')
})

test('drift: the slot range is the same on both sides', () => {
  const commonLimit = pick(common, /export const MAX_SLOTS = (\d+)/, 'MAX_SLOTS in common.mjs')
  const configLimit = pick(config, /const MAX_SLOTS = (\d+)/, 'MAX_SLOTS in config.cjs')
  assert.equal(
    commonLimit,
    configLimit,
    'the client/protocol slot range and the config validator disagree'
  )
})
