// raw DHT ping test: node ping-test.mjs <host> [port]
import bencode from 'bencode'
import dgram from 'node:dgram'

const host = process.argv[2] ?? 'router.bittorrent.com'
const port = parseInt(process.argv[3] ?? '6881')
const s = dgram.createSocket('udp4')
const t0 = Date.now()
s.on('message', (m) => {
  const d = bencode.decode(m)
  console.log(`reply from ${host}:${port} in ${Date.now() - t0}ms y=${d.y}`)
  process.exit(0)
})
const msg = bencode.encode({ t: Buffer.from('ab'), y: 'q', q: 'ping', a: { id: Buffer.alloc(20, 7) } })
s.send(msg, port, host, () => console.log(`sent ping to ${host}:${port}`))
setTimeout(() => { console.log(`NO RESPONSE from ${host}:${port} in 5s`); process.exit(1) }, 5000)
