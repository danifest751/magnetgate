// Minimal reliable ordered stream over UDP (pure-JS ARQ, experimental).
// Datagram: [0x4D][conv u32][cmd u8][seq u32][payload]
//   HELLO(1): empty payload (client → exit, retransmitted until acked); the session keys are
//              negotiated at the application layer on top of this stream, not from a transport salt
//   HELLO_ACK(2): payload empty
//   PSH(3): payload = a fragment of the ordered byte stream
//   ACK(4): payload = u32 nextExpectedSeq (cumulative)
// Delivery: ordered, reliable, fixed window, per-packet RTO with backoff.
// Mux frames are already AEAD-encrypted by frame2(); this layer only adds transport
// reliability, so PSH fragments are carried as-is.
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'

const MAGIC = 0x4d
export const UDP_CMD = { HELLO: 1, HELLO_ACK: 2, PSH: 3, ACK: 4 }
const MTU = 1100
const WINDOW = 64
const TICK_MS = 25
const RTO_BASE = 400
const now = () => Date.now()

function encode(conv, cmd, seq, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(10)
  head[0] = MAGIC
  head.writeUInt32BE(conv, 1)
  head[5] = cmd
  head.writeUInt32BE(seq, 6)
  return Buffer.concat([head, payload])
}

function decode(msg) {
  if (msg.length < 10 || msg[0] !== MAGIC) return null
  return {
    conv: msg.readUInt32BE(1),
    cmd: msg[5],
    seq: msg.readUInt32BE(6),
    payload: msg.subarray(10)
  }
}

function sendDatagram(udp, buf, remote) {
  try {
    udp.send(buf, remote.port, remote.host ?? remote.address, () => {})
  } catch (e) {
    if (process.env.MAGNETGATE_DEBUG) console.log('[dbg-net] udp send failed:', e.message)
  }
}

// One reliable ordered stream. The same socket can carry many streams (exit side):
// onDatagram(msg, rinfo) is the single dispatch point — the outer mux routes datagrams here.
export class ReliableStream extends EventEmitter {
  constructor(udp, remote, conv) {
    super()
    this.udp = udp
    this.remote = remote
    this.conv = conv
    this.closed = false
    this.ready = false
    this.nextSend = 1
    this.nextRecv = 1
    this.rto = RTO_BASE
    this.unacked = new Map() // seq -> { packet, sentAt }
    this.recvBuf = new Map() // seq -> payload (out of order)
    this.queue = [] // fragments waiting for a window slot
    this.keys = null
    this.helloWait = null
    this.helloSentAt = 0
    this.lastActive = now()
    this.tick = setInterval(() => this.onTick(), TICK_MS)
    // NOTE: the datagram dispatch is attached by the owner (client handshake or ExitUdpMux)
  }

  // client role: HELLO_ACK completes the handshake
  onClientHelloAck() {
    if (this.helloWait && !this.ready) {
      this.helloWait = null
      this.ready = true
      this.onAck(1)
      this.emit('ready')
    }
  }

  // client side only: begin the HELLO handshake (transport bring-up only; the
  // forward-secret key exchange runs at the application layer over this stream)
  startHello() {
    this.helloWait = Buffer.alloc(0)
    this.helloSentAt = now()
    this.onTick()
  }

  onDatagram(msg, rinfo) {
    if (this.closed) return
    if (rinfo.address !== this.remote.host || rinfo.port !== this.remote.port) return
    const p = decode(msg)
    if (!p || p.conv !== this.conv) return
    this.lastActive = now() // any valid datagram from the peer counts as liveness
    if (p.cmd === UDP_CMD.HELLO_ACK) {
      if (p.payload.length !== 0) return this.destroy()
      if (process.env.MAGNETGATE_DEBUG)
        console.log(
          `[dbg-net] HELLO_ACK received from ${rinfo.address}:${rinfo.port} (ready=${this.ready})`
        )
      if (this.helloWait && !this.ready) {
        this.helloWait = null
        this.ready = true
        this.onAck(1)
        this.emit('ready')
      }
    } else if (p.cmd === UDP_CMD.ACK) {
      if (p.payload.length !== 4) return this.destroy()
      this.onAck(p.payload.readUInt32BE(0))
    } else if (p.cmd === UDP_CMD.PSH) {
      if (!p.seq || !p.payload.length || p.payload.length > MTU || p.seq >= this.nextRecv + WINDOW)
        return this.destroy()
      if (p.seq < this.nextRecv || this.recvBuf.has(p.seq)) {
        this.sendAck()
        return
      }
      if (p.seq === this.nextRecv) {
        this.emit('data', p.payload)
        this.nextRecv++
        while (!this.closed && this.recvBuf.has(this.nextRecv)) {
          this.emit('data', this.recvBuf.get(this.nextRecv))
          this.recvBuf.delete(this.nextRecv)
          this.nextRecv++
        }
      } else {
        this.recvBuf.set(p.seq, p.payload)
      }
      this.sendAck()
    }
  }

