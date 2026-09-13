import sodium from 'sodium-universal'
import crypto from 'node:crypto'

// router.bittorrent.com is listed first because it has an IPv4 address; the others are
// IPv6-only on some hosts and bittorrent-dht speaks udp4, so an IPv4 node must lead or the
// DHT fails to bootstrap ("No nodes to query"). A self-hosted node (DHT_BOOTSTRAP env) is
// still the most reliable option.
export const BOOTSTRAP = (
  process.env.DHT_BOOTSTRAP ??
  'router.bittorrent.com:6881,dht.transmissionbt.com:6881,dht.libtorrent.org:25401'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export function deriveKeys(secret) {
  const seed = crypto
    .createHash('sha512')
    .update('mgt-sig:' + secret)
    .digest()
    .subarray(0, 32)
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
  if (hex && psk.length >= 32) return null // >=128-bit hex
  if (!hex && psk.length >= 20 && new Set(psk).size >= 12) return null // long, varied passphrase
  return 'weak PSK — use a >=128-bit random secret (e.g. `openssl rand -hex 16`)'
}

export const saltOf = (s) =>
  crypto
    .createHash('sha1')
    .update('mgt-salt:' + s)
    .digest()

export const targetOf = (pk, salt) =>
  crypto
    .createHash('sha1')
    .update(Buffer.concat([pk, salt]))
    .digest()

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

// Versioned, random-nonce envelope. The sequence/domain is authenticated inside the box.
export function seal(key, plain, seq) {
  const nonce = crypto.randomBytes(24)
  const domain = Buffer.from(String(seq))
  if (domain.length > 64) throw new Error('invalid seal domain')
  const body = Buffer.concat([Buffer.from([4, domain.length]), domain, plain])
  const ct = Buffer.alloc(body.length + 16)
  sodium.crypto_secretbox_easy(ct, body, nonce, key)
  return Buffer.concat([Buffer.from([4]), nonce, ct])
}

export function unseal(key, envelope, seq) {
  try {
    if (
      !Buffer.isBuffer(envelope) ||
      envelope.length < 43 ||
      envelope.length > 65536 ||
      envelope[0] !== 4
    )
      return null
    const plain = Buffer.alloc(envelope.length - 25 - 16)
    if (
      !sodium.crypto_secretbox_open_easy(
        plain,
        envelope.subarray(25),
        envelope.subarray(1, 25),
        key
      )
    )
      return null
    if (
      plain[0] !== 4 ||
      plain.length < 2 + plain[1] ||
      plain.subarray(2, 2 + plain[1]).toString() !== String(seq)
    )
      return null
    return plain.subarray(2 + plain[1])
  } catch {
    return null
  }
}

export function connKeys(boxKey, connSalt) {
  const c2e = Buffer.alloc(32)
  const e2c = Buffer.alloc(32)
  sodium.crypto_generichash(c2e, Buffer.concat([boxKey, connSalt, Buffer.from('c2e')]))
  sodium.crypto_generichash(e2c, Buffer.concat([boxKey, connSalt, Buffer.from('e2c')]))
  return { c2e, e2c }
}

// ---------- forward-secret session handshake (protocol v4) ----------
// Ephemeral X25519 DH, authenticated and encrypted under the PSK-derived boxKey, with a
// timestamp for replay protection. The ephemeral secrets are discarded after the handshake,
// so a later compromise of the PSK does NOT reveal past session keys (forward secrecy).
//   msg1: nonce(24) || secretbox(cePk(32) || tsMs(8) || version(1))
//   msg2: nonce(24) || secretbox(eePk(32) || cePk(32) || version(1))
//   keys = BLAKE2b-512("magnetgate-session-v4" || dh || cePk || eePk || boxKey)
export const HS_TS_SKEW_MS = 60_000
export const HS_MSG1_LEN = 24 + (32 + 8 + 1) + 16
export const HS_MSG2_LEN = 24 + (32 + 32 + 1) + 16

function ephemeral() {
  const sk = Buffer.alloc(sodium.crypto_scalarmult_SCALARBYTES)
  crypto.randomFillSync(sk)
  const pk = Buffer.alloc(sodium.crypto_scalarmult_BYTES)
  sodium.crypto_scalarmult_base(pk, sk)
  return { sk, pk }
}

function sessionKeys(dh, cePk, eePk, boxKey) {
  const okm = Buffer.alloc(64)
  sodium.crypto_generichash(
    okm,
    Buffer.concat([Buffer.from('magnetgate-session-v4'), dh, cePk, eePk, boxKey])
  )
  return { c2e: okm.subarray(0, 32), e2c: okm.subarray(32, 64) }
}

export function hsClientInit(boxKey) {
  const { sk: ceSk, pk: cePk } = ephemeral()
  const pl = Buffer.alloc(41)
  cePk.copy(pl, 0)
  pl.writeBigUInt64BE(BigInt(Date.now()), 32)
  pl[40] = 4
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
    if (pl[40] !== 4) return null
    const cePk = Buffer.from(pl.subarray(0, 32))
    const ts = Number(pl.readBigUInt64BE(32))
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > HS_TS_SKEW_MS) return null
    const { sk: eeSk, pk: eePk } = ephemeral()
    const dh = Buffer.alloc(sodium.crypto_scalarmult_BYTES)
    sodium.crypto_scalarmult(dh, eeSk, cePk) // throws on all-zero / low-order point
    const keys = sessionKeys(dh, cePk, eePk, boxKey)
    const n2 = crypto.randomBytes(24)
    const reply = Buffer.concat([eePk, cePk, Buffer.from([4])])
    const ct2 = Buffer.alloc(reply.length + 16)
    sodium.crypto_secretbox_easy(ct2, reply, n2, boxKey)
    return { msg2: Buffer.concat([n2, ct2]), keys, cePk, ts }
  } catch {
    return null
  }
}

