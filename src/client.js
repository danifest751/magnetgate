#!/usr/bin/env node
// node src/client.js <psk> | node src/client.js <config.json>   (env: DHT_BOOTSTRAP, MAGNETGATE_RULES)
// A config file enables multiple exits: { "exits": [{"name":"nl","psk":"..."}], ... }
import DHT from 'bittorrent-dht'
import net from 'node:net'
import fs from 'node:fs'
import {
  deriveKeys,
  asSlot,
  slotsFromEnv,
  saltOf,
  slotSalt,
  slotBoxKey,
  targetOf,
  unseal,
  bep44Verify,
  BOOTSTRAP,
  pskWarning,
  hostForLog,
  OFFER_SCHEMA
} from './common.mjs'
import { startSocks5Server } from './socks5.mjs'
import { connectNative } from './native-client.mjs'
import { encodeAddress } from './address.mjs'
import { atomicWrite } from './state-file.mjs'
import { createPlaneHealth } from './health.mjs'
import { DpPool } from './dp-supervisor.mjs'
import { validateConfig } from './config.cjs'
import { pickDp, mergeOffer, newPeerSlots } from './offer.mjs'

const OFFER_TTL_MS = 12 * 60 * 1000
const ts = () => new Date().toISOString()

// One-engine (desktop app) mode. When MAGNETGATE_RENDEZVOUS_ONLY=1 the client is a pure rendezvous
// agent: it discovers exits over DHT/Nostr and writes the merged data-plane endpoints to
// MAGNETGATE_DP_OUT (atomically) for an external sing-box (TUN) to consume directly, and does NOT run
// a SOCKS server or its own sing-box supervisor. The data path then collapses from the 5-hop
// TUN->sing-box->SOCKS->node->supervisor->sing-box->exit down to TUN->sing-box->reality->exit.
const RENDEZVOUS_ONLY = process.env.MAGNETGATE_RENDEZVOUS_ONLY === '1'
const DP_OUT = process.env.MAGNETGATE_DP_OUT || null

// ---------- configuration ----------
// Precedence: config file (arg ending in .json or MAGNETGATE_CONFIG) > CLI psk.
// dataPlane: 'auto' prefers Reality/hysteria2 (via sing-box) then falls back to the native channel;
// 'mgt' forces the native channel only.
let cfg = {
  localPort: 1080,
  rules: { direct: [], proxy: [] },
  bootstrap: BOOTSTRAP,
  exits: [],
  transport: process.env.MAGNETGATE_TRANSPORT ?? 'tcp',
  dataPlane: process.env.MAGNETGATE_DATA_PLANE ?? 'auto',
  singboxPort: 1081
}
{
  const cfgArg = process.argv[2] ?? process.env.MAGNETGATE_CONFIG ?? null
  const isFile = cfgArg && cfgArg.endsWith('.json') && fs.existsSync(cfgArg)
  if (isFile) {
    // strip a BOM if present (PowerShell 5.1 writes utf8 with BOM)
    const c = JSON.parse(fs.readFileSync(cfgArg, 'utf8').replace(/^\uFEFF/, ''))
    cfg = { ...cfg, ...c, rules: { direct: [], proxy: [], ...(c.rules ?? {}) } }
    if (c.bootstrap) cfg.bootstrap = c.bootstrap
    if (!cfg.exits?.length && c.psk) cfg.exits = [{ name: 'default', psk: c.psk }]
    console.log(ts(), `[config] ${cfgArg}: ${cfg.exits.length} exit(s)`)
  } else if (cfgArg) {
    cfg.exits = [{ name: 'default', psk: cfgArg }]
  } else {
    console.error('usage: node src/client.js <psk | config.json> [localPort]')
    process.exit(1)
  }
  if (process.argv[3] && !process.argv[3].endsWith('.json'))
    cfg.localPort = parseInt(process.argv[3] ?? '1080')
}

