// Shared by Electron and the standalone client. Never silently disable TLS verification.
function transportOutbound(dp) {
  if (
    !dp ||
    typeof dp.host !== 'string' ||
    !dp.host ||
    !Number.isInteger(dp.port) ||
    dp.port < 1 ||
    dp.port > 65535
  )
    throw new Error('invalid endpoint')
  const requireText = (key) => {
    if (typeof dp[key] !== 'string' || !dp[key]) throw new Error(`missing ${key}`)
    return dp[key]
  }
  if (dp.t === 'reality')
    return {
      type: 'vless',
      server: dp.host,
      server_port: dp.port,
      uuid: requireText('uuid'),
      flow: 'xtls-rprx-vision',
      tls: {
        enabled: true,
        server_name: requireText('sni'),
        utls: { enabled: true, fingerprint: dp.fp || 'chrome' },
        reality: { enabled: true, public_key: requireText('pbk'), short_id: requireText('sid') }
      }
    }
  if (dp.t === 'hy2') {
    const certs = Array.isArray(dp.ca) ? dp.ca : [dp.ca]
    if (
      !certs.length ||
      certs.some(
        (cert) => typeof cert !== 'string' || !cert.includes('-----BEGIN CERTIFICATE-----')
      )
    )
      throw new Error('hy2 requires pinned certificate')
    return {
      type: 'hysteria2',
      server: dp.host,
      server_port: dp.port,
      password: requireText('pw'),
      obfs: { type: 'salamander', password: requireText('obfs') },
      tls: { enabled: true, alpn: ['h3'], server_name: requireText('sni'), certificate: certs }
    }
  }
  throw new Error('unsupported transport')
}
module.exports = { transportOutbound }
