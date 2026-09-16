#!/usr/bin/env node
// Fails when the exit looks up but is invisible to clients: nothing tells systemd that the DHT (or
// Nostr) publication path stopped producing reachable offers.
//
//   node scripts/healthcheck.mjs [healthFile]
//
// The health file is written by src/exit.js when MAGNETGATE_HEALTH_FILE is set (see
// systemd/magnetgate-exit.service). Exit codes: 0 healthy, 1 unhealthy, 2 unreadable.
//
// Optional notifications (both are on the node, so the credentials stay there):
//   MAGNETGATE_ALERT_WEBHOOK      POST {"text": ...} to any HTTP endpoint
//   MAGNETGATE_ALERT_TG_TOKEN     Telegram bot token, with MAGNETGATE_ALERT_TG_CHAT
//   MAGNETGATE_ALERT_COOLDOWN_MIN repeat interval while it stays broken (default 30)
//   MAGNETGATE_ALERT_STATE        where the last reported state is kept (default <healthFile>.alert)
// A recovery message is sent once when it becomes healthy again. Notification failures never change
// the exit code: a broken alert channel must not look like a healthy exit.
import fs from 'node:fs'

const file =
  process.argv[2] || process.env.MAGNETGATE_HEALTH_FILE || '/var/lib/magnetgate/health.json'
const maxAgeMs = Number(process.env.MAGNETGATE_HEALTH_MAX_AGE_MS ?? 15 * 60 * 1000) // publishes every 60 s
const alertAfter = Number(process.env.MAGNETGATE_ALERT_AFTER ?? 5)
// Expected number of peer slots, only used to make the summary readable (peers=1/1). A shortfall is
// deliberately NOT a failure here: the exit itself alerts after MAGNETGATE_PEER_ALERT_AFTER
// consecutive misses, and a single missed DHT lookup is normal.
const expectedPeers = Number(process.env.MAGNETGATE_EXPECT_PEERS ?? 0)
// A reachable mainline node ends up knowing hundreds of peers; a node stuck in double digits is not
// being reached from outside. The table does not fill instantly, though - a restarted node was at 74
// after two minutes and still climbing - so the check only applies once it has had time to bootstrap,
// otherwise every restart would alert.
const minDhtNodes = Number(process.env.MAGNETGATE_MIN_DHT_NODES ?? 100)
const dhtWarmupMs = Number(process.env.MAGNETGATE_DHT_WARMUP_MS ?? 30 * 60 * 1000)

let raw
try {
  raw = fs.readFileSync(file, 'utf8')
} catch (err) {
  console.error(`healthcheck: cannot read ${file}: ${err.message}`)
  process.exit(2)
}

let h
try {
  // tolerate a BOM: the file is written by Node, but a human editing it with an editor that adds one
  // should not turn into "not valid JSON"
  h = JSON.parse(raw.replace(/^\uFEFF/, ''))
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
// A publication that succeeds against a handful of nodes is the failure mode that looks healthiest:
// the log says "published", failures stay at 0, and clients still find nothing, because a node with a
// crippled routing table stores the offer on peers that are nowhere near the target. The usual cause
// is an unreachable DHT port (see MAGNETGATE_DHT_PORT in src/exit.js), so the table never grows.
const startedAt = Date.parse(h.startedAt ?? '')
const upMs = Number.isFinite(startedAt) ? Date.now() - startedAt : Infinity
if (upMs >= dhtWarmupMs && Number.isFinite(Number(h.dhtNodes)) && Number(h.dhtNodes) < minDhtNodes)
  problems.push(
    `the DHT routing table holds only ${h.dhtNodes} nodes (< ${minDhtNodes}) after ${Math.round(upMs / 60000)} min up: the offer is being stored on the wrong peers — check that the DHT port is reachable`
  )
if (h.error) problems.push(`last error: ${h.error}`)

const summary = [
  `exit publisher: ok=${h.ok}`,
  `nodes=${h.nodes ?? '?'}/${h.dhtNodes ?? '?'}`,
  `peers=${h.peers ?? '?'}${expectedPeers ? `/${expectedPeers}` : ''}`,
  `nostr=${h.nostr ?? '?'}`,
  `seq=${h.seq ?? '?'}`,
  `failures=${h.failures ?? '?'}`,
  `published=${h.publishedAt ?? 'never'}`
].join(' ')

const healthy = problems.length === 0
if (healthy) console.log(`healthcheck: healthy — ${summary}`)
else {
  console.error(`healthcheck: UNHEALTHY — ${problems.join('; ')}`)
  console.error(`  ${summary}`)
}

// --- optional notification ------------------------------------------------------------------------
const webhook = process.env.MAGNETGATE_ALERT_WEBHOOK
const tgToken = process.env.MAGNETGATE_ALERT_TG_TOKEN
const tgChat = process.env.MAGNETGATE_ALERT_TG_CHAT
const stateFile = process.env.MAGNETGATE_ALERT_STATE || `${file}.alert`
const cooldownMs = Number(process.env.MAGNETGATE_ALERT_COOLDOWN_MIN ?? 30) * 60 * 1000

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    return null
  }
}

async function send(text) {
  const calls = []
  if (webhook) {
    calls.push(
      fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, source: process.env.HOSTNAME || 'magnetgate' }),
        signal: AbortSignal.timeout(10000)
      })
    )
  }
  if (tgToken && tgChat) {
    calls.push(
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text }),
        signal: AbortSignal.timeout(10000)
      })
    )
  }
  for (const call of calls) {
    try {
      await call
    } catch (err) {
      console.error(`healthcheck: alert not delivered: ${err.message}`)
    }
  }
}

async function notify() {
  if (!webhook && !(tgToken && tgChat)) return
  const state = readState()
  const now = Date.now()
  if (healthy) {
    if (state && state.healthy === false) {
      await send(`magnetgate: exit recovered — ${summary}`)
      writeState({ healthy: true, at: now })
    } else if (!state) {
      writeState({ healthy: true, at: now })
    }
    return
  }
  const stillFailing = state && state.healthy === false && now - Number(state.at || 0) < cooldownMs
  if (stillFailing) return
  await send(`magnetgate: exit UNHEALTHY — ${problems.join('; ')} (${summary})`)
  writeState({ healthy: false, at: now })
}

function writeState(value) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(value))
  } catch (err) {
    console.error(`healthcheck: cannot write ${stateFile}: ${err.message}`)
  }
}

// The notification must never change what systemd sees.
try {
  await notify()
} catch (err) {
  console.error(`healthcheck: notification failed: ${err.message}`)
}
process.exit(healthy ? 0 : 1)