// Multi-node: MAGNETGATE_SLOTS=0,1 expands ONE PSK into one rendezvous entry per slot
// (docs/design-multi-node.md). Explicit exits[] entries keep working exactly as before, and an
// entry that carries its own `salt` still wins over the slot derivation.
{
  const env = process.env.MAGNETGATE_SLOTS
  // slotsFromEnv turns the strings an env var always arrives as into the numbers validateConfig takes
  if (env && !cfg.slots?.length) cfg.slots = slotsFromEnv(env)
  if (cfg.slots?.length && !cfg.exits.length)
    console.log(ts(), '[warn] slots are set but no PSK was configured — ignoring them')
}
cfg = validateConfig(cfg)
if (process.env.MAGNETGATE_NATIVE_ONLY === '1') cfg.dataPlane = 'mgt'
const rules = { direct: cfg.rules.direct ?? [], proxy: cfg.rules.proxy ?? [] }
function decide(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '')
  const match = (list) =>
    list.some((e) => h === String(e).toLowerCase() || h.endsWith('.' + String(e).toLowerCase()))
  if (rules.direct?.length && match(rules.direct)) return 'direct'
  if (rules.proxy?.length) return match(rules.proxy) ? 'proxy' : 'direct'
  return 'proxy' // no rules — everything through the tunnel
}

// ---------- exits: keys, discovery, session pool ----------
const wanted =
  cfg.slots?.length && cfg.exits.length
    ? cfg.slots.map((slot) => ({
        name: `${cfg.exits[0].name ?? 'exit'}#${slot}`,
        psk: cfg.exits[0].psk,
        slot
      }))
    : cfg.exits
const exits = wanted.map((e, i) => {
  const w = pskWarning(e.psk)
  if (w) console.log(ts(), `[warn] exit ${e.name ?? i}: ${w}`)
  const { pk } = deriveKeys(e.psk)
  const slot = e.slot === undefined ? undefined : asSlot(e.slot)
  const salt = e.salt
    ? Buffer.from(e.salt, 'hex')
    : slot === undefined
      ? saltOf(e.psk)
      : slotSalt(e.psk, slot)
  const boxKey = slot === undefined ? deriveKeys(e.psk).boxKey : slotBoxKey(e.psk, slot)
  return {
    id: i,
    name: e.name ?? `exit${i}`,
    slot,
    psk: e.psk,
    pk,
    boxKey,
    salt,
    target: targetOf(pk, salt),
    offer: null
  }
})

// ---------- multi-node: learn about further slots from the nodes already known ----------
// A node holding the PSK can advertise any slot in `peers`, so this is a visible event in the log
// and can be switched off with MAGNETGATE_SLOT_DISCOVERY=0.
const SLOT_DISCOVERY = process.env.MAGNETGATE_SLOT_DISCOVERY !== '0'
function addSlotEntry(slot) {
  const base = cfg.exits[0]
  if (!base) return null
  const { pk } = deriveKeys(base.psk)
  const salt = slotSalt(base.psk, slot)
  const entry = {
    id: exits.length,
    name: `${base.name ?? 'exit'}#${slot}`,
    slot,
    psk: base.psk,
    pk,
    boxKey: slotBoxKey(base.psk, slot),
    salt,
    target: targetOf(pk, salt),
    offer: null
  }
  exits.push(entry)
  if (nostrFactory) {
    entry.nostr = nostrFactory(entry.psk, entry.boxKey, (o) => handleOffer(entry, o), slot)
    console.log(ts(), `[nostr] subscribed for slot ${slot} (discovered)`)
  }
  return entry
}

const dht = new DHT({ bootstrap: cfg.bootstrap, verify: bep44Verify })

// returns the exit's current fresh offer object, or null (an exit with no fresh offer cannot be used;
// per-plane cooldown is tracked separately — see src/health.mjs)
const fresh = (e) => (e.offer && Date.now() - e.offer.ts < OFFER_TTL_MS ? e.offer : null)
// a plane that failed recently is not retried until its cooldown expires, and the pair backs off
const planeHealth = createPlaneHealth()

// data-plane engine (sing-box) for Reality/hysteria2; the native "mgt" channel is the fallback.
// In rendezvous-only mode there is no local supervisor — the external TUN sing-box is the engine —
// but Reality/hysteria2 are still the preferred data planes (they are what we write to DP_OUT).
const supervisor = RENDEZVOUS_ONLY ? null : new DpPool({ log: (m) => console.log(ts(), m) })
if (!RENDEZVOUS_ONLY && cfg.dataPlane !== 'mgt' && !supervisor.available())
  console.log(
    ts(),
    '[dp] sing-box not found (run scripts/get-singbox.ps1) — using the native channel only'
  )
