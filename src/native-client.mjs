import net from 'node:net'
import { Duplex } from 'node:stream'
import {
  hsClientInit,
  hsClientFinish,
  HS_MSG2_LEN,
  makeFrameEncoder,
  makeCodecV2,
  FRAME
} from './common.mjs'
import { boundedWrite, MAX_QUEUED_BYTES } from './bounded-write.mjs'
import { createClientUdpStream } from './udpsess.mjs'

export function clientHandshake(sock, boxKey, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const init = hsClientInit(boxKey)
    let buf = Buffer.alloc(0),
      done = false
    const finish = (err, result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.removeListener('data', onData)
      sock.removeListener('error', onError)
      sock.removeListener('close', onClose)
      if (err) {
        sock.destroy()
        reject(err)
      } else {
        sock.pause?.()
        resolve(result)
      }
    }
    const onError = (err) => finish(err),
      onClose = () => finish(new Error('handshake closed'))
    const onData = (chunk) => {
      const take = Math.min(2 + HS_MSG2_LEN - buf.length, chunk.length)
      buf = Buffer.concat([buf, chunk.subarray(0, take)])
      if (buf.length >= 2 && buf.readUInt16BE(0) !== HS_MSG2_LEN)
        return finish(new Error('unsupported native protocol'))
      if (buf.length < 2 + HS_MSG2_LEN) return
      const result = hsClientFinish(boxKey, buf.subarray(2), init.ceSk, init.cePk)
      if (!result) return finish(new Error('handshake authentication failed'))
      finish(null, { keys: result.keys, leftover: chunk.subarray(take) })
    }
    const timer = setTimeout(() => finish(new Error('handshake timeout')), timeoutMs)
    sock.on('data', onData)
    sock.once('error', onError)
    sock.once('close', onClose)
    const header = Buffer.alloc(2)
    header.writeUInt16BE(init.msg1.length)
    boundedWrite(sock, Buffer.concat([header, init.msg1]))
  })
}

export class Session {
  constructor(sock, keys, onClose = () => {}) {
    this.sock = sock
    this.encode = makeFrameEncoder(keys.c2e)
    this.streams = new Map()
    this.relays = new Map()
    this.nextId = 1
    this.closed = false
    this.lastPong = Date.now()
    this.onClose = onClose
    this.codec = makeCodecV2(
      keys.e2c,
      (type, id, data) => {
        const entry = this.streams.get(id)
        if (type === FRAME.OPEN_OK) {
          if (entry?.resolve) {
            clearTimeout(entry.timer)
            entry.resolve({ sock: entry.stream })
            entry.resolve = null
          }
        } else if (type === FRAME.DATA) {
          if (!entry) return // response already in flight when the local stream closed
          if (entry.stream.readableLength + data.length > MAX_QUEUED_BYTES)
            entry.stream.destroy(new Error('slow receiver'))
          else entry.stream.push(data)
        } else if (type === FRAME.UDP_DATA) this.relays.get(id)?.sendReply(data)
        else if (type === FRAME.END) {
          if (entry) entry.stream.push(null)
        } else if (type === FRAME.CLOSE) {
          if (entry) {
            if (entry.resolve) {
              entry.reject(new Error('upstream closed'))
              entry.stream.destroy()
            } else {
              entry.stream.push(null)
              entry.stream.end()
            }
          }
          const relay = this.relays.get(id)
          if (relay) relay.control.destroy()
        } else if (type === FRAME.PONG) this.lastPong = Date.now()
        else this.destroy()
      },
      () => this.destroy()
    )
    sock.on('data', (data) => this.codec.push(data))
    sock.on('error', () => this.destroy())
    sock.on('close', () => this.destroy())
    this.ping = setInterval(() => {
      if (Date.now() - this.lastPong > 30000) this.destroy()
      else this.send(FRAME.PING, 0, Buffer.alloc(0))
    }, 10000)
    sock.resume?.()
  }
  send(type, id, data = Buffer.alloc(0)) {
    if (this.closed) throw new Error('session closed')
    boundedWrite(this.sock, this.encode(type, id, data))
  }
  allocate() {
    if (this.nextId > 0xffffffff) {
      this.destroy()
      throw new Error('stream IDs exhausted')
    }
    return this.nextId++
  }
  openStream(target) {
    return new Promise((resolve, reject) => {
      const id = this.allocate(),
        session = this
      const stream = new Duplex({
        read() {},
        write(data, _encoding, cb) {
          try {
            session.send(FRAME.DATA, id, data)
            cb()
          } catch (e) {
            cb(e)
          }
        },
        final(cb) {
          try {
            session.send(FRAME.END, id)
            cb()
          } catch (e) {
            cb(e)
          }
        },
        destroy(err, cb) {
          const entry = session.streams.get(id)
          if (entry) {
            clearTimeout(entry.timer)
            entry.reject(err || new Error('stream closed'))
            session.streams.delete(id)
          }
          if (!session.closed) {
            try {
              session.send(FRAME.CLOSE, id)
            } catch {}
          }
          cb(err)
        }
      })
      stream.on('error', () => {})
      const timer = setTimeout(() => stream.destroy(new Error('upstream timeout')), 10000)
      this.streams.set(id, { stream, resolve, reject, timer })
      try {
        this.send(FRAME.OPEN, id, Buffer.from(JSON.stringify(target)))
      } catch (e) {
        stream.destroy(e)
      }
    })
  }
  openRelay(control, sendReply) {
    const id = this.allocate()
    const close = () => {
      this.relays.delete(id)
      if (!this.closed) {
        try {
          this.send(FRAME.UDP_CLOSE, id)
        } catch {}
      }
    }
    this.relays.set(id, { control, sendReply, close })
    control.once('close', close)
    this.send(FRAME.UDP_ASSOC, id)
    return { send: (payload) => this.send(FRAME.UDP_DATA, id, payload) }
  }
  destroy() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.ping)
    this.codec.kill()
    for (const entry of this.streams.values()) entry.stream.destroy(new Error('session closed'))
    for (const relay of this.relays.values()) {
      relay.control.removeListener('close', relay.close)
      relay.control.destroy()
    }
    this.streams.clear()
    this.relays.clear()
    this.sock.destroy()
    this.onClose()
  }
}

export async function connectNative(dp, boxKey, transport = 'tcp', onClose) {
  if (dp.protocol !== 4) throw new Error('native v4 endpoint required')
  const attempt = async (useUdp) => {
    const sock = useUdp
      ? await createClientUdpStream({ remote: { host: dp.host, port: dp.port } })
      : await new Promise((resolve, reject) => {
          const socket = net.connect(dp.port, dp.host)
          const timeout = setTimeout(() => {
            socket.destroy()
            reject(new Error('connect timeout'))
          }, 5000)
          socket.once('error', (err) => {
            clearTimeout(timeout)
            reject(err)
          })
          socket.once('connect', () => {
            clearTimeout(timeout)
            resolve(socket)
          })
        })
    const { keys, leftover } = await clientHandshake(sock, boxKey)
    const session = new Session(sock, keys, onClose)
    if (leftover.length) session.codec.push(leftover)
    return session
  }
  if (transport === 'udp' && dp.udp === 1) {
    try {
      return await attempt(true)
    } catch {}
  }
  return attempt(false)
}