// client side: verify the exit's reply and derive the same session keys.
// returns { keys } or null.
export function hsClientFinish(boxKey, msg2, ceSk, cePk) {
  try {
    if (!msg2 || msg2.length !== HS_MSG2_LEN) return null
    const nonce = msg2.subarray(0, 24)
    const ct = msg2.subarray(24)
    const reply = Buffer.alloc(ct.length - 16)
    if (
      !sodium.crypto_secretbox_open_easy(reply, ct, nonce, boxKey) ||
      reply[64] !== 4 ||
      !reply.subarray(32, 64).equals(cePk)
    )
      return null
    const eePk = reply.subarray(0, 32)
    const dh = Buffer.alloc(sodium.crypto_scalarmult_BYTES)
    sodium.crypto_scalarmult(dh, ceSk, eePk) // throws on all-zero / low-order point
    return { keys: sessionKeys(dh, Buffer.from(cePk), eePk, boxKey) }
  } catch {
    return null
  }
}

// ---------- multiplexed frames (protocol v4; legacy helper names retained) ----------

export const FRAME = {
  OPEN: 1,
  DATA: 2,
  CLOSE: 3,
  PING: 4,
  PONG: 5,
  UDP_ASSOC: 6,
  UDP_DATA: 7,
  UDP_CLOSE: 8,
  OPEN_OK: 9,
  END: 10
}

// frame: [u32 len][24B nonce][secretbox(version,u64 sequence,u8 type,u32 streamId,plain)]
// len counts everything after the length field. streamId 0 = session-level (ping/pong).
// The plaintext of DATA frames is padded inside the encryption ([padLen u16][pad][data]) so
// wire sizes do not exactly reveal the payload shape — lengths are quantized to buckets.
// padLen is a 2-byte big-endian prefix: buckets reach 4096, so pad can exceed 255 and must
// not be truncated into a single byte (that corrupted every DATA frame >= 512 B, incl. TLS
// ClientHello ~517 B — the cause of the "HTTPS through the tunnel fails" bug).
const PAD_HDR = 2
const PAD_BUCKETS = [64, 256, 512, 1024, 2048, 4096]