const SB_OK = cfg.dataPlane !== 'mgt' && (RENDEZVOUS_ONLY || supervisor.available())
const DP_PREFERENCE = SB_OK ? ['reality', 'hy2', 'mgt'] : ['mgt']

// atomically publish the merged data-plane list for an external engine (write tmp + rename). Only
// re-writes when the endpoints actually change, so the app doesn't restart sing-box on every poll.
function writeDpOut() {
  try {
    const available = exits
      .filter((e) => e.offer && Date.now() - e.offer.ts < OFFER_TTL_MS)
      .map((e) => ({
        id: String(e.id),
        name: e.name,
        ...e.offer,
        // which planes of this node the client is currently sitting out, so the desktop can explain
        // why a node is not being used
        cooling: planeHealth.cooling(e.id)
      }))
    atomicWrite(DP_OUT, JSON.stringify({ v: 4, exits: available }))
  } catch (e) {
    console.log(ts(), '[dp-out] write failed:', e.message)
  }
}

// accept an offer from any rendezvous channel (DHT or Nostr). Same-generation offers are merged by
// data-plane type (mergeOffer), so the pinned hy2 endpoint that only the Nostr channel carries is
// not clobbered by the compact DHT offer.
function handleOffer(e, o) {
  if (!o || o.v !== OFFER_SCHEMA || !Number.isFinite(o.ts)) return
  if (Date.now() - o.ts >= OFFER_TTL_MS || o.ts - Date.now() > 60000) return
  // A slot-derived entry accepts only the record published for its own slot. Every node holds the
  // shared PSK, so it can read any slot, but each writes just its own (and under its own per-slot
  // key) — this check keeps a mis-published record from being served as the wrong node.
  if (e.slot !== undefined && o.slot !== undefined && Number(o.slot) !== e.slot) return
  const merged = mergeOffer(e.offer, o)
  if (!merged) return
  const dp = pickDp(merged, DP_PREFERENCE)
  if (!dp) return
  const isNew = !e.offer || e.offer.ts !== merged.ts
  e.offer = merged
  // remember the node name the offer declares: with several nodes on one PSK the config label is a
  // slot ("lab#0"), which says nothing about which machine actually served a request
  if (merged.node) e.node = String(merged.node).slice(0, 40)
  if (isNew) {
    // the planes this generation advertises; without them the line reads "via mgt" even when the
    // desktop is carrying traffic over reality/hysteria2, because the app runs this child with
    // MAGNETGATE_NATIVE_ONLY=1 and the child's own preference is not what the tunnel uses.
    const planes = merged.dp.map((d) => d.t).join('+')
    const label = merged.node ? `${e.name}=${merged.node}` : e.name
    console.log(ts(), `[rv] offer[${label}] via ${dp.t}: ${dp.host}:${dp.port} (planes: ${planes})`)
    // Phase 1: learn the rest of the node set from the node we are already talking to, so adding or
    // replacing a node stops requiring a config change on every client. A node holding the PSK can
    // advertise any slot, which is why this is a visible log line (see design-multi-node.md §13.6).
    if (SLOT_DISCOVERY && cfg.slots?.length && Array.isArray(merged.peers)) {
      const known = exits.map((x) => x.slot).filter((slot) => slot !== undefined)
      for (const slot of newPeerSlots(known, merged.peers)) {
        if (!addSlotEntry(slot)) continue
        console.log(
          ts(),
          `[rv] discovered slot ${slot} via ${merged.node ?? e.name} — ${exits.length} node(s) now known`
        )
        lookupAll()
        if (DP_OUT) writeDpOut()
      }
    }
  }
  // publish the merged endpoints for an external engine; fires on the first offer and whenever the
  // set changes (a same-generation Nostr offer adding hy2, or a rotation changing creds).
  if (DP_OUT) writeDpOut()
}

const POLL_FAST_MS = 3000
// The exit republishes once a minute, so 30 s is a 2x margin; a tighter poll only adds DHT lookups
// and makes this client easier to notice in the shared DHT (see docs/design-multi-node.md §5.2).
const POLL_SLOW_MS = 30000
let pollDelay = POLL_FAST_MS
let pollTimer = null

