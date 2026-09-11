#!/usr/bin/env node
// node src/exit.js [psk] [dataPort] [publicHost]
// Secrets/config are read from the environment first (so the PSK never lands on the process
// command line / ps output), falling back to argv for ad-hoc local runs:
//   MAGNETGATE_PSK, MAGNETGATE_PORT, MAGNETGATE_PUBLIC_HOST
import DHT from 'bittorrent-dht'
import net from 'node:net'
import dgram from 'node:dgram'
import os from 'node:os'
import fs from 'node:fs'
import dns from 'node:dns'
import {
  deriveKeys, saltOf, signer, seal, frame2, makeCodecV2, FRAME,
  bep44Verify, BOOTSTRAP, hsExitRespond, HS_TS_SKEW_MS, pskWarning,
} from './common.mjs'

const SECRET = process.env.MAGNETGATE_PSK ?? process.env.PSK ?? process.argv[2]
const DATA_PORT = parseInt(process.env.MAGNETGATE_PORT ?? process.argv[3] ?? '49001')
const PUBLIC_HOST = process.env.MAGNETGATE_PUBLIC_HOST ?? process.argv[4] ?? null
const SEQ_FILE = process.env.MAGNETGATE_SEQ_FILE ?? null
const ts = () => new Date().toISOString()

if (!SECRET) { console.error('usage: MAGNETGATE_PSK=<psk> node src/exit.js [dataPort] [publicHost]'); process.exit(1) }
{ const w = pskWarning(SECRET); if (w) console.log(ts(), `[warn] ${w}`) }

// ---------- resource limits (DoS guardrails) ----------
const MAX_SESSIONS = parseInt(process.env.MAGNETGATE_MAX_SESSIONS ?? '512')
const MAX_STREAMS = parseInt(process.env.MAGNETGATE_MAX_STREAMS ?? '256') // per session (TCP + UDP)
const IDLE_SESSION_MS = 10 * 60 * 1000
let sessionCount = 0
const seenHs = new Map() // handshake anti-replay: client ephemeral pubkey (hex) -> expiry ms

// ---------- egress filter (SSRF guard) ----------
// A client with the PSK could otherwise make the exit connect to loopback, link-local
// (incl. 169.254.169.254 cloud metadata) or RFC1918 hosts. Blocked by default.
const ALLOW_PRIVATE = process.env.MAGNETGATE_ALLOW_PRIVATE === '1'
function isBlockedIp(ip) {
  if (typeof ip !== 'string' || !ip) return true
  let s = ip
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7) // IPv4-mapped IPv6
  if (net.isIPv4(s)) {
    const [a, b] = s.split('.').map(Number)
    if (a === 0 || a === 127 || a === 10) return true            // this-host, loopback, RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true             // RFC1918
    if (a === 192 && b === 168) return true                      // RFC1918
    if (a === 169 && b === 254) return true                      // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true            // CGNAT
    if (a === 192 && b === 0) return true                        // 192.0.0.0/24 special
    if (a === 198 && (b === 18 || b === 19)) return true         // benchmarking
    if (a >= 224) return true                                    // multicast + reserved
    return false
  }
  const l = s.toLowerCase()
  if (l === '::' || l === '::1') return true                     // unspecified, loopback
  if (l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb')) return true // fe80::/10
  if (l.startsWith('fc') || l.startsWith('fd')) return true      // fc00::/7 ULA
  return false
}
// custom lookup for net.connect: resolve, then reject internal targets (covers hostnames too).
// net.connect uses Happy Eyeballs (autoSelectFamily) and calls this with { all: true }, in which
// case dns.lookup yields an array of { address, family } — handle both shapes.
function guardedLookup(hostname, options, cb) {
  const all = !!(options && options.all)
  if (net.isIP(hostname)) {
    const fam = net.isIPv6(hostname) ? 6 : 4
    if (!ALLOW_PRIVATE && isBlockedIp(hostname)) return cb(new Error(`blocked target ${hostname}`))
    return all ? cb(null, [{ address: hostname, family: fam }]) : cb(null, hostname, fam)
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err)
    if (all) {
      const list = Array.isArray(address) ? address : [{ address, family }]
      const allowed = ALLOW_PRIVATE ? list : list.filter(a => !isBlockedIp(a.address))
      if (!allowed.length) return cb(new Error(`blocked target ${hostname} (all addresses internal)`))
      return cb(null, allowed)
    }
    if (!ALLOW_PRIVATE && isBlockedIp(address)) return cb(new Error(`blocked target ${hostname} -> ${address}`))
    cb(null, address, family)
  })
}

