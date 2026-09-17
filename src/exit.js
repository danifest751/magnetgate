#!/usr/bin/env node
// node src/exit.js [psk] [dataPort] [publicHost]
// Secrets/config are read from the environment first (so the PSK never lands on the process
// command line / ps output), falling back to argv for ad-hoc local runs:
//   MAGNETGATE_PSK, MAGNETGATE_PORT, MAGNETGATE_PUBLIC_HOST
import DHT from 'bittorrent-dht'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import { createExitHandler } from './exit-session.mjs'
import { sequenceStore, atomicWrite } from './state-file.mjs'
import {
  deriveKeys,
  asSlot,
  MAX_SLOTS,
  slotSalt,
  slotBoxKey,
  targetOf,
  signer,
  seal,
  unseal,
  bep44Verify,
  BOOTSTRAP,
  pskWarning,
  OFFER_SCHEMA
} from './common.mjs'

const SECRET = process.env.MAGNETGATE_PSK ?? process.env.PSK ?? process.argv[2]
const DATA_PORT = parseInt(process.env.MAGNETGATE_PORT ?? process.argv[3] ?? '49001')
const PUBLIC_HOST = process.env.MAGNETGATE_PUBLIC_HOST ?? process.argv[4] ?? null
const SEQ_FILE = process.env.MAGNETGATE_SEQ_FILE ?? null
const ts = () => new Date().toISOString()
// Optional health file for an external check (scripts/healthcheck.mjs + magnetgate-health.timer).
// An exit whose offers are accepted by no DHT node is invisible to clients while still looking
// "up" to systemd, so publication state is worth exposing.
const HEALTH_FILE = process.env.MAGNETGATE_HEALTH_FILE ?? null
const ALERT_AFTER = Number(process.env.MAGNETGATE_ALERT_AFTER ?? 5)

if (!SECRET) {
  console.error('usage: MAGNETGATE_PSK=<psk> node src/exit.js [dataPort] [publicHost]')
  process.exit(1)
}
{
  const w = pskWarning(SECRET)
  if (w) console.log(ts(), `[warn] ${w}`)
}

const { pk, sk } = deriveKeys(SECRET)
// Multi-node: this node's slot in the shared rendezvous space. Slot 0 (the default) reproduces the
// single-node values exactly, so nothing changes for an existing deployment.
const NODE_SLOT = (() => {
  try {
    return asSlot(process.env.MAGNETGATE_NODE_SLOT ?? 0)
  } catch (e) {
    console.error(`[fatal] MAGNETGATE_NODE_SLOT: ${e.message}`)
    process.exit(1)
  }
})()
const NODE_NAME = String(process.env.MAGNETGATE_NODE_NAME ?? `slot${NODE_SLOT}`).slice(0, 40)
// ISO-3166 alpha-2 code the client may show so a user can pick a country without ever seeing an
// address. Optional: an exit without it simply does not appear in the country list.
const NODE_COUNTRY = (() => {
  const value = String(process.env.MAGNETGATE_NODE_COUNTRY ?? '')
    .trim()
    .toUpperCase()
  if (!value) return null
  if (!/^[A-Z]{2}$/.test(value)) {
    console.error('[fatal] MAGNETGATE_NODE_COUNTRY must be a two-letter code (e.g. NL, FI)')
    process.exit(1)
  }
  return value
})()
const boxKey = slotBoxKey(SECRET, NODE_SLOT)
const SALT = slotSalt(SECRET, NODE_SLOT)
console.log(
  ts(),
  `[node] ${NODE_NAME} on slot ${NODE_SLOT}${NODE_COUNTRY ? ` in ${NODE_COUNTRY}` : ''}${
    NODE_SLOT === 0 ? ' (single-node layout)' : ''
  }`
)

// ---------- signaling (rendezvous: DHT + optional Nostr, same sealed offer) ----------
let nostr = null
if (process.env.MAGNETGATE_NOSTR !== 'off') {
  try {
    const { nostrPublisher } = await import('./nostr.mjs')
    nostr = nostrPublisher(SECRET, NODE_SLOT)
    console.log(ts(), `[nostr] publishing offers to ${nostr.relays} relay(s)`)
  } catch (e) {
    console.log(ts(), `[nostr] disabled: ${e.message}`)
  }
}