// Poll fast until an offer is found, then back off. A constant 3 s get against one target is a lot
// of lookups (the exit republishes once a minute) and it is exactly the "anomalous activity under a
// single key" pattern our own research warns about. unref() so polling never holds the process open.
function scheduleLookup() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    try {
      await lookupAll()
    } catch {}
    pollDelay = exits.some(fresh) ? POLL_SLOW_MS : POLL_FAST_MS
    scheduleLookup()
  }, pollDelay)
  if (pollTimer.unref) pollTimer.unref()
}

dht.listen(() =>
  console.log(
    ts(),
    `[dht] node on port ${dht.address().port}, bootstrap=${cfg.bootstrap.join(',')}`
  )
)
dht.on('ready', () => {
  lookupAll()
  scheduleLookup()
})

// second rendezvous channel: Nostr (push, instant), independent of the DHT. The factory is kept so a
// slot discovered later through `peers` also gets its own subscription — without it a discovered node
// would only ever be seen over the DHT, and the hysteria2 endpoint travels exclusively on Nostr
// (the pinned cert does not fit the ~1000 B BEP44 record).
let nostrFactory = null
if (process.env.MAGNETGATE_NOSTR !== 'off') {
  import('./nostr.mjs')
    .then(({ nostrSubscriber }) => {
      nostrFactory = nostrSubscriber
      for (const e of exits)
        e.nostr = nostrSubscriber(e.psk, e.boxKey, (o) => handleOffer(e, o), e.slot ?? 0)
      console.log(ts(), `[nostr] subscribed for ${exits.length} exit(s)`)
    })
    .catch((err) => console.log(ts(), `[nostr] disabled: ${err.message}`))
}

function lookupAll() {
  for (const e of exits) {
    if (e.lookupPending) continue
    e.lookupPending = true
    // cache: false forces the network walk. bittorrent-dht answers a get from its own store first,
    // and that store is filled by whatever other nodes put to us - so a client that once received a
    // stale copy of this target would keep serving it to itself forever, never seeing a newer offer.
    // The walk itself already keeps the highest seq it is offered.
    dht.get(e.target, { salt: e.salt, cache: false }, (err, res) => {
      e.lookupPending = false
      if (err || !res?.v) return
      const plain = unseal(e.boxKey, res.v, res.seq)
      if (!plain) return
      try {
        handleOffer(e, JSON.parse(plain.toString()))
      } catch {}
    })
  }
}

// Session pool: a single authenticated connection per exit; promises prevent duplicate setup.
const sessions = new Map(),
  pending = new Map()
