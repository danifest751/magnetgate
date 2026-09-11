// node src/handshake-test.mjs — ReliableStream handshake smoke test (direct)
import dgram from 'node:dgram'
import crypto from 'node:crypto'
import { ReliableStream } from './udpsess.mjs'
import { deriveKeys, connKeys } from './common.mjs'

const psk = process.argv[2] ?? 'test-psk-mux'
const host = process.argv[3] ?? '127.0.0.1'
const port = parseInt(process.argv[4] ?? '49001')
const boxKey = deriveKeys(psk).boxKey
console.log('starting handshake...')
const udp = dgram.createSocket('udp4')
udp.bind(() => {
  const bound = udp.address()
  console.log('client socket bound on', bound.address + ':' + bound.port)
  const connSalt = crypto.randomBytes(8)
  const stream = new ReliableStream(udp, { host, port }, 424242)
  stream.keys = connKeys(boxKey, connSalt)
  udp.on('message', (msg, rinfo) => stream.onDatagram(msg, rinfo))
  stream.once('ready', () => { console.log('HANDSHAKE OK'); process.exit(0) })
  stream.once('close', () => { console.log('STREAM CLOSED'); process.exit(1) })
  stream.startHello(connSalt)
})
setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 8000)
