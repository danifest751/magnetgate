// Nostr as a second rendezvous channel (independent of the Mainline DHT).
// The exit publishes the SAME sealed offer it puts into the DHT as a Nostr
// parameterized-replaceable event (kind 30078, NIP-78): relays store the latest and serve it to
// new subscribers immediately, so discovery is push + instant (no wait for the next republish).
// Authenticity/confidentiality come from the secretbox seal under boxKey (as on the DHT path);
// the Nostr signature only satisfies relays and gives a stable author pubkey to filter by.
//
//   identity: secp256k1 keypair derived from the PSK ("mgt-nostr:") — schnorr/BIP340
//   event:    kind 30078, tags [["d", H("mgt-nostr-d:"+psk)], ["mgt-seq", seq]], content = base64(sealed)
import WebSocket from 'ws'
import crypto from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1.js'
import { unseal } from './common.mjs'

// Measured on 2026-09-19 with core/cmd/nostr-probe, four subscriptions each, our own sealed offers
// rather than a ping: nos.lol and nostr.mom served ten, relay.primal.net and relay.snort.social nine,
// relay.damus.io seven with one handshake refused by its edge (503) - so it goes last. Candidates left
// out for the failure this project keeps meeting: offchain.pub connected four times of four and served
// nothing at all, nostr.wine refused. Five, because relay health varies by day and by network.
export const NOSTR_RELAYS = (
  process.env.MAGNETGATE_NOSTR_RELAYS ??
  'wss://nos.lol,wss://nostr.mom,wss://relay.primal.net,wss://relay.snort.social,wss://relay.damus.io'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const KIND = 30078

export function nostrKeys(psk) {
  const sk = crypto
    .createHash('sha256')
    .update('mgt-nostr:' + psk)
    .digest()
  const pkHex = Buffer.from(schnorr.getPublicKey(sk)).toString('hex')
  return { sk, pkHex }
}

// The `d` tag is the replaceable-event key a relay keeps: it MUST differ per slot, otherwise two
// nodes publishing under one PSK overwrite each other and only the last writer survives. Slot 0
// keeps the original derivation so existing deployments and older clients are unaffected.
const dTagOf = (psk, slot = 0) =>
  crypto
    .createHash('sha256')
    .update(Number(slot) === 0 ? 'mgt-nostr-d:' + psk : `mgt-nostr-d:${Number(slot)}:${psk}`)
    .digest('hex')
    .slice(0, 32)

// exported so a test can assert the per-slot separation (two nodes on one PSK must not share a
// replaceable-event key) and that slot 0 still derives the legacy tag
export const nostrTagOf = (psk, slot = 0) => dTagOf(psk, slot)

export function buildEvent(sk, pkHex, tags, content) {
  const created_at = Math.floor(Date.now() / 1000)
  // sign the raw 32-byte id (BIP340). Passing a hex string would be signed as UTF-8 bytes and
  // relays (which verify over the id bytes) would reject the event.
  const idBytes = crypto
    .createHash('sha256')
    .update(JSON.stringify([0, pkHex, created_at, KIND, tags, content]))
    .digest()
  const id = idBytes.toString('hex')
  const sig = Buffer.from(schnorr.sign(idBytes, sk)).toString('hex')
  return { id, pubkey: pkHex, created_at, kind: KIND, tags, content, sig }
}

// a resilient relay socket: reconnects with backoff, resends the subscription on reconnect
function relayConn(url, onData, subReq) {
  let ws = null,
    ready = false,
    closed = false,
    backoff = 1000,
    timer = null,
    latest = null
  const connect = () => {
    if (closed) return
    try {
      ws = new WebSocket(url, { handshakeTimeout: 8000, maxPayload: 128 * 1024 })
    } catch {
      return schedule()
    }
    ws.on('open', () => {
      ready = true
      backoff = 1000
      if (subReq) ws.send(subReq)
      if (latest) ws.send(latest)
    })
    ws.on('message', (d) => {
      if (onData)
        try {
          onData(d.toString())
        } catch {}
    })
    ws.on('error', () => {})
    ws.on('close', () => {
      ready = false
      schedule()
    })
  }
  const schedule = () => {
    if (closed) return
    timer = setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 30000)
  }
  connect()
  return {
    send(msg) {
      latest = msg
      if (ready && ws)
        try {
          ws.send(msg)
        } catch {}
    },
    close() {
      closed = true
      clearTimeout(timer)
      try {
        ws && ws.close()
      } catch {}
    }
  }
}

// exit side: publish the sealed offer to the whole relay pool
export function nostrPublisher(psk, slot = 0, relays = NOSTR_RELAYS) {
  const { sk, pkHex } = nostrKeys(psk)
  const d = dTagOf(psk, slot)
  const conns = relays.map((url) => relayConn(url))
  return {
    publish(sealedBuf, seq) {
      const ev = buildEvent(
        sk,
        pkHex,
        [
          ['d', d],
          ['mgt-seq', String(seq)]
        ],
        sealedBuf.toString('base64')
      )
      const msg = JSON.stringify(['EVENT', ev])
      for (const c of conns) c.send(msg)
    },
    relays: relays.length,
    close() {
      for (const c of conns) c.close()
    }
  }
}

// client side: subscribe across the pool; decrypt each event and hand the offer object to onOffer
export function nostrSubscriber(psk, boxKey, onOffer, slot = 0) {
  const { pkHex } = nostrKeys(psk)
  const d = dTagOf(psk, slot)
  const subId = 'mgt'
  const req = JSON.stringify([
    'REQ',
    subId,
    { authors: [pkHex], kinds: [KIND], '#d': [d], limit: 1 }
  ])
  const onData = (data) => {
    let m
    try {
      m = JSON.parse(data)
    } catch {
      return
    }
    if (m[0] !== 'EVENT' || m[1] !== subId || !m[2]) return
    const ev = m[2]
    const seqTag = (ev.tags?.find((t) => t[0] === 'mgt-seq') || [])[1]
    // the seq tag is used verbatim as the seal nonce domain; the exit publishes the Nostr offer
    // under 'n'+seq (a nonce space disjoint from the DHT's numeric seq), so keep it as a string.
    if (typeof seqTag !== 'string' || !/^n?[0-9]{1,16}$/.test(seqTag)) return
    let ct
    try {
      ct = Buffer.from(ev.content, 'base64')
    } catch {
      return
    }
    const plain = unseal(boxKey, ct, seqTag) // MAC-verified: a tampered seq/content is rejected
    if (!plain) return
    try {
      onOffer(JSON.parse(plain.toString()))
    } catch {}
  }
  const conns = NOSTR_RELAYS.map((url) => relayConn(url, onData, req))
  return {
    relays: NOSTR_RELAYS.length,
    close() {
      for (const c of conns) c.close()
    }
  }
}
