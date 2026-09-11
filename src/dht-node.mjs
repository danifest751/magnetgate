// node dht-node.mjs <listenPort> [bootstrapAddrCSV]
import DHT from 'bittorrent-dht'
import { bep44Verify } from './common.mjs'
const port = parseInt(process.argv[2])
const boot = process.argv[3] ? process.argv[3].split(',') : []
const dht = new DHT({ bootstrap: boot, verify: bep44Verify })
dht.listen(port, () => console.log(`[dht] node on 127.0.0.1:${port}, bootstrap=${boot.join(',') || 'none'}`))
