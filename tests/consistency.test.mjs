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

test('drift: the sealed offer schema has exactly one definition', () => {
  // The version used to be hardcoded at both ends, which is how "the exit seals v3 while the client
  // wants v4" would go unnoticed. It is now a shared constant; this test keeps it that way.
  const value = pick(common, /export const OFFER_SCHEMA = (\d+)/, 'OFFER_SCHEMA')
  assert.ok(value > 0, 'OFFER_SCHEMA must be a positive version')
  assert.match(exit, /v: OFFER_SCHEMA/, 'the exit must seal with the shared OFFER_SCHEMA')
  assert.match(client, /o\.v !== OFFER_SCHEMA/, 'the client must accept the shared OFFER_SCHEMA')
  const offerSrc = read('src/offer.mjs')
  assert.match(offerSrc, /incoming\.v !== OFFER_SCHEMA/, 'offer.mjs must validate against it too')
  for (const [name, src] of [
    ['src/exit.js', exit],
    ['src/client.js', client],
    ['src/offer.mjs', offerSrc]
  ])
    assert.ok(
      !/\.v !== 3\b|v: 3,/.test(src),
      `${name} hardcodes the offer schema instead of using OFFER_SCHEMA`
    )
})

test('drift: the offer freshness window outlives the publication interval', () => {
  const ttlMs = pick(client, /const OFFER_TTL_MS = (\d+) \* 60 \* 1000/, 'OFFER_TTL_MS') * 60_000
  const publishMs = pick(exit, /MAGNETGATE_PUBLISH_MS \?\? (\d+)/, 'the publish interval')
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
  // exit.js used to carry a third copy of the bound as a literal, where nothing would notice it
  // drifting away from the other two.
  assert.ok(
    /n < MAX_SLOTS/.test(exit),
    'exit.js hardcodes its peer-slot bound instead of using MAX_SLOTS'
  )
  // The Go port and the Android settings field are the other two copies. The settings field used to
  // accept 0..255, so a user could enter a slot the core then refuses outright.
  const goLimit = pick(
    read('app-android/core/proto/keys.go'),
    /const MaxSlots = (\d+)/,
    'MaxSlots in core/proto/keys.go'
  )
  const uiLimit = pick(
    read('app-android/app/src/main/java/ai/magnetgate/client/Settings.kt'),
    /const val MAX_SLOTS = (\d+)/,
    'MAX_SLOTS in Settings.kt'
  )
  assert.equal(goLimit, commonLimit, 'the Go core and the Node reference disagree on the slot range')
  assert.equal(uiLimit, commonLimit, 'the Android settings field accepts a different slot range')
})

test('drift: the slot env var is converted before it reaches the validator', () => {
  // This is the seam that broke on 2026-09-16: client.js split MAGNETGATE_SLOTS into strings while
  // validateConfig accepts only numbers, so every documented value died at startup with
  // "invalid slot: 0". Both halves had tests; the join between them did not.
  const block = /MAGNETGATE_SLOTS[\s\S]{0,800}/.exec(client)
  assert.ok(block, 'drift guard: could not find the MAGNETGATE_SLOTS block in client.js')
  assert.ok(
    block[0].includes('slotsFromEnv('),
    'client.js parses MAGNETGATE_SLOTS by hand again instead of using slotsFromEnv'
  )
  assert.ok(
    /export const slotsFromEnv/.test(common),
    'slotsFromEnv is gone from common.mjs but client.js still expects it'
  )
})

test('drift: STATUS.md states the number of tests that actually run', () => {
  // docs/ is gitignored, so this only runs on a machine that has the internal documentation.
  // STATUS.md declares itself the one document that must match the code, and these two numbers are
  // exactly the kind that rot quietly: nothing breaks when they are wrong, they just mislead.
  const statusPath = path.join(root, 'docs/STATUS.md')
  if (!fs.existsSync(statusPath)) return
  const status = fs.readFileSync(statusPath, 'utf8')
  const countTests = (dir, ext) =>
    fs
      .readdirSync(path.join(root, dir))
      .filter((f) => f.endsWith(ext))
      .reduce(
        (n, f) => n + (fs.readFileSync(path.join(root, dir, f), 'utf8').match(/^test\(/gm)?.length ?? 0),
        0
      )
  const core = countTests('tests', '.test.mjs')
  const app = countTests('app/tests', '.test.cjs')
  assert.equal(pick(status, /# (\d+) тест[а-яё]* ядра/, 'the core test count in STATUS.md'), core)
  assert.equal(pick(status, /# (\d+) тест[а-яё]* десктопа/, 'the desktop test count in STATUS.md'), app)
})
