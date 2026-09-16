const net = require('node:net')
const DEFAULT_CONFIG = {
  localPort: 1080,
  singboxPort: 1081,
  probePort: 1082,
  bootstrap: ['router.bittorrent.com:6881', 'dht.transmissionbt.com:6881'],
  exits: [],
  rules: { direct: [], proxy: [] },
  vpnMode: 'full',
  directDomains: [],
  tunnelDomains: [],
  dataPlane: 'auto',
  transport: 'tcp',
  killSwitch: false,
  directProcesses: [],
  slots: [],
  country: ''
}
const domains = (list) => {
  if (!Array.isArray(list) || list.length > 10000) throw new Error('invalid domain list')
  return [
    ...new Set(
      list.map((value) => {
        if (typeof value !== 'string') throw new Error('invalid domain')
        const s = value.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
        if (!s || s.length > 253 || !/^[a-z0-9_.-]+$/.test(s)) throw new Error('invalid domain')
        return s
      })
    )
  ]
}
// Executable names whose traffic must bypass the tunnel. A torrent client behind one exit is a
// practical problem, not a theoretical one: the exit dials hundreds of thousands of dead peers a
// day, which risks the VPS provider suspending it and fills both logs. Accepts a bare name or a
// path (the basename is used).
const processes = (list) => {
  if (!Array.isArray(list) || list.length > 32) throw new Error('invalid process list')
  return [
    ...new Set(
      list.map((value) => {
        if (typeof value !== 'string') throw new Error('invalid process')
        const s = value.trim().toLowerCase().split(/[\\/]/).pop()
        if (!s || s.length > 64 || !/^[a-z0-9._-]+$/.test(s)) throw new Error('invalid process')
        return s
      })
    )
  ]
}
// Which exit country to prefer, as an ISO-3166 alpha-2 code; empty means "any". The desktop shows a
// list built from what the nodes advertise (see app/countries.cjs) — never an address.
const country = (value) => {
  const s = String(value ?? '')
    .trim()
    .toUpperCase()
  if (!s) return ''
  if (!/^[A-Z]{2}$/.test(s)) throw new Error('invalid country')
  return s
}
// Multi-node: which rendezvous slots to look for or publish on. 0 is the single-node slot; the
// upper bound must stay equal to MAX_SLOTS in src/common.mjs (tests/consistency.test.mjs checks it).
const MAX_SLOTS = 16
const slots = (list) => {
  if (!Array.isArray(list) || list.length > MAX_SLOTS) throw new Error('invalid slot list')
  return [
    ...new Set(
      list.map((value) => {
        // the config file is JSON, so a slot is a number here (env vars are handled in common.mjs)
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= MAX_SLOTS)
          throw new Error(`invalid slot: ${value}`)
        return value
      })
    )
  ].sort((a, b) => a - b)
}
function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('config must be an object')
  const cfg = { ...DEFAULT_CONFIG, ...value }
  for (const key of ['localPort', 'singboxPort', 'probePort'])
    if (!Number.isInteger(cfg[key]) || cfg[key] < 1024 || cfg[key] > 65535)
      throw new Error(`invalid ${key}`)
  if (new Set([cfg.localPort, cfg.singboxPort, cfg.probePort]).size !== 3)
    throw new Error('local ports must differ')
  if (
    !['full', 'split'].includes(cfg.vpnMode) ||
    !['auto', 'mgt'].includes(cfg.dataPlane) ||
    !['tcp', 'udp'].includes(cfg.transport)
  )
    throw new Error('invalid mode')
  if (typeof cfg.killSwitch !== 'boolean') throw new Error('invalid killSwitch')
  if (!Array.isArray(cfg.exits) || cfg.exits.length > 16) throw new Error('invalid exits')
  cfg.exits = cfg.exits.map((exit, i) => {
    if (!exit || typeof exit.psk !== 'string' || !exit.psk || exit.psk.length > 512)
      throw new Error(`invalid PSK for exit ${i + 1}`)
    if (exit.salt && !/^[a-f0-9]{40}$/i.test(exit.salt)) throw new Error('invalid salt')
    return {
      name: String(exit.name || `exit${i + 1}`).slice(0, 80),
      psk: exit.psk,
      ...(exit.salt ? { salt: exit.salt } : {})
    }
  })
  if (
    !Array.isArray(cfg.bootstrap) ||
    cfg.bootstrap.length > 64 ||
    cfg.bootstrap.some(
      (s) =>
        typeof s !== 'string' ||
        !/^([a-z0-9.-]+):([0-9]{1,5})$/i.test(s) ||
        Number(s.split(':')[1]) < 1 ||
        Number(s.split(':')[1]) > 65535
    )
  )
    throw new Error('invalid bootstrap')
  cfg.directDomains = domains(cfg.directDomains)
  cfg.tunnelDomains = domains(cfg.tunnelDomains)
  cfg.directProcesses = processes(cfg.directProcesses)
  cfg.slots = slots(cfg.slots)
  cfg.country = country(cfg.country)
  cfg.rules = { direct: domains(cfg.rules?.direct || []), proxy: domains(cfg.rules?.proxy || []) }
  return cfg
}
function freshEndpoints(snapshot, now = Date.now()) {
  // 720000 must stay equal to OFFER_TTL_MS in client.js and comfortably above the exit's 60 s
  // republish interval; tests/consistency.test.mjs fails if the three ever disagree.
  if (snapshot?.v !== 4 || !Array.isArray(snapshot.exits)) return []
  return snapshot.exits
    .filter(
      (e) =>
        Number.isFinite(e.ts) && e.ts <= now + 60000 && now - e.ts < 720000 && Array.isArray(e.dp)
    )
    .flatMap((e) =>
      e.dp
        .filter(
          (d) =>
            d &&
            typeof d.host === 'string' &&
            d.host.length <= 253 &&
            Number.isInteger(d.port) &&
            d.port > 0 &&
            d.port <= 65535
        )
        .map((d) => ({
          ...d,
          exitId: String(e.id),
          exitName: e.name,
          node: e.node,
          country: e.country
        }))
    )
}
module.exports = { DEFAULT_CONFIG, validateConfig, freshEndpoints }
