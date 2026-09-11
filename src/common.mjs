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

export function frame(key, plain) {
  const nonce = crypto.randomBytes(24)
  const ct = Buffer.alloc(plain.length + 16)
  sodium.crypto_secretbox_easy(ct, plain, nonce, key)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(nonce.length + ct.length, 0)
  return Buffer.concat([len, nonce, ct])
}

export function makeCodec(key, onPlain, onKill) {
  let buf = Buffer.alloc(0)
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0)
        if (len < 40 || len > 4 * 1024 * 1024) return onKill()
        if (buf.length < 4 + len) return
        const nonce = buf.subarray(4, 4 + 24)
        const ct = buf.subarray(4 + 24, 4 + len)
        const plain = Buffer.alloc(len - 24 - 16)
        if (!sodium.crypto_secretbox_open_easy(plain, ct, nonce, key)) return onKill()
        buf = buf.subarray(4 + len)
        onPlain(plain)
      }
    },
  }
}
