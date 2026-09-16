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
const boxKey = slotBoxKey(SECRET, NODE_SLOT)
const SALT = slotSalt(SECRET, NODE_SLOT)
console.log(
  ts(),
  `[node] ${NODE_NAME} on slot ${NODE_SLOT}${NODE_SLOT === 0 ? ' (single-node layout)' : ''}`
)

// ---------- signaling (rendezvous: DHT + optional Nostr, same sealed offer) ----------
let nostr = null
if (process.env.MAGNETGATE_NOSTR !== 'off') {
  try {
    const { nostrPublisher } = await import('./nostr.mjs')
    nostr = nostrPublisher(SECRET)
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

// --- peer discovery (multi-node Phase 1) -----------------------------------------------------------
// Scanning other slots is opt-in: an idle single-node deployment must not add DHT lookups nobody
// asked for. Set MAGNETGATE_PEER_SLOTS=0,1 on each node once there is more than one.
const PEER_SLOTS = (process.env.MAGNETGATE_PEER_SLOTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isInteger(n) && n >= 0 && n < 16 && n !== NODE_SLOT)
const EXPECT_PEERS = Number(process.env.MAGNETGATE_EXPECT_PEERS ?? 0)
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
      dht.get(targetOf(pk, salt), { salt }, (err, res) => {
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
  const base = { v: OFFER_SCHEMA, ts: now, slot: NODE_SLOT, node: NODE_NAME, peers: peerList }
  const dhtDp = [...extra.filter((d) => d.t !== 'hy2'), mgt]
  const sealed = seal(boxKey, Buffer.from(JSON.stringify({ ...base, dp: dhtDp })), seq)
  if (sealed.length > 950)
    console.log(ts(), `[warn] DHT offer ${sealed.length}B may exceed the ~1000B limit`)
  if (nostr) {
    const nostrDp = [...extra, mgt]
    const nseq = 'n' + seq
    const sealedNostr = seal(boxKey, Buffer.from(JSON.stringify({ ...base, dp: nostrDp })), nseq)
    nostr.publish(sealedNostr, nseq)
  }
  writeHealth({ peers: peers.length, peersSeen: peerList })
  if (EXPECT_PEERS > 0 && peers.length < EXPECT_PEERS)
    console.log(
      ts(),
      `[alert] only ${peers.length}/${EXPECT_PEERS} peer slot(s) answered - a node may be down`
    )
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

dht.listen(() =>
  console.log(ts(), `[dht] node on port ${dht.address().port}, bootstrap=${BOOTSTRAP.join(',')}`)
)
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
