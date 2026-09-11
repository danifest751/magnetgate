#!/usr/bin/env node
// node src/exit.js <psk> [dataPort] [publicHost]
import DHT from 'bittorrent-dht'
import net from 'node:net'
import dgram from 'node:dgram'
import os from 'node:os'
import fs from 'node:fs'
import {
  deriveKeys, saltOf, signer, seal, connKeys, frame2, makeCodecV2, FRAME,
  bep44Verify, BOOTSTRAP,
} from './common.mjs'

const SECRET = process.argv[2]
const DATA_PORT = parseInt(process.argv[3] ?? '49001')
const PUBLIC_HOST = process.argv[4] ?? null
const SEQ_FILE = process.env.MAGNETGATE_SEQ_FILE ?? null
const ts = () => new Date().toISOString()

if (!SECRET) { console.error('usage: node src/exit.js <psk> [dataPort] [publicHost]'); process.exit(1) }

const { pk, sk, boxKey } = deriveKeys(SECRET)
const SALT = saltOf(SECRET)

// ---------- signaling (DHT offer publication) ----------
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

function publish() {
  seq += 1
  const offer = { v: 2, host: PUBLIC_HOST ?? autoIp(), port: DATA_PORT, ts: Date.now(), udp: process.env.MAGNETGATE_TRANSPORT !== 'tcp' ? 1 : undefined }
  dht.put({
    k: pk,
    salt: SALT,
    seq,
    sign: signer(sk),
    v: seal(boxKey, Buffer.from(JSON.stringify(offer)), seq),
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
// One TCP connection = one session. Frames carry streamId; each OPEN stream maps
// to one upstream TCP connection. streamId 0 is session-level (PING/PONG).

const IDLE_SESSION_MS = 10 * 60 * 1000

function handleSession(sock) {
if (sock.setKeepAlive) sock.setKeepAlive(true, 15000)
console.log(ts(), `[data] session from ${sock.remoteAddress ?? 'udp'}:${sock.remotePort ?? ''}`)
  let gotSalt = Buffer.alloc(0)
  let started = false
  const streams = new Map() // streamId -> upstream socket
  let lastActivity = Date.now()

  const killSession = () => {
    for (const up of streams.values()) { try { up.destroy() } catch {} }
    streams.clear()
    try { sock.destroy() } catch {}
  }

    if (process.env.MAGNETGATE_DEBUG) console.log(ts(), `[dbg-exit] udp session waiting for salt`)
    sock.on('data', function onData(chunk) {
      if (process.env.MAGNETGATE_DEBUG && !started) console.log(ts(), `[dbg-exit] chunk ${chunk.length}b (got ${gotSalt.length})`)
    if (started) return
    gotSalt = Buffer.concat([gotSalt, chunk])
    if (gotSalt.length < 8) return
    started = true
    const rest = gotSalt.subarray(8)
    const keys = connKeys(boxKey, gotSalt.subarray(0, 8))
    const streams = new Map() // streamId -> upstream TCP socket
    const relays = new Map()  // streamId -> udp socket (UDP ASSOCIATE)
    let lastActivity = Date.now()

    const killSession = () => {
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

    const codec = makeCodecV2(keys.c2e, (type, id, plain) => {
      lastActivity = Date.now()
      if (type === FRAME.OPEN) {
        if (streams.has(id)) return sock.destroy()
        const cmd = JSON.parse(plain.toString())
        console.log(ts(), `[data] stream #${id} CONNECT ${cmd.host}:${cmd.port}`)
        const up = net.connect(cmd.port, cmd.host)
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
        if (relays.has(id)) return sock.destroy()
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
        if (first && first.data.length) {
          try { udp.send(first.data, first.port, first.host) } catch {}
        }
      } else if (type === FRAME.UDP_DATA) {
        const udp = relays.get(id)
        if (udp) {
          const dst = parseAddr(plain)
          if (dst) { try { udp.send(dst.data, dst.port, dst.host) } catch {} }
        }
      } else if (type === FRAME.UDP_CLOSE) {
        const r = relays.get(id)
        if (r) { relays.delete(id); try { r.close() } catch {} }
      } else if (type === FRAME.PING) {
        try { sock.write(frame2(keys.e2c, FRAME.PONG, 0, plain)) } catch {}
      }
    }, () => { killSession() })
    sock.removeListener('data', onData)
    sock.on('data', (c) => codec.push(c))
    sock.on('error', () => {})
    if (rest.length) codec.push(rest)

    const idle = setInterval(() => {
      if (Date.now() - lastActivity > IDLE_SESSION_MS) {
        console.log(ts(), `[data] session idle, closing`)
        killSession()
        clearInterval(idle)
      }
    }, 60 * 1000)
    sock.on('close', () => clearInterval(idle))
  })
  sock.on('error', () => {})
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
