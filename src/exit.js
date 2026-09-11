#!/usr/bin/env node
// node exit.js <psk> [dataPort] [publicHost]
import DHT from 'bittorrent-dht'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import { deriveKeys, saltOf, signer, seal, connKeys, frame, makeCodec, bep44Verify, BOOTSTRAP } from './common.mjs'

const SECRET = process.argv[2]
const DATA_PORT = parseInt(process.argv[3] ?? '49001')
const PUBLIC_HOST = process.argv[4] ?? null
const SEQ_FILE = process.env.MAGNETGATE_SEQ_FILE ?? null
const ts = () => new Date().toISOString()

if (!SECRET) { console.error('usage: node exit.js <psk> [dataPort] [publicHost]'); process.exit(1) }

const { pk, sk, boxKey } = deriveKeys(SECRET)
const SALT = saltOf(SECRET)

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
  const offer = { v: 1, host: PUBLIC_HOST ?? autoIp(), port: DATA_PORT, ts: Date.now() }
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

// ---------- data plane ----------
net.createServer((sock) => {
  sock.setKeepAlive(true, 15000)
  console.log(ts(), `[data] incoming ${sock.remoteAddress}:${sock.remotePort}`)
  let gotSalt = Buffer.alloc(0)
  let started = false
  let upstream = null

  sock.on('data', function onData(chunk) {
    if (started) return
    gotSalt = Buffer.concat([gotSalt, chunk])
    if (gotSalt.length < 8) return
    started = true
    const rest = gotSalt.subarray(8)
    const keys = connKeys(boxKey, gotSalt.subarray(0, 8))
    const codec = makeCodec(keys.c2e, (plain) => {
      if (!upstream) {
        const cmd = JSON.parse(plain.toString())
        console.log(ts(), `[data] CONNECT ${cmd.host}:${cmd.port}`)
        upstream = net.connect(cmd.port, cmd.host)
        upstream.setKeepAlive(true, 15000)
        upstream.setTimeout(20000, () => { console.log(ts(), '[data] upstream timeout'); sock.destroy() })
        upstream.on('data', (d) => { try { sock.write(frame(keys.e2c, d)) } catch {} })
        upstream.on('error', (e) => { console.log(ts(), `[data] upstream error: ${e.message}`); sock.destroy() })
      } else {
        upstream.write(plain)
      }
    }, () => { try { sock.destroy() } catch {} })
    sock.removeListener('data', onData)
    sock.on('data', (c) => codec.push(c))
    sock.on('error', () => {})
    if (rest.length) codec.push(rest)
  })
  sock.on('error', () => {})
}).listen(DATA_PORT, () => console.log(ts(), `[data] listening on ${DATA_PORT}`))
