#!/usr/bin/env node
// node src/client.js <psk> | node src/client.js <config.json>   (env: DHT_BOOTSTRAP, MAGNETGATE_RULES)
// A config file enables multiple exits: { "exits": [{"name":"nl","psk":"..."}], ... }
import DHT from 'bittorrent-dht'
import net from 'node:net'
import fs from 'node:fs'
import {
  deriveKeys, saltOf, targetOf, unseal, frame2, makeCodecV2, FRAME,
  bep44Verify, BOOTSTRAP, hsClientInit, hsClientFinish, pskWarning,
} from './common.mjs'
import { startSocks5Server } from './socks5.mjs'
import { createClientUdpStream } from './udpsess.mjs'

const OFFER_TTL_MS = 12 * 60 * 1000
const ts = () => new Date().toISOString()

// ---------- configuration ----------
// Precedence: config file (arg ending in .json or MAGNETGATE_CONFIG) > CLI psk.
let cfg = { localPort: 1080, rules: { direct: [], proxy: [] }, bootstrap: BOOTSTRAP, exits: [], transport: process.env.MAGNETGATE_TRANSPORT ?? 'tcp' }
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
  if (process.argv[3] && !process.argv[3].endsWith('.json')) cfg.localPort = parseInt(process.argv[3] ?? '1080')
}

const rules = { direct: cfg.rules.direct ?? [], proxy: cfg.rules.proxy ?? [] }
function decide(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '')
  const match = (list) => list.some(e => h === String(e).toLowerCase() || h.endsWith('.' + String(e).toLowerCase()))
  if (rules.direct?.length && match(rules.direct)) return 'direct'
  if (rules.proxy?.length) return match(rules.proxy) ? 'proxy' : 'direct'
  return 'proxy' // no rules — everything through the tunnel
}

// ---------- exits: keys, discovery, session pool ----------
const exits = cfg.exits.map((e, i) => {
  const w = pskWarning(e.psk); if (w) console.log(ts(), `[warn] exit ${e.name ?? i}: ${w}`)
  const { pk, boxKey } = deriveKeys(e.psk)
  const salt = e.salt ? Buffer.from(e.salt, 'hex') : saltOf(e.psk)
  return { id: i, name: e.name ?? `exit${i}`, pk, boxKey, salt, target: targetOf(pk, salt), offer: null }
})

const dht = new DHT({ bootstrap: cfg.bootstrap, verify: bep44Verify })

// returns the exit's current fresh offer object, or null (dead exits go on cooldown)
const fresh = (e) =>
  (e.offer && Date.now() - e.offer.ts < OFFER_TTL_MS && (!e.cooldownUntil || Date.now() > e.cooldownUntil))
    ? e.offer : null

dht.listen(() => console.log(ts(), `[dht] node on port ${dht.address().port}, bootstrap=${cfg.bootstrap.join(',')}`))
dht.on('ready', () => {
  lookupAll()
  setInterval(lookupAll, 3000)
})

function lookupAll() {
  for (const e of exits) {
    if (fresh(e)) continue
    dht.get(e.target, { salt: e.salt }, (err, res) => {
      if (err || !res?.v) return
      const plain = unseal(e.boxKey, res.v, res.seq)
      if (!plain) return
      try {
        const o = JSON.parse(plain.toString())
        if (o.v === 2 && Date.now() - o.ts < OFFER_TTL_MS) {
          const isNew = !e.offer || e.offer.ts !== o.ts
          e.offer = o
          if (isNew) console.log(ts(), `[dht] offer[${e.name}]: ${o.host}:${o.port}`)
        }
      } catch {}
    })
  }
}

// ---------- multiplexed sessions, one per exit ----------
const sessions = new Map() // exitId -> Session
const sessionPromises = new Map() // exitId -> Promise<Session>

class Session {
  constructor(exit, sock, keys) {
    this.exit = exit
    this.sock = sock
    this.keys = keys
    this.streams = new Map() // streamId -> app socket (TCP)
    this.stats = { up: 0, down: 0, streams: 0 }
    this.relays = new Map()  // streamId -> { control, sendReply } (UDP)
    this.nextId = 1
    this.lastPong = Date.now()
    sock.on('data', (c) => this.codec.push(c))
    sock.on('error', (e) => console.log(ts(), `[data][${exit.name}] session error: ${e.message}`))
    sock.on('close', () => this.teardown())
    this.ping = setInterval(() => {
      if (sessions.get(exit.id) !== this) return clearInterval(this.ping)
      try { sock.write(frame2(keys.c2e, FRAME.PING, 0, Buffer.from('p'))) } catch {}
      if (Date.now() - this.lastPong > 30000) {
        console.log(ts(), `[data][${exit.name}] session dead (no pong)`)
        this.teardown()
      }
    }, 20000)
    this.codec = makeCodecV2(keys.e2c, (type, id, plain) => {
      this.lastPong = Date.now()
      if (type === FRAME.DATA) {
        const app = this.streams.get(id)
        this.stats.down += plain.length
        if (app && !app.destroyed) app.write(plain)
      } else if (type === FRAME.UDP_DATA) {
        const r = this.relays.get(id)
        if (r) r.sendReply(plain)
      } else if (type === FRAME.CLOSE) {
        const app = this.streams.get(id)
        if (app) { this.streams.delete(id); try { app.destroy() } catch {} }
        const relay = this.relays.get(id)
        if (relay) { this.relays.delete(id); try { relay.control.destroy() } catch {} }
      }
    }, () => this.teardown())
  }

