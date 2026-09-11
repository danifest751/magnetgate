import sodium from 'sodium-universal'
import crypto from 'node:crypto'

export const BOOTSTRAP = (process.env.DHT_BOOTSTRAP ??
  'dht.transmissionbt.com:6881,dht.libtorrent.org:25401')
  .split(',').map(s => s.trim()).filter(Boolean)

export function deriveKeys(secret) {
  const seed = crypto.createHash('sha512').update('mgt-sig:' + secret).digest().subarray(0, 32)
  const pk = Buffer.alloc(32)
  const sk = Buffer.alloc(64)
  sodium.crypto_sign_seed_keypair(pk, sk, seed)
  const boxKey = Buffer.alloc(32)
  sodium.crypto_generichash(boxKey, Buffer.from('mgt-box:' + secret))
  return { pk, sk, boxKey }
}

export const saltOf = (s) => crypto.createHash('sha1').update('mgt-salt:' + s).digest()

export const targetOf = (pk, salt) =>
  crypto.createHash('sha1').update(Buffer.concat([pk, salt])).digest()

export function signer(sk) {
  return (buf) => {
    const sig = Buffer.alloc(64)
    sodium.crypto_sign_detached(sig, buf, sk)
    return sig
  }
}

// opts.verify for bittorrent-dht: verify(signature, encodeSigData(value), publicKey)
export function bep44Verify(sig, value, pk) {
  try {
    if (!sig || sig.length !== 64 || !value || !pk || pk.length !== 32) return false
    return sodium.crypto_sign_verify_detached(sig, value, pk) === true
  } catch {
    return false
  }
}

export function seal(key, plain, seq) {
  const nonce = crypto.createHash('sha256').update(key).update(String(seq)).digest().subarray(0, 24)
  const ct = Buffer.alloc(plain.length + 16)
  sodium.crypto_secretbox_easy(ct, plain, nonce, key)
  return ct
}

export function unseal(key, ct, seq) {
  const nonce = crypto.createHash('sha256').update(key).update(String(seq)).digest().subarray(0, 24)
  const plain = Buffer.alloc(ct.length - 16)
  if (sodium.crypto_secretbox_open_easy(plain, ct, nonce, key)) return plain
  return null
}

export function connKeys(boxKey, connSalt) {
  const c2e = Buffer.alloc(32)
  const e2c = Buffer.alloc(32)
  sodium.crypto_generichash(c2e, Buffer.concat([boxKey, connSalt, Buffer.from('c2e')]))
  sodium.crypto_generichash(e2c, Buffer.concat([boxKey, connSalt, Buffer.from('e2c')]))
  return { c2e, e2c }
}

// ---------- multiplexed frames (protocol v2) ----------

export const FRAME = { OPEN: 1, DATA: 2, CLOSE: 3, PING: 4, PONG: 5, UDP_ASSOC: 6, UDP_DATA: 7, UDP_CLOSE: 8 }

// frame: [u32 len][u8 type][u32 streamId][24B nonce][secretbox(plain)]
// len counts everything after the length field. streamId 0 = session-level (ping/pong).
// The plaintext of DATA frames is padded inside the encryption ([padLen][pad][data]) so
// wire sizes do not exactly reveal the payload shape — lengths are quantized to buckets.
const PAD_BUCKETS = [64, 256, 512, 1024, 2048, 4096]

function padPlain(plain) {
  const bucket = PAD_BUCKETS.find(b => plain.length + 1 <= b) ?? Math.ceil((plain.length + 1) / 4096) * 4096
  const padLen = Math.max(0, bucket - plain.length - 1)
  const out = Buffer.alloc(1 + padLen + plain.length)
  out[0] = padLen
  if (padLen > 0) crypto.randomBytes(padLen).copy(out, 1)
  plain.copy(out, 1 + padLen)
  return out
}

export function frame2(key, type, streamId, plain) {
  const nonce = crypto.randomBytes(24)
  let padded = plain
  if (type === FRAME.DATA) padded = padPlain(plain)
  const ct = Buffer.alloc(padded.length + 16)
  sodium.crypto_secretbox_easy(ct, padded, nonce, key)
  const head = Buffer.alloc(9)
  head.writeUInt32BE(5 + nonce.length + ct.length, 0)
  head[4] = type
  head.writeUInt32BE(streamId >>> 0, 5)
  return Buffer.concat([head, nonce, ct])
}

export function makeCodecV2(key, onFrame, onKill) {
  let buf = Buffer.alloc(0)
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 9) {
        const len = buf.readUInt32BE(0)
        if (len < 45 || len > 4 * 1024 * 1024) return onKill()
        if (buf.length < 4 + len) return
        const type = buf[4]
        const streamId = buf.readUInt32BE(5)
        const nonce = buf.subarray(9, 9 + 24)
        const ct = buf.subarray(9 + 24, 4 + len)
        const padded = Buffer.alloc(len - 5 - 24 - 16)
        if (!sodium.crypto_secretbox_open_easy(padded, ct, nonce, key)) return onKill()
        buf = buf.subarray(4 + len)
        const plain = type === FRAME.DATA && padded.length > 0
          ? padded.subarray(1 + padded[0]) // strip [padLen][pad]
          : padded
        onFrame(type, streamId, plain)
      }
    },
  }
}

