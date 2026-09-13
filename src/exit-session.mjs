import net from 'node:net'
import dgram from 'node:dgram'
import {
  hsExitRespond,
  HS_MSG1_LEN,
  HS_TS_SKEW_MS,
  makeCodecV2,
  makeFrameEncoder,
  FRAME
} from './common.mjs'
import {
  validPort,
  isBlockedIp,
  guardedLookup,
  resolveTarget,
  decodeAddress,
  encodeAddress
} from './address.mjs'
import { boundedWrite } from './bounded-write.mjs'

export function createExitHandler({
  boxKey,
  allowPrivate = false,
  maxSessions = 512,
  maxPending = 64,
  maxStreams = 256,
  handshakeMs = 5000,
  log = () => {}
}) {
  const active = new Set(),
    pending = new Set(),
    seen = new Map()
  const handler = (sock) => {
    if (active.size >= maxSessions || pending.size >= maxPending) {
      sock.destroy()
      return
    }
    active.add(sock)
    pending.add(sock)
    sock.setKeepAlive?.(true, 15000)
    let closed = false,
      codec,
      encode,
      hs = Buffer.alloc(0),
      lastActivity = Date.now()
    const streams = new Map(),
      relays = new Map()
    const closeRelay = (id) => {
      const relay = relays.get(id)
      relays.delete(id)
      if (relay) {
        relay.closed = true
        for (const udp of relay.sockets.values()) {
          try {
            udp.close()
          } catch {}
        }
      }
    }
    const kill = () => {
      if (closed) return
      closed = true
      active.delete(sock)
      pending.delete(sock)
      clearTimeout(deadline)
      clearInterval(idle)
      codec?.kill()
      for (const up of streams.values()) up.destroy()
      streams.clear()
      for (const id of relays.keys()) closeRelay(id)
      sock.destroy()
    }
    const deadline = setTimeout(kill, handshakeMs)
    const idle = setInterval(() => {
      if (Date.now() - lastActivity > 600000) kill()
    }, 30000)
    const send = (type, id, plain = Buffer.alloc(0), source) => {
      if (closed) return
      try {
        boundedWrite(sock, encode(type, id, plain), source)
      } catch {
        kill()
      }
    }
    const relaySend = (id, payload) => {
      const relay = relays.get(id),
        dst = decodeAddress(payload)
      if (!relay || !dst || !validPort(dst.port) || dst.data.length > 65507)
        return send(FRAME.CLOSE, id)
      if (relay.pending >= 128) {
        closeRelay(id)
        return send(FRAME.CLOSE, id)
      }
      relay.pending++
      resolveTarget(dst.host, allowPrivate)
        .then(({ address, family }) => {
          if (closed || relay.closed) return
          let udp = relay.sockets.get(family)
          if (!udp) {
            udp = dgram.createSocket(family === 6 ? 'udp6' : 'udp4')
            relay.sockets.set(family, udp)
            udp.on('error', () => {
              closeRelay(id)
              send(FRAME.CLOSE, id)
            })
            udp.on('message', (msg, info) => {
              if (!relay.peers.has(`${info.address}:${info.port}`)) return
              send(FRAME.UDP_DATA, id, encodeAddress(info.address, info.port, msg))
            })
          }
          if (relay.peers.size >= 256 && !relay.peers.has(`${address}:${dst.port}`))
            throw new Error('UDP peer limit')
          relay.peers.add(`${address}:${dst.port}`)
          udp.send(dst.data, dst.port, address, (err) => {
            if (err) {
              closeRelay(id)
              send(FRAME.CLOSE, id)
            }
          })
        })
        .catch(() => {
          closeRelay(id)
          send(FRAME.CLOSE, id)
        })
        .finally(() => {
          relay.pending--
        })
    }
    const onFrame = (type, id, plain) => {
      lastActivity = Date.now()
      if (type === FRAME.OPEN) {
        if (streams.has(id) || relays.has(id)) return kill()
        if (streams.size + relays.size >= maxStreams) return send(FRAME.CLOSE, id)
        let cmd
        try {
          cmd = JSON.parse(plain.toString())
        } catch {
          return send(FRAME.CLOSE, id)
        }
        if (
          !cmd ||
          typeof cmd.host !== 'string' ||
          !cmd.host.length ||
          cmd.host.length > 253 ||
          !validPort(cmd.port) ||
          (!allowPrivate && net.isIP(cmd.host) && isBlockedIp(cmd.host))
        )
          return send(FRAME.CLOSE, id)
        let up
        try {
          up = net.connect({
            host: cmd.host,
            port: cmd.port,
            lookup: guardedLookup(allowPrivate),
            allowHalfOpen: true
          })
        } catch {
          return send(FRAME.CLOSE, id)
        }
        streams.set(id, up)
        up.setKeepAlive(true, 15000)
        up.setTimeout(10000, () => up.destroy())
        up.on('connect', () => {
          up.setTimeout(120000)
          send(FRAME.OPEN_OK, id)
        })
        up.on('data', (data) => send(FRAME.DATA, id, data, up))
        up.on('end', () => send(FRAME.END, id))
        up.on('error', () => up.destroy())
        up.on('close', () => {
          streams.delete(id)
          send(FRAME.CLOSE, id)
        })
      } else if (type === FRAME.DATA) {
        const up = streams.get(id)
        if (up) boundedWrite(up, plain, sock)
      } else if (type === FRAME.END) {
        streams.get(id)?.end()
      } else if (type === FRAME.CLOSE || type === FRAME.UDP_CLOSE) {
        streams.get(id)?.destroy()
        streams.delete(id)
        closeRelay(id)
      } else if (type === FRAME.UDP_ASSOC) {
        if (streams.has(id) || relays.has(id)) return kill()
        if (streams.size + relays.size >= maxStreams) return send(FRAME.CLOSE, id)
        relays.set(id, { sockets: new Map(), peers: new Set(), pending: 0, closed: false })
        if (plain.length) relaySend(id, plain)
      } else if (type === FRAME.UDP_DATA) relaySend(id, plain)
      else if (type === FRAME.PING) send(FRAME.PONG, 0, plain)
      else kill()
    }
    sock.on('data', (chunk) => {
      if (closed) return
      if (codec) return codec.push(chunk)
      // Only retain the fixed-size handshake; the remaining bytes belong to the codec.
      const take = Math.min(2 + HS_MSG1_LEN - hs.length, chunk.length)
      hs = Buffer.concat([hs, chunk.subarray(0, take)])
      if (hs.length >= 2 && hs.readUInt16BE(0) !== HS_MSG1_LEN) return kill()
      if (hs.length < 2 + HS_MSG1_LEN) return
      const r = hsExitRespond(boxKey, hs.subarray(2))
      if (!r) return kill()
      const now = Date.now()
      for (const [k, expires] of seen) if (expires < now) seen.delete(k)
      const key = r.cePk.toString('hex')
      if (seen.has(key) || seen.size >= 8192) return kill()
      seen.set(key, Math.max(now, r.ts) + HS_TS_SKEW_MS)
      clearTimeout(deadline)
      pending.delete(sock)
      encode = makeFrameEncoder(r.keys.e2c)
      codec = makeCodecV2(r.keys.c2e, onFrame, kill)
      const header = Buffer.alloc(2)
      header.writeUInt16BE(r.msg2.length)
      boundedWrite(sock, Buffer.concat([header, r.msg2]))
      hs = Buffer.alloc(0)
      log('native v4 session authenticated')
      if (chunk.length > take) codec.push(chunk.subarray(take))
    })
    sock.on('error', kill)
    sock.on('close', kill)
  }
  handler.close = () => {
    for (const sock of active) sock.destroy()
  }
  handler.stats = () => ({ active: active.size, pending: pending.size })
  return handler
}