const dht = new DHT({ bootstrap: BOOTSTRAP, verify: bep44Verify })
const nextSequence = sequenceStore(SEQ_FILE)
let dhtReady = false

// --- publication health ----------------------------------------------------------------------------
let failures = 0
let publishing = false
const health = {
  startedAt: ts(),
  slot: NODE_SLOT,
  node: NODE_NAME,
  country: NODE_COUNTRY,
  nostr: nostr ? 'enabled' : 'disabled',
  publishedAt: null,
  ok: null,
  nodes: 0,
  dhtNodes: 0,
  dhtReady: false,
  seq: null,
  failures: 0,
  peers: 0,
  peersSeen: [],
  error: null
}
function writeHealth(patch = {}) {
  Object.assign(health, patch)
  if (!HEALTH_FILE) return
  try {
    atomicWrite(HEALTH_FILE, JSON.stringify(health, null, 2))
  } catch (e) {
    console.log(ts(), `[health] write failed: ${e.message}`)
  }
}
writeHealth()

function autoIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list ?? []) if (!i.internal && i.family === 'IPv4') return i.address
  return '127.0.0.1'
}

// extra data-plane endpoints (Reality/hysteria2) advertised via a file that a sing-box setup /
// rotation writes; read fresh each publish so rotation is picked up automatically.
const DP_FILE = process.env.MAGNETGATE_DP_FILE ?? '/etc/magnetgate-dp.json'
function readExtraDp() {
  try {
    if (!fs.existsSync(DP_FILE)) return []
    const arr = JSON.parse(fs.readFileSync(DP_FILE, 'utf8')).dp
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

// Routing rule-sets a client should be using: where each one lives, how big it is and what it must
// hash to (scripts/update-rulesets.mjs writes this). No list contents travel here - only the decision
// about which ones are current, sealed with the key derived from the PSK like every other field, so a
// mirror that serves something else cannot retune anyone's routing.
const RULESETS_FILE = process.env.MAGNETGATE_RULESETS_FILE ?? '/etc/magnetgate-rulesets.json'
function readRuleSets() {
  try {
    if (!fs.existsSync(RULESETS_FILE)) return null
    const doc = JSON.parse(fs.readFileSync(RULESETS_FILE, 'utf8').replace(/^\uFEFF/, ''))
    const v = Number(doc?.v)
    const sets = Array.isArray(doc?.sets) ? doc.sets : []
    if (!Number.isInteger(v) || v < 1 || !sets.length) return null
    const clean = sets
      .filter(
        (s) =>
          typeof s?.tag === 'string' &&
          /^https:\/\//.test(s?.url ?? '') &&
          /^[0-9a-f]{64}$/.test(s?.sha256 ?? '') &&
          Number.isInteger(s?.bytes) &&
          s.bytes > 0
      )
      .map((s) => ({ tag: s.tag.slice(0, 32), url: s.url, sha256: s.sha256, bytes: s.bytes }))
    return clean.length ? { v, sets: clean } : null
  } catch {
    return null
  }
}

// --- peer discovery (multi-node Phase 1) -----------------------------------------------------------
// Scanning other slots is opt-in: an idle single-node deployment must not add DHT lookups nobody
// asked for. Set MAGNETGATE_PEER_SLOTS=0,1 on each node once there is more than one.
const PEER_SLOTS = (process.env.MAGNETGATE_PEER_SLOTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isInteger(n) && n >= 0 && n < MAX_SLOTS && n !== NODE_SLOT)
const EXPECT_PEERS = Number(process.env.MAGNETGATE_EXPECT_PEERS ?? 0)
// A single missed scan is normal: a DHT lookup is best-effort and occasionally comes back empty for a
// node that is perfectly alive (observed on 2026-09-16). Only a sustained shortfall is worth an alert,
// otherwise the log fills with false "a node may be down" lines.
const PEER_ALERT_AFTER = Number(process.env.MAGNETGATE_PEER_ALERT_AFTER ?? 3)
let peerMisses = 0
const PEER_FRESH_MS = 12 * 60 * 1000 // must match the client's freshness window
const PEER_TIMEOUT_MS = 5000
let scanning = false

function lookupSlot(slot) {
  return new Promise((resolve) => {
    const salt = slotSalt(SECRET, slot)
    let done = false
    const finish = (value) => {
      if (!done) {
        done = true
        resolve(value)
      }
    }
    const timer = setTimeout(() => finish(null), PEER_TIMEOUT_MS)
    try {
      // cache: false for the same reason as in client.js: a locally cached copy would freeze this
      // node's view of its peer and make a departed node look alive.
      dht.get(targetOf(pk, salt), { salt, cache: false }, (err, res) => {
        clearTimeout(timer)
        if (err || !res?.v) return finish(null)
        const plain = unseal(slotBoxKey(SECRET, slot), res.v, res.seq)
        if (!plain) return finish(null)
        try {
          const o = JSON.parse(plain.toString())
          if (!Number.isFinite(o?.ts) || Date.now() - o.ts >= PEER_FRESH_MS) return finish(null)
          if (Number(o.slot ?? slot) !== slot) return finish(null)
          finish({ slot, ts: o.ts, node: String(o.node ?? `slot${slot}`).slice(0, 40) })
        } catch {
          finish(null)
        }
      })
    } catch {
      clearTimeout(timer)
      finish(null)
    }
  })
}

async function scanPeers() {
  if (!PEER_SLOTS.length || !dhtReady || scanning) return null
  scanning = true
  try {
    return (await Promise.all(PEER_SLOTS.map(lookupSlot))).filter(Boolean)
  } finally {
    scanning = false
  }
}

function publish() {
  if (publishing) return
  publishing = true
  return publishOnce().finally(() => {
    publishing = false
  })
}

async function publishOnce() {
  // who else is alive in the slot space (only when PEER_SLOTS is configured)
  const peers = (await scanPeers()) ?? health.peersSeen ?? []
  let seq
  try {
    seq = nextSequence()
  } catch (e) {
    console.error(ts(), 'publication blocked: sequence persistence failed', e.message)
    return
  }
  const udp = process.env.MAGNETGATE_TRANSPORT === 'udp' ? 1 : undefined
  const mgt = { t: 'mgt', protocol: 4, host: PUBLIC_HOST ?? autoIp(), port: DATA_PORT, udp }
  const extra = readExtraDp()
  const now = Date.now()
  // Offer v3: an extensible list of data-plane endpoints (Reality/hysteria2 from the dp file are
  // preferred; the native "mgt" channel is the fallback). Two channel views of the SAME generation
  // (same ts) — the client merges them by dp type:
  //   - DHT: compact, omits hy2 (its pinned cert is too large for the ~1000 B BEP44 limit);
  //   - Nostr: superset, includes the pinned hy2 endpoint (cert carried in dp.ca).
  // Each envelope has a random nonce and an authenticated channel/sequence domain.
  // `peers` (compact: slot + ts) lets a client that knows one slot learn the others without config.
  const peerList = peers.map((p) => ({ slot: p.slot, ts: p.ts }))
  const base = { v: OFFER_SCHEMA, ts: now, slot: NODE_SLOT, node: NODE_NAME, country: NODE_COUNTRY, peers: peerList }
  const dhtDp = [...extra.filter((d) => d.t !== 'hy2'), mgt]
  const sealed = seal(boxKey, Buffer.from(JSON.stringify({ ...base, dp: dhtDp })), seq)
  if (sealed.length > 950)
    console.log(ts(), `[warn] DHT offer ${sealed.length}B may exceed the ~1000B limit`)
  if (nostr) {
    // The rule-set manifest rides the Nostr view only, for the same reason the pinned hy2 certificate
    // does: it does not fit the ~1000 B BEP44 record, and squeezing it in would cost the endpoints.
    const rs = readRuleSets()
    const nostrDp = [...extra, mgt]
    const nseq = 'n' + seq
    const sealedNostr = seal(boxKey, Buffer.from(JSON.stringify({ ...base, dp: nostrDp, ...(rs ? { rs } : {}) })), nseq)
    nostr.publish(sealedNostr, nseq)
  }
  writeHealth({ peers: peers.length, peersSeen: peerList })
  if (EXPECT_PEERS > 0 && peers.length < EXPECT_PEERS) {
    peerMisses++
    if (peerMisses >= PEER_ALERT_AFTER)
      console.log(
        ts(),
        `[alert] only ${peers.length}/${EXPECT_PEERS} peer slot(s) answered ${peerMisses} times in a row - a node may be down`
      )
  } else {
    peerMisses = 0
  }
  if (!dhtReady) return
  dht.put(
    {
      k: pk,
      salt: SALT,
      seq,
      sign: signer(sk),
      v: sealed
    },
    (err, _h, n) => {
      const nodes = typeof n === 'number' ? n : 0
      let dhtNodes = 0
      try {
        dhtNodes = dht.nodes.toArray().length
      } catch {}
      if (err) console.log(ts(), `[dht] put failed: ${err.message}`)
      else console.log(ts(), `[dht] published (n=${nodes}, peers=${peers.length})`)
      failures = !err && nodes > 0 ? 0 : failures + 1
      if (failures >= ALERT_AFTER)
        console.log(
          ts(),
          `[alert] ${failures} consecutive publications reached no DHT node - clients that rely on DHT cannot find this exit`
        )
      writeHealth({
        publishedAt: ts(),
        ok: !err && nodes > 0,
        nodes,
        dhtNodes,
        seq,
        failures,
        error: err ? err.message : null
      })
    }
  )
}

// A DHT node that cannot be reached from outside still publishes: it queries, gets replies through
// conntrack and reports a successful put. What it cannot do is learn the network — nobody can ask it
// anything, so its routing table stays tiny and the "closest nodes to the target" it stores the offer
// on are nowhere near the real ones. The record then exists on nodes no lookup ever visits, and a
// client sees a stale offer or none at all while the exit's log says "published". Binding an ephemeral
// port made that the default, because no firewall can allow a port that changes on every restart.
// Set MAGNETGATE_DHT_PORT to a port that is actually open (0 keeps the old random behaviour).
const DHT_PORT = parseInt(process.env.MAGNETGATE_DHT_PORT ?? '0') || 0
dht.listen(DHT_PORT, () => {
  const bound = dht.address().port
  console.log(ts(), `[dht] node on port ${bound}, bootstrap=${BOOTSTRAP.join(',')}`)
  if (!DHT_PORT)
    console.log(
      ts(),
      `[warn] the DHT port is ephemeral (${bound}) — it changes on restart and cannot be opened in a firewall; set MAGNETGATE_DHT_PORT`
    )
})
dht.on('ready', () => {
  dhtReady = true
  writeHealth({ dhtReady: true })
  setTimeout(publish, 2000)
})
// Nostr publication is independent of DHT readiness. Poll file contents across atomic replacements.
setTimeout(publish, 100)
// Republish cadence. Overridable so tests and the multi-node lab do not have to wait a minute; the
// client's freshness window (12 min) must stay far above whatever is set here.
const PUBLISH_MS = Number(process.env.MAGNETGATE_PUBLISH_MS ?? 60000)
setInterval(publish, PUBLISH_MS)
let lastDp = JSON.stringify(readExtraDp())
setInterval(() => {
  const value = JSON.stringify(readExtraDp())
  if (value !== lastDp) {
    lastDp = value
    publish()
  }
}, 1000)

const handleSession = createExitHandler({
  boxKey,
  allowPrivate: process.env.MAGNETGATE_ALLOW_PRIVATE === '1',
  maxSessions: Number(process.env.MAGNETGATE_MAX_SESSIONS || 512),
  maxPending: Number(process.env.MAGNETGATE_MAX_PENDING || 64),
  maxStreams: Number(process.env.MAGNETGATE_MAX_STREAMS || 256),
  handshakeMs: Number(process.env.MAGNETGATE_HANDSHAKE_MS || 5000),
  log: (message) => console.log(ts(), message)
})

net
  .createServer(handleSession)
  .listen(DATA_PORT, () => console.log(ts(), `[data] listening on ${DATA_PORT}`))

// optional UDP transport (same port, datagram carriage): MAGNETGATE_TRANSPORT=udp
if (process.env.MAGNETGATE_TRANSPORT === 'udp') {
  const { ExitUdpMux } = await import('./udpsess.mjs')
  new ExitUdpMux({
    port: DATA_PORT,
    boxKey,
    onConn: (conn, rinfo) => {
      console.log(ts(), `[data] udp stream from ${rinfo.address}:${rinfo.port}`)
      handleSession(conn)
    }
  })
  console.log(ts(), `[data] udp transport enabled on ${DATA_PORT}/udp`)
}