  teardown() {
    if (sessions.get(this.exit.id) === this) sessions.delete(this.exit.id)
    clearInterval(this.ping)
    for (const app of this.streams.values()) { try { app.destroy() } catch {} }
    this.streams.clear()
    for (const r of this.relays.values()) { try { r.control.destroy() } catch {} }
    this.relays.clear()
    try { this.sock.destroy() } catch {}
  }

  // UDP relay: association lives on the exit; the SOCKS control connection keeps it alive
  openRelay(first, control, sendReply) {
    const id = this.nextId++ & 0x7fffffff || 1
    this.relays.set(id, { control, sendReply })
    try {
      this.sock.write(frame2(this.keys.c2e, FRAME.UDP_ASSOC, id, first ?? Buffer.alloc(0)))
      control.on('close', () => { try { this.sock.write(frame2(this.keys.c2e, FRAME.UDP_CLOSE, id, Buffer.alloc(0))) } catch {} })
    } catch (e) {
      console.log(ts(), `[data][${this.exit.name}] relay #${id} open failed: ${e.message}`)
      control.destroy()
    }
    return id
  }

  openStream(target, app, firstData) {
    const id = this.nextId++ & 0x7fffffff || 1
    this.streams.set(id, app)
    this.stats.streams++
    try {
      this.sock.write(frame2(this.keys.c2e, FRAME.OPEN, id, Buffer.from(JSON.stringify(target))))
      if (firstData?.length) this.sock.write(frame2(this.keys.c2e, FRAME.DATA, id, firstData))
      app.on('data', (d) => { this.stats.up += d.length; try { this.sock.write(frame2(this.keys.c2e, FRAME.DATA, id, d)) } catch {} })
      app.on('close', () => { try { this.sock.write(frame2(this.keys.c2e, FRAME.CLOSE, id, Buffer.alloc(0))) } catch {} })
    } catch (e) {
      console.log(ts(), `[data][${this.exit.name}] stream #${id} open failed: ${e.message}`)
      app.destroy()
    }
    return { id, write: (d) => { try { this.sock.write(frame2(this.keys.c2e, FRAME.DATA, id, d)) } catch {} } }
  }
}

// forward-secret handshake (protocol v3) over a byte stream (net.Socket or ReliableStream):
// send [u16 len][msg1], read [u16 len][msg2], derive per-session ephemeral keys.
function fsHandshake(stream, boxKey) {
  return new Promise((resolve, reject) => {
    const { msg1, ceSk, cePk } = hsClientInit(boxKey)
    let buf = Buffer.alloc(0)
    let done = false
    const onData = (chunk) => {
      if (done) return
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 2) return
      const len = buf.readUInt16BE(0)
      if (len > 4096) { done = true; stream.removeListener('data', onData); return reject(new Error('bad handshake')) }
      if (buf.length < 2 + len) return
      done = true
      stream.removeListener('data', onData)
      const r = hsClientFinish(boxKey, buf.subarray(2, 2 + len), ceSk, cePk)
      if (!r) return reject(new Error('handshake auth failed'))
      resolve({ keys: r.keys, leftover: buf.subarray(2 + len) })
    }
    stream.on('data', onData)
    const hdr = Buffer.alloc(2); hdr.writeUInt16BE(msg1.length, 0)
    try { stream.write(Buffer.concat([hdr, msg1])) } catch (e) { reject(e) }
  })
}

function connectSession(exit, offer) {
  const promise = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 20000)

    // run the forward-secret handshake, then stand up the Session
    const establish = (stream, label, onFail) => {
      fsHandshake(stream, exit.boxKey).then(({ keys, leftover }) => {
        const s = new Session(exit, stream, keys)
        if (leftover.length) s.codec.push(leftover)
        sessions.set(exit.id, s)
        sessionPromises.delete(exit.id)
        console.log(ts(), `[data][${exit.name}] ${label} session to ${offer.host}:${offer.port} established`)
        clearTimeout(t); resolve(s)
      }).catch((e) => {
        try { stream.destroy() } catch {}
        if (onFail) return onFail(e)          // keep the overall timeout guarding the fallback
        clearTimeout(t); reject(e)
      })
    }

    const useUdp = cfg.transport !== 'tcp' && offer.udp === 1
    if (useUdp) {
      const toTcp = (e) => { console.log(ts(), `[data][${exit.name}] udp failed (${e.message}), falling back to tcp`); tcpConnect() }
      createClientUdpStream({ remote: { host: offer.host, port: offer.port }, boxKey: exit.boxKey })
        .then((stream) => establish(stream, 'udp', toTcp))
        .catch(toTcp)
      return
    }

    tcpConnect()
    function tcpConnect() {
      const sock = net.connect(offer.port, offer.host)
      sock.setKeepAlive(true, 15000)
      sock.on('connect', () => establish(sock, 'tcp', null))
      sock.on('error', (e) => { clearTimeout(t); reject(e) })
    }
  })
  promise.finally(() => { if (sessionPromises.get(exit.id) === promise) sessionPromises.delete(exit.id) }).catch(() => {})
  return promise
}