const { pk, sk, boxKey } = deriveKeys(SECRET)
const SALT = saltOf(SECRET)

// ---------- signaling (rendezvous: DHT + optional Nostr, same sealed offer) ----------
let nostr = null
if (process.env.MAGNETGATE_NOSTR !== 'off') {
  try {
    const { nostrPublisher } = await import('./nostr.mjs')
    nostr = nostrPublisher(SECRET)
    console.log(ts(), `[nostr] publishing offers to ${nostr.relays} relay(s)`)
  } catch (e) { console.log(ts(), `[nostr] disabled: ${e.message}`) }
}

const dht = new DHT({ bootstrap: BOOTSTRAP, verify: bep44Verify })
let seq = Math.floor(Date.now() / 1000)
if (SEQ_FILE && fs.existsSync(SEQ_FILE)) {
  try { seq = Math.max(seq, parseInt(fs.readFileSync(SEQ_FILE, 'utf8').trim(), 10) || 0) } catch {}
}

function autoIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list ?? [])
      if (!i.internal && i.family === 'IPv4') return i.address
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
  } catch { return [] }
}

function publish() {
  seq += 1
  const udp = process.env.MAGNETGATE_TRANSPORT !== 'tcp' ? 1 : undefined
  // offer v3: an extensible list of data-plane endpoints. Reality/hysteria2 (from the dp file)
  // are preferred; the native channel ("mgt") is the fallback. Sealed once, shared by both
  // rendezvous channels (same seq => same nonce => identical ciphertext, no nonce reuse).
  const dp = [...readExtraDp(), { t: 'mgt', host: PUBLIC_HOST ?? autoIp(), port: DATA_PORT, udp }]
  const offer = { v: 3, ts: Date.now(), dp }
  const sealed = seal(boxKey, Buffer.from(JSON.stringify(offer)), seq)
  if (sealed.length > 950) console.log(ts(), `[warn] offer ${sealed.length}B may exceed the DHT ~1000B limit`)
  if (nostr) nostr.publish(sealed, seq)
  if (nostr) nostr.publish(sealed, seq)
  dht.put({
    k: pk,
    salt: SALT,
    seq,
    sign: signer(sk),
    v: sealed,
  }, (err, _h, n) => {
    if (SEQ_FILE) { try { fs.writeFileSync(SEQ_FILE, String(seq)) } catch {} }
    console.log(ts(), err ? `[dht] put failed: ${err.message}` : `[dht] published (n=${n})`)
    if (err) setTimeout(publish, 5000)
  })
}

dht.listen(() => console.log(ts(), `[dht] node on port ${dht.address().port}, bootstrap=${BOOTSTRAP.join(',')}`))
dht.on('ready', () => {
  setTimeout(publish, 2000)
  setInterval(publish, 5 * 60 * 1000)
})

