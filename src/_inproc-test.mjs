// In-process test: ExitUdpMux (on 49001) + client ReliableStream, loopback
import { ReliableStream, ExitUdpMux } from './udpsess.mjs'
import crypto from 'node:crypto'
import { deriveKeys, connKeys } from './common.mjs'

const psk = 'test-psk-mux'
const boxKey = deriveKeys(psk).boxKey

import dgram from 'node:dgram'
const mux = new ExitUdpMux({ port: 49001, boxKey, onConn: (stream, rinfo) => {
  console.log('[test] exit: new stream from', rinfo.address + ':' + rinfo.port)
  stream.on('data', (d) => {
    console.log('[exit] got', d.length, 'bytes')
    const pong = Buffer.from('pong-echo')
    stream.write(pong)
  })
}})
console.log('[test] exit udp mux bound on 49001')

setTimeout(() => {
  const connSalt = crypto.randomBytes(8)
  const udp = dgram.createSocket('udp4')
  udp.bind(() => {
    console.log('[test] client socket bound on', udp.address().port)
    const stream = new ReliableStream(udp, { host: '127.0.0.1', port: 49001 }, 777)
    stream.keys = connKeys(boxKey, connSalt)
    stream.on('data', (d) => { console.log('[client] data:', d.toString()); process.exit(0) })
    stream.once('ready', () => {
      console.log('[client] READY — sending payload')
      stream.write(Buffer.from('ping-payload'))
    })
    stream.startHello(connSalt)
  })
}, 1000)

setTimeout(() => { console.log('[test] TIMEOUT'); process.exit(1) }, 8000)

