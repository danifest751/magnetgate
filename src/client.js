#!/usr/bin/env node
// node src/client.js <psk> | node src/client.js <config.json>   (env: DHT_BOOTSTRAP, MAGNETGATE_RULES)
// A config file enables multiple exits: { "exits": [{"name":"nl","psk":"..."}], ... }
import DHT from 'bittorrent-dht'
import net from 'node:net'
import fs from 'node:fs'
import {
  deriveKeys,
  saltOf,
  targetOf,
  unseal,
  bep44Verify,
  BOOTSTRAP,
  pskWarning
} from './common.mjs'
import { startSocks5Server } from './socks5.mjs'
import { connectNative } from './native-client.mjs'
import { encodeAddress } from './address.mjs'
import { atomicWrite } from './state-file.mjs'
import { DpPool } from './dp-supervisor.mjs'
import { validateConfig } from './config.cjs'
import { pickDp, mergeOffer } from './offer.mjs'

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
const exits = cfg.exits.map((e, i) => {
  const w = pskWarning(e.psk)
  if (w) console.log(ts(), `[warn] exit ${e.name ?? i}: ${w}`)
  const { pk, boxKey } = deriveKeys(e.psk)
  const salt = e.salt ? Buffer.from(e.salt, 'hex') : saltOf(e.psk)
  return {
    id: i,
    name: e.name ?? `exit${i}`,
    psk: e.psk,
    pk,
    boxKey,
    salt,
    target: targetOf(pk, salt),
    offer: null
  }
})

const dht = new DHT({ bootstrap: cfg.bootstrap, verify: bep44Verify })

// returns the exit's current fresh offer object, or null (dead exits go on cooldown)
const fresh = (e) =>
  e.offer &&
  Date.now() - e.offer.ts < OFFER_TTL_MS &&
  (!e.cooldownUntil || Date.now() > e.cooldownUntil)
    ? e.offer
    : null

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
      .map((e) => ({ id: String(e.id), name: e.name, ...e.offer }))
    atomicWrite(DP_OUT, JSON.stringify({ v: 4, exits: available }))
  } catch (e) {
    console.log(ts(), '[dp-out] write failed:', e.message)
  }
}

// accept an offer from any rendezvous channel (DHT or Nostr). Same-generation offers are merged by
// data-plane type (mergeOffer), so the pinned hy2 endpoint that only the Nostr channel carries is
// not clobbered by the compact DHT offer.
function handleOffer(e, o) {
  if (!o || o.v !== 3 || !Number.isFinite(o.ts)) return
  if (Date.now() - o.ts >= OFFER_TTL_MS || o.ts - Date.now() > 60000) return
  const merged = mergeOffer(e.offer, o)
  if (!merged) return
  const dp = pickDp(merged, DP_PREFERENCE)
  if (!dp) return
  const isNew = !e.offer || e.offer.ts !== merged.ts
  e.offer = merged
  if (isNew) {
    console.log(ts(), `[rv] offer[${e.name}] via ${dp.t}: ${dp.host}:${dp.port}`)
  }
  // publish the merged endpoints for an external engine; fires on the first offer and whenever the
  // set changes (a same-generation Nostr offer adding hy2, or a rotation changing creds).
  if (DP_OUT) writeDpOut()
}

dht.listen(() =>
  console.log(
    ts(),
    `[dht] node on port ${dht.address().port}, bootstrap=${cfg.bootstrap.join(',')}`
  )
)
dht.on('ready', () => {
  lookupAll()
  setInterval(lookupAll, 3000)
})

// second rendezvous channel: Nostr (push, instant), independent of the DHT
if (process.env.MAGNETGATE_NOSTR !== 'off') {
  import('./nostr.mjs')
    .then(({ nostrSubscriber }) => {
      for (const e of exits) e.nostr = nostrSubscriber(e.psk, e.boxKey, (o) => handleOffer(e, o))
      console.log(ts(), `[nostr] subscribed for ${exits.length} exit(s)`)
    })
    .catch((err) => console.log(ts(), `[nostr] disabled: ${err.message}`))
}

function lookupAll() {
  for (const e of exits) {
    if (e.lookupPending) continue
    e.lookupPending = true
    dht.get(e.target, { salt: e.salt }, (err, res) => {
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
  const deadline = Date.now() + 20000
  while (!exits.some(fresh) && Date.now() < deadline && !app.destroyed)
    await new Promise((r) => setTimeout(r, 100))
  const candidates = exits.filter(fresh)
  let lastError = new Error('no fresh offer')
  for (let i = 0; i < candidates.length; i++) {
    const exit = candidates[(rr + i) % candidates.length]
    for (const type of DP_PREFERENCE) {
      if (app.destroyed) throw new Error('request cancelled')
      const dp = pickDp(exit.offer, [type])
      if (!dp) continue
      try {
        const result =
          type === 'mgt'
            ? await (await getSessionFor(exit)).openStream(target)
            : await supervisor.connect(dp, target)
        if (app.destroyed) {
          result.sock.destroy()
          throw new Error('request cancelled')
        }
        rr = (rr + i + 1) % candidates.length
        console.log(ts(), '[socks]', target.host, 'via', type, 'exit', exit.name)
        return result
      } catch (err) {
        lastError = err
        console.log(ts(), '[socks] transport failed:', type, err.message)
      }
    }
    exit.cooldownUntil = Date.now() + 30000
  }
  throw lastError
}
const associations = new WeakMap()
function udpFn(req, control, sendReply) {
  let association = associations.get(control)
  if (!association) {
    const exit = exits.find(fresh)
    if (!exit) return control.destroy()
    association = {
      pendingBytes: 0,
      promise: getSessionFor(exit).then((session) => {
        if (control.destroyed) throw new Error('association closed')
        return session.openRelay(control, sendReply)
      })
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