  sendAck() {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(this.nextRecv, 0)
    sendDatagram(this.udp, encode(this.conv, UDP_CMD.ACK, 0, b), this.remote)
  }

  onAck(next) {
    if (!next || next > this.nextSend) return this.destroy()
    for (const [seq] of this.unacked) {
      if (seq < next) {
        this.unacked.delete(seq)
        this.rto = RTO_BASE
      }
    }
  }

  onTick() {
    if (this.closed) return
    if (this.nextSend >= 0xffffffff || this.nextRecv >= 0xffffffff) return this.destroy()
    while (this.unacked.size < WINDOW && this.queue.length > 0) {
      if (this.nextSend >= 0xffffffff) return this.destroy()
      const seq = this.nextSend++
      const packet = encode(this.conv, UDP_CMD.PSH, seq, this.queue.shift())
      this.unacked.set(seq, { packet, sentAt: now() })
      sendDatagram(this.udp, packet, this.remote)
      if (process.env.MAGNETGATE_DEBUG)
        console.log(`[dbg-net] PSH sent seq=${seq} (${this.remote.host}:${this.remote.port})`)
    }
    for (const [seq, u] of this.unacked) {
      if (now() - u.sentAt >= this.rto) {
        u.retries = (u.retries || 0) + 1
        if (u.retries > 30) return this.destroy()
        u.sentAt = now()
        sendDatagram(this.udp, u.packet, this.remote)
        if (process.env.MAGNETGATE_DEBUG) console.log(`[dbg-net] PSH retransmit seq=${seq}`)
      }
    }
    if (this.helloWait && now() - this.helloSentAt >= 300) {
      this.helloSentAt = now()
      sendDatagram(this.udp, encode(this.conv, UDP_CMD.HELLO, 0, this.helloWait), this.remote)
      if (process.env.MAGNETGATE_DEBUG)
        console.log(`[dbg-net] HELLO sent to ${this.remote.host}:${this.remote.port}`)
    }
  }

  write(data) {
    if (this.closed) return false
    this.lastActive = now()
    if (this.queue.length + Math.ceil(data.length / MTU) > 4096) {
      this.destroy()
      return false
    }
    for (let off = 0; off < data.length; off += MTU) {
      this.queue.push(data.subarray(off, Math.min(off + MTU, data.length)))
    }
    return true
  }

  destroy() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.tick)
    this.queue.length = 0
    this.recvBuf.clear()
    this.unacked.clear()
    this.emit('close')
  }
}