// ---------- data plane: multiplexed sessions ----------
// One transport connection (TCP socket or reliable-UDP stream) = one session. The client
// sends an 8-byte connSalt first; both sides derive the per-connection keys from it.
// Frames carry a streamId; each OPEN maps to one upstream TCP connection. streamId 0 is
// session-level (PING/PONG).
function handleSession(sock) {
  if (sessionCount >= MAX_SESSIONS) { try { sock.destroy() } catch {}; return }
  sessionCount++
  if (sock.setKeepAlive) sock.setKeepAlive(true, 15000)
  console.log(ts(), `[data] session from ${sock.remoteAddress ?? 'udp'}:${sock.remotePort ?? ''} (active=${sessionCount})`)

  let hsBuf = Buffer.alloc(0)
  let started = false
  let closed = false
  const streams = new Map() // streamId -> upstream TCP socket
  const relays = new Map()  // streamId -> udp socket (UDP ASSOCIATE)
  let lastActivity = Date.now()
  let idle = null

  const killSession = () => {
    if (closed) return
    closed = true
    sessionCount = Math.max(0, sessionCount - 1)
    if (idle) clearInterval(idle)
    for (const up of streams.values()) { try { up.destroy() } catch {} }
    streams.clear()
    for (const u of relays.values()) { try { u.close() } catch {} }
    relays.clear()
    try { sock.destroy() } catch {}
  }

  // parse a tunnel UDP payload starting at ATYP: [atyp][addr][port][data]
  const parseAddr = (payload) => {
    const at = payload[0]
    if (at === 1 && payload.length >= 7) {
      const addr = [...payload.subarray(1, 5)].join('.')
      return { host: addr, port: payload.readUInt16BE(5), data: payload.subarray(7) }
    }
    if (at === 3 && payload.length >= 4) {
      const dl = payload[1]
      if (payload.length < 4 + dl) return null
      const host = payload.toString('latin1', 2, 2 + dl)
      return { host, port: payload.readUInt16BE(2 + dl), data: payload.subarray(4 + dl) }
    }
    if (at === 4 && payload.length >= 19) {
      const host = [...payload.subarray(1, 17)].map(b => b.toString(16)).join(':')
      return { host, port: payload.readUInt16BE(17), data: payload.subarray(19) }
    }
    return null
  }

  const onData = (chunk) => {
    if (started) return
    hsBuf = Buffer.concat([hsBuf, chunk])
    if (hsBuf.length < 2) return
    const len = hsBuf.readUInt16BE(0)
    if (len > 4096) return killSession()
    if (hsBuf.length < 2 + len) return
    started = true
    const msg1 = hsBuf.subarray(2, 2 + len)
    const rest = hsBuf.subarray(2 + len)

    // forward-secret handshake: authenticate (PSK), derive ephemeral session keys, reply
    const r = hsExitRespond(boxKey, msg1)
    if (!r) { console.log(ts(), '[data] handshake rejected'); return killSession() }
    const cek = r.cePk.toString('hex')
    const nowMs = Date.now()
    for (const [k, exp] of seenHs) if (exp < nowMs) seenHs.delete(k)
    if (seenHs.has(cek)) { console.log(ts(), '[data] handshake replay rejected'); return killSession() }
    seenHs.set(cek, nowMs + HS_TS_SKEW_MS)
    const keys = r.keys
    const hdr = Buffer.alloc(2); hdr.writeUInt16BE(r.msg2.length, 0)
    try { sock.write(Buffer.concat([hdr, r.msg2])) } catch { return killSession() }

    const codec = makeCodecV2(keys.c2e, (type, id, plain) => {
      lastActivity = Date.now()
      if (type === FRAME.OPEN) {
        if (streams.has(id)) return killSession()
        if (streams.size + relays.size >= MAX_STREAMS) return
        let cmd
        try { cmd = JSON.parse(plain.toString()) } catch { return } // malformed OPEN: ignore, don't crash
        if (!cmd || typeof cmd.host !== 'string' || !Number.isInteger(cmd.port)) return
        // literal IP targets bypass net.connect's custom lookup, so screen them here too
        if (!ALLOW_PRIVATE && net.isIP(cmd.host) && isBlockedIp(cmd.host)) {
          console.log(ts(), `[data] stream #${id} blocked ${cmd.host}:${cmd.port}`)
          try { sock.write(frame2(keys.e2c, FRAME.CLOSE, id, Buffer.alloc(0))) } catch {}
          return
        }
        console.log(ts(), `[data] stream #${id} CONNECT ${cmd.host}:${cmd.port}`)
        const up = net.connect({ port: cmd.port, host: cmd.host, lookup: guardedLookup })
        up.setKeepAlive(true, 15000)
        streams.set(id, up)
        up.on('data', (d) => { try { sock.write(frame2(keys.e2c, FRAME.DATA, id, d)) } catch {} })
        up.on('error', (e) => { console.log(ts(), `[data] stream #${id} upstream error: ${e.message}`); up.destroy() })
        up.on('close', () => {
          streams.delete(id)
          try { sock.write(frame2(keys.e2c, FRAME.CLOSE, id, Buffer.alloc(0))) } catch {}
        })
      } else if (type === FRAME.DATA) {
        const up = streams.get(id)
        if (up) up.write(plain)
      } else if (type === FRAME.CLOSE) {
        const up = streams.get(id)
        if (up) { streams.delete(id); try { up.destroy() } catch {} }
        const r = relays.get(id)
        if (r) { relays.delete(id); try { r.close() } catch {} }
      } else if (type === FRAME.UDP_ASSOC) {
        if (relays.has(id)) return killSession()
        if (streams.size + relays.size >= MAX_STREAMS) return
        const udp = dgram.createSocket('udp4')
        relays.set(id, udp)
        udp.on('error', () => {})
        udp.on('message', (msg, rinfo) => {
          // reply payload: [atyp=1][addr][port][data]
          const payload = Buffer.alloc(7)
          payload[0] = 1
          const ip = rinfo.address.split('.').map(x => parseInt(x, 10) & 0xff)
          Buffer.from(ip).copy(payload, 1)
          payload.writeUInt16BE(rinfo.port, 5)
          try { sock.write(frame2(keys.e2c, FRAME.UDP_DATA, id, Buffer.concat([payload, msg]))) } catch {}
        })
        const first = parseAddr(plain)
        if (first && first.data.length && (ALLOW_PRIVATE || !isBlockedIp(first.host))) {
          try { udp.send(first.data, first.port, first.host) } catch {}
        }
      } else if (type === FRAME.UDP_DATA) {
        const udp = relays.get(id)
        if (udp) {
          const dst = parseAddr(plain)
          if (dst && (ALLOW_PRIVATE || !isBlockedIp(dst.host))) { try { udp.send(dst.data, dst.port, dst.host) } catch {} }
        }
      } else if (type === FRAME.UDP_CLOSE) {
        const r = relays.get(id)
        if (r) { relays.delete(id); try { r.close() } catch {} }
      } else if (type === FRAME.PING) {
        try { sock.write(frame2(keys.e2c, FRAME.PONG, 0, plain)) } catch {}
      }
    }, () => killSession())

    sock.on('data', (c) => codec.push(c))
    sock.on('error', () => {})
    if (rest.length) codec.push(rest)

    idle = setInterval(() => {
      if (Date.now() - lastActivity > IDLE_SESSION_MS) {
        console.log(ts(), `[data] session idle, closing`)
        killSession()
      }
    }, 60 * 1000)
  }

  sock.on('data', onData)
  sock.on('error', () => {})
  sock.on('close', () => killSession())
}

net.createServer(handleSession).listen(DATA_PORT, () => console.log(ts(), `[data] listening on ${DATA_PORT}`))

// optional UDP transport (same port, datagram carriage): MAGNETGATE_TRANSPORT=udp
if (process.env.MAGNETGATE_TRANSPORT !== 'tcp') {
  const { ExitUdpMux } = await import('./udpsess.mjs')
  new ExitUdpMux({ port: DATA_PORT, boxKey, onConn: (conn, rinfo) => {
    console.log(ts(), `[data] udp stream from ${rinfo.address}:${rinfo.port}`)
    handleSession(conn)
  } })
  console.log(ts(), `[data] udp transport enabled on ${DATA_PORT}/udp`)
}
