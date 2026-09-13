import net from 'node:net'
import dgram from 'node:dgram'
import { decodeAddress, validPort } from './address.mjs'

// Connected duplexes remain paused until the SOCKS reply is sent.
export function startSocks5Server(port, routeFn, udpFn) {
  return net.createServer({ allowHalfOpen: true }, (app) => {
    let stage = 0,
      buf = Buffer.alloc(0)
    app.setTimeout(10000, () => app.destroy())
    app.on('error', () => {})
    const fail = (code) => app.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length > 128 * 1024) return app.destroy()
      if (stage === 0) {
        if (buf.length < 2) return
        if (buf[0] !== 5 || !buf[1]) return app.destroy()
        if (buf.length < 2 + buf[1]) return
        if (!buf.subarray(2, 2 + buf[1]).includes(0)) return app.end(Buffer.from([5, 255]))
        const size = 2 + buf[1]
        app.write(Buffer.from([5, 0]))
        buf = buf.subarray(size)
        stage = 1
      }
      if (buf.length < 4) return
      if (buf[0] !== 5 || buf[2] !== 0) return app.destroy()
      if (![1, 3, 4].includes(buf[3])) return fail(8)
      const target = decodeAddress(buf.subarray(3))
      if (!target) {
        if (buf.length > 270) fail(8)
        return
      }
      const cmd = buf[1]
      if (cmd !== 1 && cmd !== 3) return fail(7)
      app.removeListener('data', onData)
      app.pause()
      app.setTimeout(600000)
      if (cmd === 3) {
        const udp = dgram.createSocket('udp4')
        let peer = null
        udp.on('error', () => app.destroy())
        udp.on('message', (msg, info) => {
          if (
            msg.length < 4 ||
            msg[0] !== 0 ||
            msg[1] !== 0 ||
            msg[2] !== 0 ||
            info.address !== '127.0.0.1'
          )
            return
          if (peer && (peer.port !== info.port || peer.address !== info.address)) return
          const dst = decodeAddress(msg.subarray(3))
          if (!dst || !validPort(dst.port)) return
          peer = info
          const reply = (payload) => {
            if (!app.destroyed && peer)
              udp.send(Buffer.concat([Buffer.alloc(3), payload]), peer.port, peer.address, () => {})
          }
          try {
            udpFn(dst, app, reply)
          } catch {
            app.destroy()
          }
        })
        udp.bind(0, '127.0.0.1', () => {
          if (app.destroyed) return
          const p = udp.address().port
          app.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, p >> 8, p & 255]))
          app.resume()
        })
        app.once('close', () => {
          try {
            udp.close()
          } catch {}
        })
        return
      }
      if (!validPort(target.port)) return fail(1)
      Promise.resolve()
        .then(() => routeFn({ host: target.host, port: target.port }, app))
        .then(({ sock, leftover }) => {
          if (app.destroyed) {
            sock.destroy()
            return
          }
          app.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          if (leftover?.length) app.write(leftover)
          if (target.data.length) sock.write(target.data)
          sock.on('error', () => app.destroy())
          app.once('close', () => sock.destroy())
          sock.once('close', () => app.destroy())
          app.pipe(sock)
          sock.pipe(app)
          app.resume()
          sock.resume()
        })
        .catch(() => {
          if (!app.destroyed) fail(5)
        })
    }
    app.on('data', onData)
  })
}
