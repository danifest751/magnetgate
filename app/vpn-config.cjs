const path = require('node:path')
const fs = require('node:fs')

function buildVpnConfig({
  root,
  ruleSetRoot = root,
  cfg,
  dp,
  bypass,
  clashPort,
  clashSecret,
  clientPath,
  tunnelAlias = 'magnetgate',
  platform = process.platform
}) {
  if (platform !== 'darwin' && !/^[a-z0-9-]{1,40}$/.test(tunnelAlias))
    throw new Error('Invalid owned TUN alias')
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
  const peer = dp.find(d => d.t === 'peer' && d.protocol === 1)
  if (peer) outbounds.push({ type: 'socks', tag: 'peer', server: '127.0.0.1',
    server_port: cfg.localPort, version: '5', username: peer.username, password: peer.password })
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
    { process_path: [clientPath, ...(peer ? [path.join(root, 'tools', 'peer', platform === 'win32' ? 'peer-node.exe' : 'peer-node')] : [])], action: 'route', outbound: 'direct' }
  ]
  // keep named applications out of the tunnel (e.g. qbittorrent.exe) — see src/config.cjs
  if (cfg.directProcesses?.length)
    rules.push({ process_name: cfg.directProcesses, action: 'route', outbound: 'direct' })
  if (bypass.length)
    rules.push({ ip_cidr: bypass.map((ip) => `${ip}/32`), action: 'route', outbound: 'direct' })
  // macOS browsers may retain AAAA answers. Route those addresses through the
  // proxy too, instead of unconditionally breaking dual-stack Google services.
  if (platform !== 'darwin') rules.push({ ip_version: 6, action: 'reject' })
  const ruleSets = []
  const addSet = (tag, file, outbound, mode) => {
    const p = path.join(ruleSetRoot, 'tools', 'sing-box', file)
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
  if (live) {
    rules.push({ clash_mode: 'Rule', action: 'route', outbound: 'direct' })
    // sing-box derives available modes from rules and the initial mode. Keep
    // Global available even when starting in Split with no direct exceptions.
    rules.push({ clash_mode: 'Global', action: 'route', outbound: 'proxy' })
  }
  const peerRules = peer ? rules.flatMap(rule => {
    if (rule.outbound !== 'proxy' || rule.inbound) return [rule]
    const { outbound, ...match } = rule
    return [{ ...match, network: 'udp', action: 'reject' }, rule]
  }) : rules
  if (peer && !live && cfg.vpnMode === 'full') peerRules.push({ network: 'udp', action: 'reject' })
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
      strategy: platform === 'darwin' ? 'prefer_ipv4' : 'ipv4_only'
    },
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        ...(platform === 'darwin' ? {} : { interface_name: tunnelAlias }),
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        mtu: 1400,
        auto_route: true,
        strict_route: true,
        ...(platform === 'darwin' ? { dns_address: ['172.19.0.2'] } : {}),
        stack: 'gvisor'
      },
      { type: 'socks', tag: 'health-in', listen: '127.0.0.1', listen_port: cfg.probePort }
    ],
    outbounds,
    route: {
      rules: peerRules,
      rule_set: ruleSets,
      final: !live && cfg.vpnMode === 'split' ? 'direct' : 'proxy',
      auto_detect_interface: true,
      default_domain_resolver: 'proxy-dns'
    }
  }
}
module.exports = { buildVpnConfig }
