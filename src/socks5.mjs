import net from 'node:net'

// Minimal SOCKS5 (RFC 1928): no-auth, CONNECT only, domain/IPv4.
// routeFn({host, port}, app, firstData) — makes the routing decision after the handshake.
export function startSocks5Server(port, routeFn) {
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
        if (cmd !== 1) return fail(0x07) // CONNECT only

        const rest = buf.subarray(len)
        buf = Buffer.alloc(0)
        stage = 2
        app.removeListener('data', onData)
        app.write(Buffer.from([5, 0, 0, 1, 10, 0, 0, 1, 0, 0])) // success
        routeFn({ host, port }, app, rest)
      }
    })
    app.on('error', () => {})
  })
  return server
}
