#!/usr/bin/env node
// node src/client.js <psk> [localPort=1080]   (env: DHT_BOOTSTRAP, MAGNETGATE_RULES)
import DHT from 'bittorrent-dht'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import {
  deriveKeys, saltOf, targetOf, unseal, connKeys, frame2, makeCodecV2, FRAME,
  bep44Verify, BOOTSTRAP,
} from './common.mjs'
import { startSocks5Server } from './socks5.mjs'

const SECRET = process.argv[2]
const LOCAL_PORT = parseInt(process.argv[3] ?? '1080')
const RULES_FILE = process.env.MAGNETGATE_RULES ?? null
const ts = () => new Date().toISOString()

if (!SECRET) { console.error('usage: node src/client.js <psk> [localPort]'); process.exit(1) }

let rules = { direct: [], proxy: [] }
if (RULES_FILE && fs.existsSync(RULES_FILE)) {
  try { rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')) } catch (e) { console.error('bad rules file:', e.message) }
}

function decide(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '')
  const match = (list) => list.some(e => h === String(e).toLowerCase() || h.endsWith('.' + String(e).toLowerCase()))
  if (rules.direct?.length && match(rules.direct)) return 'direct'
  if (rules.proxy?.length) return match(rules.proxy) ? 'proxy' : 'direct'
  return 'proxy' // no rules — everything through the tunnel
}

// ---------- offer discovery ----------
const { pk, boxKey } = deriveKeys(SECRET)
const SALT = saltOf(SECRET)
const TARGET = targetOf(pk, SALT)
const dht = new DHT({ bootstrap: BOOTSTRAP, verify: bep44Verify })

let lastOffer = null
let lookupTimer = null

dht.listen(() => console.log(ts(), `[dht] node on port ${dht.address().port}, bootstrap=${BOOTSTRAP.join(',')}`))
dht.on('ready', () => {
  lookupTimer = setInterval(lookup, 3000)
  setTimeout(lookup, 1500)
})

function lookup() {
  dht.get(TARGET, { salt: SALT }, (err, res) => {
    if (err || !res?.v) return
    const plain = unseal(boxKey, res.v, res.seq)
    if (!plain) return
    try {
      const o = JSON.parse(plain.toString())
      if (o.v === 2 && Date.now() - o.ts < 720000) {
        if (!lastOffer || lastOffer.ts !== o.ts) console.log(ts(), `[dht] offer: ${o.host}:${o.port}`)
        lastOffer = o
        if (lookupTimer) { clearInterval(lookupTimer); lookupTimer = setInterval(lookup, 10000) }
      }
    } catch {}
  })
}

function currentOffer() {
  if (lastOffer && Date.now() - lastOffer.ts < 720000) return lastOffer
  return null
}

// ---------- multiplexed session ----------
// One persistent connection to the exit carries all SOCKS streams (frames carry streamId),
// with PING/PONG keep-alive. On session loss the next stream request re-establishes it.

let session = null
let sessionPromise = null

class Session {
  constructor(sock, keys) {
    this.sock = sock
    this.keys = keys
    this.streams = new Map() // streamId -> app socket
    this.nextId = 1
    this.lastPong = Date.now()
    sock.on('data', (c) => this.codec.push(c))
    sock.on('error', (e) => console.log(ts(), `[data] session error: ${e.message}`))
    sock.on('close', () => this.teardown())
    this.ping = setInterval(() => {
      if (session !== this) return clearInterval(this.ping)
      try { sock.write(frame2(keys.c2e, FRAME.PING, 0, Buffer.from('p'))) } catch {}
      if (Date.now() - this.lastPong > 30000) {
        console.log(ts(), '[data] session dead (no pong)')
        this.teardown()
      }
    }, 20000)
    this.codec = makeCodecV2(keys.e2c, (type, id, plain) => {
      this.lastPong = Date.now()
      if (type === FRAME.DATA) {
        const app = this.streams.get(id)
        if (app && !app.destroyed) app.write(plain)
      } else if (type === FRAME.CLOSE) {
        const app = this.streams.get(id)
        if (app) { this.streams.delete(id); try { app.destroy() } catch {} }
      } else if (type === FRAME.PONG) {
        // handled above
      }
    }, () => this.teardown())
  }

  teardown() {
    if (session === this) session = null
    clearInterval(this.ping)
    for (const app of this.streams.values()) { try { app.destroy() } catch {} }
    this.streams.clear()
    try { this.sock.destroy() } catch {}
  }

  openStream(target, app, firstData) {
    const id = this.nextId++ & 0x7fffffff || 1
    this.streams.set(id, app)
    try {
      this.sock.write(frame2(this.keys.c2e, FRAME.OPEN, id, Buffer.from(JSON.stringify(target))))
      if (firstData?.length) this.sock.write(frame2(this.keys.c2e, FRAME.DATA, id, firstData))
      app.on('data', (d) => { try { this.sock.write(frame2(this.keys.c2e, FRAME.DATA, id, d)) } catch {} })
      app.on('close', () => { try { this.sock.write(frame2(this.keys.c2e, FRAME.CLOSE, id, Buffer.alloc(0))) } catch {} })
    } catch (e) {
      console.log(ts(), `[data] stream #${id} open failed: ${e.message}`)
      app.destroy()
    }
    return { id, write: (d) => { try { this.sock.write(frame2(this.keys.c2e, FRAME.DATA, id, d)) } catch {} } }
  }
}

function getSession() {
  if (session) return Promise.resolve(session)
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const offer = currentOffer()
      if (!offer) throw new Error('no offer yet')
      const sock = await new Promise((resolve, reject) => {
        const s = net.connect(offer.port, offer.host)
        const t = setTimeout(() => { s.destroy(); reject(new Error('connect timeout')) }, 15000)
        s.on('connect', () => { clearTimeout(t); resolve(s) })
        s.on('error', (e) => { clearTimeout(t); reject(e) })
      })
      sock.setKeepAlive(true, 15000)
      const connSalt = crypto.randomBytes(8)
      sock.write(connSalt)
      const keys = connKeys(boxKey, connSalt)
      session = new Session(sock, keys)
      console.log(ts(), `[data] session to ${offer.host}:${offer.port} established`)
      return session
    })()
    sessionPromise.finally(() => { sessionPromise = null })
  }
  return sessionPromise
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

  // buffer app data until the tunnel stream is actually open
  const pending = [firstData].filter(d => d && d.length)
  const collect = (d) => { if (pending.length < 256) pending.push(d) }
  app.on('data', collect)

  const t0 = Date.now()
  const wait = setInterval(() => {
    if (currentOffer() || Date.now() - t0 > 20000) {
      clearInterval(wait)
      app.removeListener('data', collect)
      getSession().then((s) => {
        const stream = s.openStream({ host, port }, app)
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

startSocks5Server(LOCAL_PORT, routeFn)
  .listen(LOCAL_PORT, () => console.log(ts(), `[socks5] listening on 127.0.0.1:${LOCAL_PORT}`))