async function getSessionFor(exit) {
  if (sessions.has(exit.id)) return sessions.get(exit.id)
  if (!pending.has(exit.id)) {
    if (!planeHealth.usable(exit.id, 'mgt')) throw new Error('native plane is cooling down')
    const dp = pickDp(fresh(exit), ['mgt'])
    if (!dp) throw new Error('no fresh native endpoint')
    const promise = connectNative(dp, exit.boxKey, cfg.transport, () => sessions.delete(exit.id))
      .then((session) => {
        sessions.set(exit.id, session)
        return session
      })
      .finally(() => pending.delete(exit.id))
    pending.set(exit.id, promise)
  }
  return pending.get(exit.id)
}
let rr = 0
async function routeFn(target, app) {
  if (decide(target.host) === 'direct')
    return new Promise((resolve, reject) => {
      const sock = net.connect(target.port, target.host)
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error('direct timeout'))
      }, 10000)
      sock.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      sock.once('connect', () => {
        clearTimeout(timer)
        sock.pause()
        resolve({ sock })
      })
    })
  // Never hang an application request behind discovery: give a pending lookup a short grace period,
  // then fail with something actionable instead of a silent 20 s stall.
  const deadline = Date.now() + Number(process.env.MAGNETGATE_ROUTE_WAIT_MS ?? 5000)
  while (!exits.some(fresh) && Date.now() < deadline && !app.destroyed)
    await new Promise((r) => setTimeout(r, 100))
  const candidates = exits.filter(fresh)
  if (!candidates.length) {
    if (!app.destroyed) lookupAll() // make the next attempt likely to succeed
    throw new Error(
      'no exit discovered yet — check the PSK and the bootstrap list, then retry in a few seconds'
    )
  }
  let lastError = new Error('no fresh offer')
  let attempts = 0
  for (let i = 0; i < candidates.length; i++) {
    const exit = candidates[(rr + i) % candidates.length]
    for (const type of DP_PREFERENCE) {
      if (app.destroyed) throw new Error('request cancelled')
      // a pair that failed recently sits out its cooldown; the other planes of this node are still
      // tried, which is the whole point of tracking health per plane instead of per node
      if (!planeHealth.usable(exit.id, type)) continue
      const dp = pickDp(exit.offer, [type])
      if (!dp) continue
      attempts++
      try {
        const result =
          type === 'mgt'
            ? await (await getSessionFor(exit)).openStream(target)
            : await supervisor.connect(dp, target)
        if (app.destroyed) {
          result.sock.destroy()
          throw new Error('request cancelled')
        }
        planeHealth.ok(exit.id, type)
        if (DP_OUT) writeDpOut() // diagnostics should see a recovery immediately
        rr = (rr + i + 1) % candidates.length
        console.log(
          ts(),
          '[socks]',
          hostForLog(target.host),
          'via',
          type,
          'exit',
          exit.name,
          ...(exit.node && exit.node !== exit.name ? ['node', exit.node] : [])
        )
        return result
      } catch (err) {
        lastError = err
        const cooldown = planeHealth.fail(exit.id, type)
        // publish the pause at once: offers only arrive on the poll interval, and diagnostics should
        // not wait up to half a minute to explain why a node stopped being used
        if (DP_OUT) writeDpOut()
        console.log(
          ts(),
          '[socks] transport failed:',
          type,
          'exit',
          exit.name,
          `(paused ${Math.round(cooldown.backoffMs / 1000)}s after ${cooldown.fails} failure(s))`,
          err.message
        )
      }
    }
  }
  if (!attempts)
    throw new Error('every plane is cooling down after failures — retry in a few seconds')
  throw lastError
}
const associations = new WeakMap()
let udpRr = 0
function udpFn(req, control, sendReply) {
  let association = associations.get(control)
  if (!association) {
    // UDP used to take the first fresh exit and give up if it failed; fail over across exits the
    // same way the TCP path does.
    const candidates = exits.filter(fresh)
    if (!candidates.length) return control.destroy()
    association = {
      pendingBytes: 0,
      promise: (async () => {
        let lastError = null
        for (let i = 0; i < candidates.length; i++) {
          const exit = candidates[(udpRr + i) % candidates.length]
          if (!planeHealth.usable(exit.id, 'mgt')) continue
          try {
            const session = await getSessionFor(exit)
            if (control.destroyed) throw new Error('association closed')
            const relay = await session.openRelay(control, sendReply)
            planeHealth.ok(exit.id, 'mgt')
            udpRr = (udpRr + i + 1) % candidates.length
            return relay
          } catch (err) {
            lastError = err
            planeHealth.fail(exit.id, 'mgt')
          }
        }
        throw lastError ?? new Error('no exit with a usable native plane for UDP')
      })()
    }
    association.promise.catch(() => control.destroy())
    associations.set(control, association)
    control.once('close', () => associations.delete(control))
  }
  const payload = encodeAddress(req.host, req.port, req.data)
  if (association.pendingBytes + payload.length > 256 * 1024) return control.destroy()
  association.pendingBytes += payload.length
  association.promise
    .then((relay) => {
      if (!control.destroyed) relay.send(payload)
    })
    .catch(() => control.destroy())
    .finally(() => {
      association.pendingBytes -= payload.length
    })
}

// bind to loopback only — a SOCKS5 server on 0.0.0.0 is an open no-auth proxy for the LAN.
// Rendezvous-only mode skips the SOCKS server (and the whole native data path) entirely: the
// external TUN sing-box carries the data, this process only discovers exits and publishes DP_OUT.
if (RENDEZVOUS_ONLY) {
  console.log(
    ts(),
    `[rv] rendezvous-only: no SOCKS server; discovery + dp-out${DP_OUT ? ` (${DP_OUT})` : ''} only`
  )
} else {
  const SOCKS_HOST = process.env.MAGNETGATE_SOCKS_HOST ?? '127.0.0.1'
  startSocks5Server(cfg.localPort, routeFn, udpFn).listen(cfg.localPort, SOCKS_HOST, () =>
    console.log(ts(), `[socks5] listening on ${SOCKS_HOST}:${cfg.localPort}`)
  )
}

const shutdown = async () => {
  for (const session of sessions.values()) session.destroy()
  if (supervisor) await supervisor.stop()
  process.exit(0)
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
