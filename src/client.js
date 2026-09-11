#!/usr/bin/env node
// node client.js <psk> [localPort=1080]   (env: DHT_BOOTSTRAP, MAGNETGATE_RULES=path/to/rules.json)
import DHT from 'bittorrent-dht'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { deriveKeys, saltOf, targetOf, unseal, connKeys, frame, makeCodec, bep44Verify, BOOTSTRAP } from './common.mjs'
import { startSocks5Server } from './socks5.mjs'

const SECRET = process.argv[2]
const LOCAL_PORT = parseInt(process.argv[3] ?? '1080')
const RULES_FILE = process.env.MAGNETGATE_RULES ?? null
const ts = () => new Date().toISOString()

if (!SECRET) { console.error('usage: node client.js <psk> [localPort]'); process.exit(1) }

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
      if (o.v === 1 && Date.now() - o.ts < 720000) {
        if (!lastOffer || lastOffer.ts !== o.ts) console.log(ts(), `[dht] offer: ${o.host}:${o.port}`)
        lastOffer = o
        if (lookupTimer) { clearInterval(lookupTimer); lookupTimer = setInterval(lookup, 10000) }
      }
    } catch {}
  })
}

// ---------- routes ----------
function routeFn({ host, port }, app, firstData) {
  const mode = decide(host)
  console.log(ts(), `[socks] ${host}:${port} -> ${mode}`)
  if (mode === 'proxy') {
    if (!lastOffer) { console.log(ts(), '[socks] no offer yet, closing'); return app.destroy() }
    dialExit(lastOffer, app, { host, port }, firstData)
  } else {
    const up = net.connect(port, host, () => { if (firstData?.length) up.write(firstData) })
    up.setTimeout(15000, () => { try { app.destroy() } catch {} })
    app.pipe(up); up.pipe(app)
    up.on('error', () => { try { app.destroy() } catch {} })
    app.on('error', () => {})
    app.on('close', () => up.destroy())
  }
}

function dialExit(offer, app, target, firstData) {
  let c2e = null
  const pending = [firstData].filter(d => d && d.length)
  const sock = net.connect(offer.port, offer.host, () => {
    sock.setKeepAlive(true, 15000)
    const connSalt = crypto.randomBytes(8)
    sock.write(connSalt)
    const keys = connKeys(boxKey, connSalt)
    c2e = keys.c2e
    const codec = makeCodec(keys.e2c,
      (plain) => { if (!app.destroyed) app.write(plain) },
      () => { sock.destroy(); app.destroy() })
    sock.on('data', (c) => codec.push(c))
    sock.write(frame(c2e, Buffer.from(JSON.stringify(target))))
    for (const d of pending) sock.write(frame(c2e, d))
    pending.length = 0
  })
  app.on('data', (d) => {
    if (c2e) sock.write(frame(c2e, d))
    else pending.push(d)
  })
  sock.on('error', (e) => console.log(ts(), `[data] tunnel error: ${e.message}`))
  sock.on('close', () => { if (!app.destroyed) app.destroy() })
  app.on('close', () => sock.destroy())
}

startSocks5Server(LOCAL_PORT, routeFn)
  .listen(LOCAL_PORT, () => console.log(ts(), `[socks5] listening on 127.0.0.1:${LOCAL_PORT}`))