function getSessionFor(exit) {
  const live = sessions.get(exit.id)
  if (live) return Promise.resolve(live)
  if (!sessionPromises.has(exit.id)) {
    const offer = fresh(exit)
    if (!offer) return Promise.reject(new Error(`[${exit.name}] no offer yet`))
    const p = connectSession(exit, offer)
    sessionPromises.set(exit.id, p)
    p.finally(() => { if (sessionPromises.get(exit.id) === p) sessionPromises.delete(exit.id) }).catch(() => {})
  }
  return sessionPromises.get(exit.id)
}

// round-robin over exits that currently have a fresh offer; fail over to the next on error
let rr = 0
async function openTunnelStream(target, app, firstData) {
  const candidates = exits.filter(fresh)
  if (!candidates.length) throw new Error('no offer yet')
  let lastErr = null
  for (let i = 0; i < candidates.length; i++) {
    const exit = candidates[(rr + i) % candidates.length]
    try {
      const s = await getSessionFor(exit)
      rr = (rr + i + 1) % Math.max(candidates.length, 1)
      return s.openStream(target, app, firstData)
    } catch (e) {
      lastErr = e
      exit.cooldownUntil = Date.now() + 30000 // stop hammering a dead exit for 30 s
      console.log(ts(), `[socks][${exit.name}] trying next exit: ${e.message}`)
    }
  }
  throw lastErr ?? new Error('all exits failed')
}

function routeFn({ host, port }, app, firstData) {
  const mode = decide(host)
  console.log(ts(), `[socks] ${host}:${port} -> ${mode}`)
  if (mode === 'direct') {
    const up = net.connect(port, host, () => { if (firstData?.length) up.write(firstData) })
    up.setTimeout(15000, () => { try { app.destroy() } catch {} })
    app.pipe(up); up.pipe(app)
    up.on('error', () => { try { app.destroy() } catch {} })
    app.on('error', () => {})
    app.on('close', () => up.destroy())
    return
  }

  // buffer app data until a tunnel stream is actually open
  const pending = [firstData].filter(d => d && d.length)
  const collect = (d) => { if (pending.length < 256) pending.push(d) }
  app.on('data', collect)

  const t0 = Date.now()
  const wait = setInterval(() => {
    if (exits.some(fresh) || Date.now() - t0 > 20000) {
      clearInterval(wait)
      app.removeListener('data', collect)
      openTunnelStream({ host, port }, app).then((stream) => {
        for (const d of pending) stream.write(d)
        pending.length = 0
      }).catch((e) => {
        console.log(ts(), `[socks] ${host}:${port} failed: ${e.message}`)
        try { app.destroy() } catch {}
      })
    }
  }, 250)
  app.on('error', () => {})
}

function udpFn(req, control, sendReply) {
  // UDP ASSOCIATE: register the relay on the (current) session; first datagram rides along
  const exit = exits.find(fresh)
  if (!exit) {
    console.log(ts(), '[socks][udp] no offer yet')
    try { control.destroy() } catch {}
    return
  }
  const addr = Buffer.alloc(7)
  addr[0] = 1 // IPv4
  req.host.split('.').forEach((o, i) => { addr[1 + i] = parseInt(o, 10) & 0xff })
  addr.writeUInt16BE(req.port, 5)
  getSessionFor(exit).then((s) => s.openRelay(
    Buffer.concat([addr, req.data]),
    control, sendReply,
  )).catch((e) => {
    console.log(ts(), `[socks][udp] association failed: ${e.message}`)
    try { control.destroy() } catch {}
  })
}

// bind to loopback only — a SOCKS5 server on 0.0.0.0 is an open no-auth proxy for the LAN
const SOCKS_HOST = process.env.MAGNETGATE_SOCKS_HOST ?? '127.0.0.1'
startSocks5Server(cfg.localPort, routeFn, udpFn)
  .listen(cfg.localPort, SOCKS_HOST, () => console.log(ts(), `[socks5] listening on ${SOCKS_HOST}:${cfg.localPort}`))

// optional periodic stats: MAGNETGATE_STATS=<seconds>
if (process.env.MAGNETGATE_STATS) {
  const every = parseInt(process.env.MAGNETGATE_STATS, 10) || 60
  setInterval(() => {
    for (const s of sessions.values()) {
      console.log(ts(), `[stats][${s.exit.name}] up=${(s.stats.up / 1024).toFixed(1)}KiB down=${(s.stats.down / 1024).toFixed(1)}KiB streams=${s.stats.streams} alive=${s.streams.size}`)
    }
  }, every * 1000)
}