// Client side: HELLO handshake against a known exit UDP endpoint.
export async function createClientUdpStream({ remote }) {
  const resolved = await dns.lookup(remote.host, { family: 4 })
  remote = { host: resolved.address, port: remote.port }
  return new Promise((resolve, reject) => {
    const udp = dgram.createSocket('udp4')
    const conv = crypto.randomBytes(4).readUInt32BE(0)
    const rremote = { host: remote.host, port: remote.port }
    const stream = new ReliableStream(udp, rremote, conv)

    const dbg = (...a) => {
      if (process.env.MAGNETGATE_DEBUG) console.log(...a)
    }
    udp.on('message', (msg, rinfo) => {
      const p = decode(msg)
      dbg(
        '[dbg-cli] datagram',
        p ? `cmd=${p.cmd} seq=${p.seq} (${p.payload.length}b)` : 'undecodable',
        'from',
        rinfo.address + ':' + rinfo.port
      )
      if (!p || p.conv !== conv) return
      stream.onDatagram(msg, rinfo)
    })

    udp.on('error', (e) => {
      dbg('[dbg] client udp error:', e.message)
      clearTimeout(t)
      stream.destroy()
      reject(e)
    })
    const t = setTimeout(() => {
      dbg('[dbg] handshake timeout')
      stream.destroy()
      reject(new Error('udp handshake timeout'))
    }, 15000)
    stream.once('ready', () => {
      dbg('[dbg] ready')
      clearTimeout(t)
      resolve(stream)
    })
    stream.once('close', () => {
      dbg('[dbg] stream closed')
      clearTimeout(t)
      try {
        udp.close()
      } catch {}
      reject(new Error('closed during handshake'))
    })

    stream.startHello()
  })
}

// Exit side: one bound UDP socket; each HELLO spawns a stream (deduped by conv@peer)
export class ExitUdpMux {
  constructor({ port, boxKey, onConn, idleMs = Number(process.env.MAGNETGATE_UDP_IDLE_MS ?? 600000) }) {
    this.boxKey = boxKey
    this.onConn = onConn
    this.idleMs = idleMs > 0 ? idleMs : 0
    this.udp = dgram.createSocket('udp4')
    this.streams = new Map() // key conv@peer -> { stream }
    this.udp.on('message', (msg, rinfo) => this.onDatagram(msg, rinfo))
    this.udp.on('error', () => {
      for (const { stream } of this.streams.values()) stream.destroy()
    })
    this.udp.bind(port)
    // A peer that simply vanishes never sends a FIN, and without this sweep its entry would stay
    // forever: the 512-stream cap would then lock out every new client (S9). unref() so the sweep
    // never keeps the process alive on its own.
    this.sweep = this.idleMs
      ? setInterval(() => this.evictIdle(), Math.min(30000, Math.max(1000, this.idleMs)))
      : null
    if (this.sweep?.unref) this.sweep.unref()
    this.udp.on('close', () => this.close())
  }

  // destroy streams that have seen no valid datagram and sent nothing for idleMs
  evictIdle() {
    if (!this.idleMs) return 0
    const cutoff = now() - this.idleMs
    let evicted = 0
    for (const { stream } of this.streams.values()) {
      if (stream.closed) continue
      if ((stream.lastActive ?? 0) > cutoff) continue
      stream.destroy()
      evicted++
    }
    return evicted
  }

  close() {
    if (this.sweep) clearInterval(this.sweep)
    this.sweep = null
  }

  onDatagram(msg, rinfo) {
    if (msg.length < 10 || msg[0] !== MAGIC) return
    const conv = msg.readUInt32BE(1)
    const cmd = msg[5]
    const key = `${conv}@${rinfo.address}:${rinfo.port}`
    const payload = msg.subarray(10)
    if (process.env.MAGNETGATE_DEBUG)
      console.log(
        `[dbg-exit] datagram conv=${conv} cmd=${cmd} from ${rinfo.address}:${rinfo.port} (${payload.length}b)`
      )

    if (cmd === UDP_CMD.HELLO) {
      if (payload.length || (!this.streams.has(key) && this.streams.size >= 512)) return
      sendDatagram(this.udp, encode(conv, UDP_CMD.HELLO_ACK, 0), rinfo)
      if (process.env.MAGNETGATE_DEBUG)
        console.log(`[dbg-exit] HELLO_ACK sent to ${rinfo.address}:${rinfo.port}`)
      if (!this.streams.has(key)) {
        const stream = new ReliableStream(this.udp, { host: rinfo.address, port: rinfo.port }, conv)
        stream.ready = true
        this.streams.set(key, { stream })
        stream.on('close', () => {
          if (this.streams.get(key)?.stream === stream) this.streams.delete(key)
        })
        this.onConn(stream, rinfo)
      }
      return
    }

    const entry = this.streams.get(key)
    if (!entry) return
    entry.stream.onDatagram(msg, rinfo)
  }
}