function padPlain(plain) {
  const bucket =
    PAD_BUCKETS.find((b) => plain.length + PAD_HDR <= b) ??
    Math.ceil((plain.length + PAD_HDR) / 4096) * 4096
  const padLen = Math.max(0, bucket - plain.length - PAD_HDR)
  const out = Buffer.alloc(PAD_HDR + padLen + plain.length)
  out.writeUInt16BE(padLen, 0)
  if (padLen > 0) crypto.randomBytes(padLen).copy(out, PAD_HDR)
  plain.copy(out, PAD_HDR + padLen)
  return out
}

export const MAX_FRAME_BYTES = 4 * 1024 * 1024
const validHeader = (type, id) =>
  Object.values(FRAME).includes(type) &&
  Number.isInteger(id) &&
  id >= 0 &&
  id <= 0xffffffff &&
  ([FRAME.PING, FRAME.PONG].includes(type) ? id === 0 : id > 0)

// Stateless primitive for fixtures; live connections must own one makeFrameEncoder per direction.
export function frame2(key, type, streamId, plain, sequence = 0n) {
  if (
    !validHeader(type, streamId) ||
    typeof sequence !== 'bigint' ||
    sequence < 0n ||
    sequence > 0xffffffffffffffffn ||
    !Buffer.isBuffer(plain)
  )
    throw new Error('invalid frame')
  if (plain.length > MAX_FRAME_BYTES - 8192) throw new Error('frame too large')
  const padded = type === FRAME.DATA ? padPlain(plain) : plain
  const body = Buffer.alloc(14 + padded.length)
  body[0] = 4
  body.writeBigUInt64BE(sequence, 1)
  body[9] = type
  body.writeUInt32BE(streamId, 10)
  padded.copy(body, 14)
  const nonce = crypto.randomBytes(24)
  const ct = Buffer.alloc(body.length + 16)
  sodium.crypto_secretbox_easy(ct, body, nonce, key)
  const head = Buffer.alloc(4)
  head.writeUInt32BE(24 + ct.length)
  return Buffer.concat([head, nonce, ct])
}

export function makeFrameEncoder(key) {
  let seq = 0n
  return (type, id, plain) => {
    const result = frame2(key, type, id, plain, seq)
    seq++
    return result
  }
}

export function makeCodecV2(key, onFrame, onKill) {
  let killed = false,
    seq = 0n,
    used = 0,
    needed = 4
  let buffer = Buffer.alloc(4)
  const kill = () => {
    if (killed) return
    killed = true
    buffer = Buffer.alloc(0)
    onKill()
  }
  return {
    kill,
    push(chunk) {
      if (killed) return
      let offset = 0
      while (!killed && offset < chunk.length) {
        const take = Math.min(needed - used, chunk.length - offset)
        chunk.copy(buffer, used, offset)
        used += take
        offset += take
        if (used < needed) continue
        if (needed === 4) {
          const len = buffer.readUInt32BE(0)
          if (len < 54 || len > MAX_FRAME_BYTES) return kill()
          needed = len
          used = 0
          buffer = Buffer.alloc(len)
          continue
        }
        const body = Buffer.alloc(needed - 40)
        if (
          !sodium.crypto_secretbox_open_easy(body, buffer.subarray(24), buffer.subarray(0, 24), key)
        )
          return kill()
        if (
          body[0] !== 4 ||
          body.readBigUInt64BE(1) !== seq ||
          !validHeader(body[9], body.readUInt32BE(10))
        )
          return kill()
        const type = body[9],
          id = body.readUInt32BE(10)
        let plain = body.subarray(14)
        if (type === FRAME.DATA) {
          if (plain.length < 2 || plain.readUInt16BE(0) > plain.length - 2) return kill()
          plain = plain.subarray(2 + plain.readUInt16BE(0))
        }
        seq++
        needed = 4
        used = 0
        buffer = Buffer.alloc(4)
        try {
          onFrame(type, id, plain)
        } catch {
          return kill()
        }
      }
    }
  }
}
