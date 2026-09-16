#!/usr/bin/env node
// Fails when the exit looks up but is invisible to clients: nothing tells systemd that the DHT (or
// Nostr) publication path stopped producing reachable offers.
//
//   node scripts/healthcheck.mjs [healthFile]
//
// The health file is written by src/exit.js when MAGNETGATE_HEALTH_FILE is set (see
// systemd/magnetgate-exit.service). Exit codes: 0 healthy, 1 unhealthy, 2 unreadable.
import fs from 'node:fs'

const file =
  process.argv[2] || process.env.MAGNETGATE_HEALTH_FILE || '/var/lib/magnetgate/health.json'
const maxAgeMs = Number(process.env.MAGNETGATE_HEALTH_MAX_AGE_MS ?? 15 * 60 * 1000) // publishes every 60 s
const alertAfter = Number(process.env.MAGNETGATE_ALERT_AFTER ?? 5)

let raw
try {
  raw = fs.readFileSync(file, 'utf8')
} catch (err) {
  console.error(`healthcheck: cannot read ${file}: ${err.message}`)
  process.exit(2)
}

let h
try {
  h = JSON.parse(raw)
} catch (err) {
  console.error(`healthcheck: ${file} is not valid JSON: ${err.message}`)
  process.exit(2)
}

const publishedAt = Date.parse(h.publishedAt ?? '')
const ageMs = Number.isFinite(publishedAt) ? Date.now() - publishedAt : Infinity
const problems = []

if (!Number.isFinite(publishedAt)) problems.push('no publication recorded yet')
else if (ageMs > maxAgeMs) problems.push(`last publication was ${Math.round(ageMs / 1000)}s ago`)
if (h.dhtReady === false && h.publishedAt) problems.push('the DHT node never became ready')
if (Number(h.failures ?? 0) >= alertAfter)
  problems.push(`${h.failures} consecutive publications reached no DHT node`)
if (h.ok === false && !problems.length) problems.push('the last publication was not accepted by any node')
if (h.error) problems.push(`last error: ${h.error}`)

const summary = [
  `exit publisher: ok=${h.ok}`,
  `nodes=${h.nodes ?? '?'}/${h.dhtNodes ?? '?'}`,
  `nostr=${h.nostr ?? '?'}`,
  `seq=${h.seq ?? '?'}`,
  `failures=${h.failures ?? '?'}`,
  `published=${h.publishedAt ?? 'never'}`
].join(' ')

if (problems.length) {
  console.error(`healthcheck: UNHEALTHY — ${problems.join('; ')}`)
  console.error(`  ${summary}`)
  process.exit(1)
}
console.log(`healthcheck: healthy — ${summary}`)
