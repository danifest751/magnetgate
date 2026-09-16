// dns-test.mjs — raw DNS query to 1.1.1.1:53 (run on the VPS)
import dgram from 'node:dgram'
const d = dgram.createSocket('udp4')
const q = Buffer.from([
  0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0,
  7, ...'example', 3, ...'com', 0,
  0, 1, 0, 1,
])
d.on('message', (m) => { console.log('dns reply:', m.length, 'bytes'); process.exit(0) })
d.send(q, 53, '1.1.1.1', () => console.log('query sent'))
setTimeout(() => { console.log('no reply in 5s'); process.exit(1) }, 5000)
