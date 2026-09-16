// node get-test.mjs <psk>
import DHT from 'bittorrent-dht'
import { deriveKeys, saltOf, targetOf, unseal, bep44Verify } from '../../src/common.mjs'

const SECRET = process.argv[2]
const { pk, boxKey } = deriveKeys(SECRET)
const SALT = saltOf(SECRET)
const TARGET = targetOf(pk, SALT)
const BOOT = (process.env.DHT_BOOTSTRAP ?? 'router.bittorrent.com:6881,dht.transmissionbt.com:6881,router.utorrent.com:6881').split(',')
const dht = new DHT({ bootstrap: BOOT, verify: bep44Verify })
const t0 = Date.now()
dht.listen(() => console.log('[dht] listening'))
dht.get(TARGET, { salt: SALT }, (err, res) => {
  console.log('elapsed', Date.now() - t0, 'ms')
  if (err || !res) { console.log('get failed:', err?.message ?? 'no result'); process.exit(1) }
  const p = unseal(boxKey, res.v, res.seq)
  console.log('seq=', res.seq, 'offer=', p ? p.toString() : 'DECRYPT-FAIL')
  process.exit(0)
})
setTimeout(() => { console.log('TIMEOUT 30s'); process.exit(2) }, 30000)
