import net from 'node:net'
import dns from 'node:dns'

export const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535

export function ipBytes(host) {
  if (net.isIPv4(host)) return Buffer.from(host.split('.').map(Number))
  if (!net.isIPv6(host)) throw new Error('invalid IP address')
  let value = host.split('%')[0]
  if (value.includes('.')) {
    const at = value.lastIndexOf(':')
    const v4 = ipBytes(value.slice(at + 1))
    value =
      value.slice(0, at + 1) +
      v4.readUInt16BE(0).toString(16) +
      ':' +
      v4.readUInt16BE(2).toString(16)
  }
  const [left, right] = value.split('::')
  const a = left ? left.split(':') : []
  const b = right ? right.split(':') : []
  const groups = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b]
  const out = Buffer.alloc(16)
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2))
  return out
}

export function isBlockedIp(host) {
  let bytes
  try {
    bytes = ipBytes(host)
  } catch {
    return true
  }
  if (bytes.length === 16) {
    if (bytes.subarray(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255)
      bytes = bytes.subarray(12)
    else return (bytes[0] & 0xe0) !== 0x20 // only global-unicast IPv6; no ULA/link-local/multicast/loopback
  }
  const [a, b] = bytes
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

export function guardedLookup(allowPrivate = false, lookup = dns.lookup) {
  return (host, options, cb) => {
    lookup(host, options, (err, address, family) => {
      if (err) return cb(err)
      const all = !!options?.all
      const list = all ? address : [{ address, family }]
      if (
        !Array.isArray(list) ||
        !list.length ||
        list.some((a) => !net.isIP(a.address) || (!allowPrivate && isBlockedIp(a.address)))
      )
        return cb(new Error('blocked target'))
      if (all) cb(null, list)
      else cb(null, address, family)
    })
  }
}

export async function resolveTarget(host, allowPrivate = false, lookup = dns.promises.lookup) {
  const list = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await lookup(host, { all: true })
  if (
    !list.length ||
    list.some((a) => !net.isIP(a.address) || (!allowPrivate && isBlockedIp(a.address)))
  )
    throw new Error('blocked target')
  return list.find((a) => a.family === 4) || list[0]
}

export function encodeAddress(host, port, data = Buffer.alloc(0)) {
  if (!validPort(port)) throw new Error('invalid port')
  const family = net.isIP(host)
  let address
  if (family) address = Buffer.concat([Buffer.from([family === 4 ? 1 : 4]), ipBytes(host)])
  else {
    const name = Buffer.from(host, 'utf8')
    if (!name.length || name.length > 255 || /[\s\x00]/.test(host))
      throw new Error('invalid hostname')
    address = Buffer.concat([Buffer.from([3, name.length]), name])
  }
  const p = Buffer.alloc(2)
  p.writeUInt16BE(port)
  return Buffer.concat([address, p, data])
}

export function decodeAddress(buf) {
  let host, end
  if (buf[0] === 1) {
    end = 5
    if (buf.length < end + 2) return null
    host = [...buf.subarray(1, end)].join('.')
  } else if (buf[0] === 4) {
    end = 17
    if (buf.length < end + 2) return null
    host = Array.from({ length: 8 }, (_, i) => buf.readUInt16BE(1 + i * 2).toString(16)).join(':')
  } else if (buf[0] === 3) {
    if (buf.length < 2 || !buf[1]) return null
    end = 2 + buf[1]
    if (buf.length < end + 2) return null
    host = buf.toString('utf8', 2, end)
    if (/[\s\x00]/.test(host)) return null
  } else return null
  return { host, port: buf.readUInt16BE(end), data: buf.subarray(end + 2), length: end + 2 }
}
