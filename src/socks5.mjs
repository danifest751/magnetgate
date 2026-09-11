import net from 'node:net'
import dgram from 'node:dgram'

// Minimal SOCKS5 (RFC 1928): no-auth, CONNECT + UDP ASSOCIATE, domain/IPv4.
// routeFn({host, port}, app, firstData) — TCP CONNECT routing after the handshake.
// udpFn(req, control, sendReply) — UDP ASSOCIATE handshake:
//   req = {host, port, data} — the first datagram from the app (SOCKS5 UDP header parsed),
//   control = the SOCKS TCP control connection (association dies with it),
//   sendReply(payload) — sends a reply datagram back to the app; payload starts at
//   ATYP (source address of the reply): [atyp][addr][port][data] — the same shape
//   that travels through the tunnel (both directions use this format).
export function startSocks5Server(port, routeFn, udpFn) {
  const server = net.createServer((app) => {
    app.setTimeout(600000, () => app.destroy())
    let buf = Buffer.alloc(0)
    let stage = 0
    const fail = (code) => { try { app.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])) } catch {} }

    app.on('data', function onData(chunk) {
      if (stage === 2) return
      buf = Buffer.concat([buf, chunk])
      if (stage === 0) {
        if (buf.length < 2) return
        const n = buf[1]
        if (buf.length < 2 + n) return
        const methods = buf.subarray(2, 2 + n)
        if (!methods.includes(0x00)) return fail(0xff)
        app.write(Buffer.from([5, 0]))
        buf = buf.subarray(2 + n)
        stage = 1
      }
      if (stage === 1 && buf.length >= 5) {
        const ver = buf[0]
        const cmd = buf[1]
        const atyp = buf[3]
        if (ver !== 5) return app.destroy()
        let host, port, len
        if (atyp === 1) {
          if (buf.length < 10) return
          host = [...buf.subarray(4, 8)].join('.')
          port = buf.readUInt16BE(8)
          len = 10
        } else if (atyp === 3) {
          const dl = buf[4]
          if (buf.length < 5 + dl + 2) return
          host = buf.toString('latin1', 5, 5 + dl)
          port = buf.readUInt16BE(5 + dl)
          len = 5 + dl + 2
        } else if (atyp === 4) {
          if (buf.length < 22) return
          host = [...buf.subarray(4, 20)].map(b => b.toString(16)).join(':')
          port = buf.readUInt16BE(20)
          len = 22
        } else return fail(0x08)
        if (cmd !== 1 && cmd !== 3) return fail(0x07) // CONNECT or UDP ASSOCIATE

        const rest = buf.subarray(len)
        buf = Buffer.alloc(0)
        stage = 2
        app.removeListener('data', onData)

        if (cmd === 3) {
          // UDP ASSOCIATE: bind a local UDP relay; the control connection keeps it alive
          const udp = dgram.createSocket('udp4')
          let rinfo = null
          let alive = true
          const sendReply = (payload) => {
            // payload starts at ATYP: [atyp][addr][port][data]
            if (!alive || !rinfo) return
            const head = Buffer.alloc(3)
            head[2] = 0 // FRAG 0
            try { udp.send(Buffer.concat([head, payload]), rinfo.port, rinfo.address) } catch {}
          }
          udp.on('message', (msg, info) => {
            if (msg.length < 4) return
            if (msg[2] !== 0) return // fragmentation unsupported
            const at = msg[3]
            let dhost, dport, start
            if (at === 1) {
              if (msg.length < 10) return
              dhost = [...msg.subarray(4, 8)].join('.')
              dport = msg.readUInt16BE(8)
              start = 10
            } else if (at === 3) {
              const dl = msg[4]
              if (msg.length < 5 + dl + 2) return
              dhost = msg.toString('latin1', 5, 5 + dl)
              dport = msg.readUInt16BE(5 + dl)
              start = 5 + dl + 2
            } else if (at === 4) {
              if (msg.length < 22) return
              dhost = [...msg.subarray(4, 20)].map(b => b.toString(16)).join(':')
              dport = msg.readUInt16BE(20)
              start = 22
            } else return
            rinfo = info
            try {
              // tunnel payload starts at ATYP (no RSV/FRAG)
              udpFn({ host: dhost, port: dport, data: msg.subarray(start) }, app, sendReply)
            } catch {}
          })
          udp.on('error', () => {})
          udp.bind(0, '127.0.0.1', () => {
            const p = udp.address().port
            app.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, (p >> 8) & 0xff, p & 0xff]))
          })
          app.on('close', () => { alive = false; try { udp.close() } catch {} })
          app.on('error', () => {})
          return
        }

        app.write(Buffer.from([5, 0, 0, 1, 10, 0, 0, 1, 0, 0])) // CONNECT success
        routeFn({ host, port }, app, rest)
      }
    })
    app.on('error', () => {})
  })
  return server
}
