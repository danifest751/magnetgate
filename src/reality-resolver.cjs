// Reality needs an ordinary TLS destination even for authenticated clients. Resolve it independently
// of the host's UDP stub resolver, and never try IPv6 on exits which only advertise IPv4.
function withRealityResolver(config) {
  const tag = 'reality-resolver'
  config.dns ??= {}
  config.dns.servers ??= []
  if (!config.dns.servers.some((server) => server.tag === tag)) {
    config.dns.servers.push({ type: 'https', tag, server: '1.1.1.1' })
  }
  for (const inbound of config.inbounds ?? []) {
    if (!inbound.tls?.reality?.enabled) continue
    const handshake = inbound.tls.reality.handshake
    if (!handshake) throw new Error('Reality handshake destination missing')
    handshake.domain_resolver = { server: tag, strategy: 'ipv4_only', timeout: '4s' }
    handshake.connect_timeout = '5s'
    inbound.tls.handshake_timeout = '8s'
  }
  return config
}

module.exports = { withRealityResolver }
