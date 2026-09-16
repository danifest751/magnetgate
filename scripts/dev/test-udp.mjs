// node src/test-udp.mjs [socksPort=1080] [targetHost] [targetPort]
// SOCKS5 UDP ASSOCIATE handshake + a raw UDP datagram through the relay (DNS by default)
import net from 'node:net'
import dgram from 'node:dgram'

const socksPort = parseInt(process.argv[2] ?? '1080')
const tgtHost = process.argv[3] ?? '1.1.1.1'
const tgtPort = parseInt(process.argv[4] ?? '53')

const control = net.connect(socksPort, '127.0.0.1', () => {
  control.write(Buffer.from([5, 1, 0])) // greeting
})
control.on('error', (e) => { console.log('control error:', e.message); process.exit(1) })

control.on('data', function h1(chunk) {
  control.removeListener('data', h1)
  const req = Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]) // UDP ASSOCIATE
  control.write(req)
  control.on('data', function h2(chunk) {
    control.removeListener('data', h2)
    const bndPort = chunk.readUInt16BE(8)
    console.log('[udp] relay bound on port', bndPort)

    const dns = Buffer.concat([
      Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
      Buffer.from([7, ...'example', 3, ...'com', 0]),
      Buffer.from([0, 1, 0, 1]),
    ])
    const head = Buffer.alloc(10)
    head[3] = 1
    const ip = tgtHost.split('.').map(x => parseInt(x, 10) & 0xff)
    Buffer.from(ip).copy(head, 4)
    head.writeUInt16BE(tgtPort, 8)

    const udp = dgram.createSocket('udp4')
    udp.on('message', (msg) => {
      const at = msg[3]
      let src = '?'
      if (at === 1) src = [...msg.subarray(4, 8)].join('.')
      else if (at === 3) src = msg.toString('latin1', 5, 5 + msg[4])
      const answer = msg.subarray(10)
      console.log('[udp] reply from', src + ':' + msg.readUInt16BE(8), '—', answer.length, 'bytes')
      if (answer.length >= 4) console.log('[udp] resolved:', [...answer.subarray(answer.length - 4)].join('.'))
      process.exit(0)
    })
    udp.bind(() => udp.send(Buffer.concat([head, dns]), bndPort, '127.0.0.1'))
    setTimeout(() => { console.log('[udp] TIMEOUT 10s'); process.exit(1) }, 10000)
  })
})
