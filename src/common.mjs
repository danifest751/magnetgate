import sodium from 'sodium-universal'
import crypto from 'node:crypto'

// router.bittorrent.com is listed first because it has an IPv4 address; the others are
// IPv6-only on some hosts and bittorrent-dht speaks udp4, so an IPv4 node must lead or the
// DHT fails to bootstrap ("No nodes to query"). A self-hosted node (DHT_BOOTSTRAP env) is
// still the most reliable option.
export const BOOTSTRAP = (process.env.DHT_BOOTSTRAP ??
  'router.bittorrent.com:6881,dht.transmissionbt.com:6881,dht.libtorrent.org:25401')
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

// advisory PSK strength check (non-blocking): the whole security model rests on the PSK
export function pskWarning(psk) {
  if (typeof psk !== 'string' || !psk) return 'empty PSK'
  const hex = /^[0-9a-f]+$/i.test(psk)
  if (hex && psk.length >= 32) return null                              // >=128-bit hex
  if (!hex && psk.length >= 20 && new Set(psk).size >= 12) return null  // long, varied passphrase
  return 'weak PSK — use a >=128-bit random secret (e.g. `openssl rand -hex 16`)'
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

// ---------- forward-secret session handshake (protocol v3) ----------
// Ephemeral X25519 DH, authenticated and encrypted under the PSK-derived boxKey, with a
// timestamp for replay protection. The ephemeral secrets are discarded after the handshake,
// so a later compromise of the PSK does NOT reveal past session keys (forward secrecy).
//   msg1 (client -> exit): nonce(24) || secretbox(boxKey, nonce, cePk(32) || tsMs(8))
//   msg2 (exit -> client): nonce(24) || secretbox(boxKey, nonce, eePk(32))
//   session keys = BLAKE2b-512(dh || cePk || eePk || boxKey) split into { c2e, e2c }
export const HS_TS_SKEW_MS = 60_000
const HS_MSG1_LEN = 24 + (32 + 8) + 16
const HS_MSG2_LEN = 24 + 32 + 16

function ephemeral() {
  const sk = Buffer.alloc(sodium.crypto_scalarmult_SCALARBYTES)
  crypto.randomFillSync(sk)
  const pk = Buffer.alloc(sodium.crypto_scalarmult_BYTES)
  sodium.crypto_scalarmult_base(pk, sk)
  return { sk, pk }
}

function sessionKeys(dh, cePk, eePk, boxKey) {
  const okm = Buffer.alloc(64)
  sodium.crypto_generichash(okm, Buffer.concat([dh, cePk, eePk, boxKey]))
  return { c2e: okm.subarray(0, 32), e2c: okm.subarray(32, 64) }
}

export function hsClientInit(boxKey) {
  const { sk: ceSk, pk: cePk } = ephemeral()
  const pl = Buffer.alloc(40)
  cePk.copy(pl, 0)
  pl.writeBigUInt64BE(BigInt(Date.now()), 32)
  const nonce = crypto.randomBytes(24)
  const ct = Buffer.alloc(pl.length + 16)
  sodium.crypto_secretbox_easy(ct, pl, nonce, boxKey)
  return { msg1: Buffer.concat([nonce, ct]), ceSk, cePk }
}

// exit side: verify PSK auth, check clock skew, derive keys, build the reply.
// returns { msg2, keys, cePk, ts } or null on failure. Replay (repeated cePk) is the
// caller's responsibility (needs a shared TTL cache).
export function hsExitRespond(boxKey, msg1) {
  try {
    if (!msg1 || msg1.length !== HS_MSG1_LEN) return null
    const nonce = msg1.subarray(0, 24)
    const ct = msg1.subarray(24)
    const pl = Buffer.alloc(ct.length - 16)
    if (!sodium.crypto_secretbox_open_easy(pl, ct, nonce, boxKey)) return null
    const cePk = Buffer.from(pl.subarray(0, 32))
    const ts = Number(pl.readBigUInt64BE(32))
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > HS_TS_SKEW_MS) return null
    const { sk: eeSk, pk: eePk } = ephemeral()
    const dh = Buffer.alloc(sodium.crypto_scalarmult_BYTES)
    sodium.crypto_scalarmult(dh, eeSk, cePk) // throws on all-zero / low-order point
    const keys = sessionKeys(dh, cePk, eePk, boxKey)
    const n2 = crypto.randomBytes(24)
    const ct2 = Buffer.alloc(eePk.length + 16)
    sodium.crypto_secretbox_easy(ct2, eePk, n2, boxKey)
    return { msg2: Buffer.concat([n2, ct2]), keys, cePk, ts }
  } catch { return null }
}

// client side: verify the exit's reply and derive the same session keys.
// returns { keys } or null.
export function hsClientFinish(boxKey, msg2, ceSk, cePk) {
  try {
    if (!msg2 || msg2.length !== HS_MSG2_LEN) return null
    const nonce = msg2.subarray(0, 24)
    const ct = msg2.subarray(24)
    const eePk = Buffer.alloc(ct.length - 16)
    if (!sodium.crypto_secretbox_open_easy(eePk, ct, nonce, boxKey)) return null
    const dh = Buffer.alloc(sodium.crypto_scalarmult_BYTES)
    sodium.crypto_scalarmult(dh, ceSk, eePk) // throws on all-zero / low-order point
    return { keys: sessionKeys(dh, Buffer.from(cePk), eePk, boxKey) }
  } catch { return null }
}

// ---------- multiplexed frames (protocol v2) ----------

export const FRAME = { OPEN: 1, DATA: 2, CLOSE: 3, PING: 4, PONG: 5, UDP_ASSOC: 6, UDP_DATA: 7, UDP_CLOSE: 8 }

// frame: [u32 len][u8 type][u32 streamId][24B nonce][secretbox(plain)]
// len counts everything after the length field. streamId 0 = session-level (ping/pong).
// The plaintext of DATA frames is padded inside the encryption ([padLen u16][pad][data]) so
// wire sizes do not exactly reveal the payload shape — lengths are quantized to buckets.
// padLen is a 2-byte big-endian prefix: buckets reach 4096, so pad can exceed 255 and must
// not be truncated into a single byte (that corrupted every DATA frame >= 512 B, incl. TLS
// ClientHello ~517 B — the cause of the "HTTPS through the tunnel fails" bug).
const PAD_HDR = 2
const PAD_BUCKETS = [64, 256, 512, 1024, 2048, 4096]

function padPlain(plain) {
  const bucket = PAD_BUCKETS.find(b => plain.length + PAD_HDR <= b) ?? Math.ceil((plain.length + PAD_HDR) / 4096) * 4096
  const padLen = Math.max(0, bucket - plain.length - PAD_HDR)
  const out = Buffer.alloc(PAD_HDR + padLen + plain.length)
  out.writeUInt16BE(padLen, 0)
  if (padLen > 0) crypto.randomBytes(padLen).copy(out, PAD_HDR)
  plain.copy(out, PAD_HDR + padLen)
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
        const plain = type === FRAME.DATA && padded.length >= PAD_HDR
          ? padded.subarray(PAD_HDR + padded.readUInt16BE(0)) // strip [padLen u16][pad]
          : padded
        onFrame(type, streamId, plain)
      }
    },
  }
}

