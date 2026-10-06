const path = require('node:path')

function platformConfig(cfg, platform) {
  return platform === 'darwin' ? { ...cfg, killSwitch: false } : cfg
}

function macTunnel(routes) {
  // netstat's interface column is named; an optional expiry column follows it.
  const rows = String(routes).trim().split(/\r?\n/)
  const header = rows.findIndex(row => /^Destination\s+Gateway\s+Flags\s+Netif/.test(row.trim()))
  if (header < 0) throw new Error('Unrecognized macOS routing table')
  for (const row of rows.slice(header + 1)) {
    const [destination, , , iface] = row.trim().split(/\s+/)
    const prefix = (destination || '').replace(/(?:\.0)+(?=\/)/, '')
    if (['default', '0/1', '128/1'].includes(prefix) &&
        /^(utun\d+|ipsec\d+|ppp\d+)$/.test(iface || '')) return iface
  }
  return null
}

function platformPaths(root, platform) {
  return {
    engine: path.join(root, 'tools', 'sing-box', platform === 'win32' ? 'sing-box.exe' : 'sing-box'),
    curl: platform === 'win32' ? 'curl.exe' : '/usr/bin/curl',
    killSwitchSupported: platform === 'win32'
  }
}

module.exports = { platformConfig, platformPaths, macTunnel }
