const path = require('node:path')
const fs = require('node:fs')

function buildVpnConfig({
  root,
  cfg,
  dp,
  bypass,
  clashPort,
  clashSecret,
  clientPath,
  tunnelAlias = 'magnetgate'
}) {
  if (!/^[a-z0-9-]{1,40}$/.test(tunnelAlias)) throw new Error('Invalid owned TUN alias')
  const { transportOutbound } = require(path.join(root, 'src', 'transport-config.cjs'))
  const outbounds = []
  for (const [i, d] of dp.entries()) {
    if (!['reality', 'hy2'].includes(d.t)) continue
    try {
      outbounds.push({ tag: `exit-${d.exitId}-${d.t}-${i}`, ...transportOutbound(d) })
    } catch {}
  }
  if (dp.some((d) => d.t === 'mgt' && d.protocol === 4))
    outbounds.push({
      type: 'socks',
      tag: 'native',
      server: '127.0.0.1',
      server_port: cfg.localPort,
      version: '5'
    })
  if (!outbounds.length) throw new Error('no supported endpoint')
  const tags = outbounds.map((d) => d.tag)
  if (tags.length === 1) outbounds[0].tag = 'proxy'
  else
    outbounds.push({
      tag: 'proxy',
      type: 'urltest',
      outbounds: tags,
      url: 'https://www.gstatic.com/generate_204',
      interval: '30s',
      interrupt_exist_connections: false
    })
  outbounds.push({ type: 'direct', tag: 'direct' })
  const strict = cfg.vpnMode === 'full' && cfg.killSwitch
  const rules = [
    { inbound: ['health-in'], action: 'route', outbound: 'proxy' },
    { action: 'sniff' },
    { protocol: 'dns', action: 'hijack-dns' },
    { process_path: [clientPath], action: 'route', outbound: 'direct' }
  ]
  if (bypass.length)
    rules.push({ ip_cidr: bypass.map((ip) => `${ip}/32`), action: 'route', outbound: 'direct' })
  rules.push({ ip_version: 6, action: 'reject' })
  const ruleSets = []
  const addSet = (tag, file, outbound, mode) => {
    const p = path.join(root, 'tools', 'sing-box', file)
    if (fs.existsSync(p)) {
      ruleSets.push({ type: 'local', tag, format: 'binary', path: p })
      rules.push({
        rule_set: [tag],
        ...(mode ? { clash_mode: mode } : {}),
        action: 'route',
        outbound
      })
    }
  }
  // With the guard disabled both policies coexist; only the Clash mode changes at runtime.
  const live = !cfg.killSwitch
  if (live || cfg.vpnMode === 'split') {
    const mode = live ? { clash_mode: 'Rule' } : {}
    addSet('blocked-domains', 'refilter-domains.srs', 'proxy', live ? 'Rule' : null)
    addSet('blocked-ip', 'refilter-ip.srs', 'proxy', live ? 'Rule' : null)
    addSet('user', 'tunnel-userlist.srs', 'proxy', live ? 'Rule' : null)
    if (cfg.tunnelDomains.length)
      rules.push({ ...mode, domain_suffix: cfg.tunnelDomains, action: 'route', outbound: 'proxy' })
  }
  if (live || (!strict && cfg.vpnMode === 'full')) {
    // Full has only explicit user exceptions. A bundled domain list must
    // never silently bypass the tunnel, regardless of its file name.
    if (cfg.directDomains.length)
      rules.push({
        ...(live ? { clash_mode: 'Global' } : {}),
        domain_suffix: cfg.directDomains,
        action: 'route',
        outbound: 'direct'
      })
  }
  if (!strict) rules.push({ ip_is_private: true, action: 'route', outbound: 'direct' })
  if (live) rules.push({ clash_mode: 'Rule', action: 'route', outbound: 'direct' })
  return {
    log: { level: 'warn', timestamp: true },
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${clashPort}`,
        secret: clashSecret,
        default_mode: cfg.vpnMode === 'split' ? 'Rule' : 'Global'
      }
    },
    dns: {
      servers: [{ tag: 'proxy-dns', type: 'https', server: '1.1.1.1', detour: 'proxy' }],
      strategy: 'ipv4_only'
    },
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        interface_name: tunnelAlias,
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        mtu: 1400,
        auto_route: true,
        strict_route: true,
        stack: 'gvisor'
      },
      { type: 'socks', tag: 'health-in', listen: '127.0.0.1', listen_port: cfg.probePort }
    ],
    outbounds,
    route: {
      rules,
      rule_set: ruleSets,
      final: !live && cfg.vpnMode === 'split' ? 'direct' : 'proxy',
      auto_detect_interface: true,
      default_domain_resolver: 'proxy-dns'
    }
  }
}
module.exports = { buildVpnConfig }
