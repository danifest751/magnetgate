const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { validateConfig, freshEndpoints } = require('../../src/config.cjs')
const { buildVpnConfig } = require('../vpn-config.cjs')
const root = path.resolve(__dirname, '../..')
const native = { t: 'mgt', host: '203.0.113.1', port: 49001, protocol: 4, exitId: 'a' }
function build(cfg, dp = [native]) {
  return buildVpnConfig({
    root,
    cfg: validateConfig(cfg),
    dp,
    bypass: [],
    clashPort: 19090,
    clashSecret: 'fixture',
    logOut: 'fixture.log',
    clientPath: process.execPath
  })
}
test('config rejects invalid ports, conflicting ports and malformed PSKs', () => {
  for (const value of [
    { localPort: 0 },
    { probePort: 1080 },
    { exits: [{ psk: '' }] },
    { bootstrap: ['host:65536'] },
    { killSwitch: 'yes' }
  ])
    assert.throws(() => validateConfig(value))
})
test('endpoint snapshots expire and keep exit identity', () => {
  const now = Date.now()
  const snapshot = {
    v: 4,
    exits: [
      { id: 'a', ts: now, dp: [native] },
      { id: 'old', ts: now - 720001, dp: [native] },
      { id: 'future', ts: now + 60001, dp: [native] }
    ]
  }
  assert.deepEqual(
    freshEndpoints(snapshot, now).map((d) => d.exitId),
    ['a']
  )
})
test('strict full mode has no domain or private direct exceptions', () => {
  const cfg = build({ killSwitch: true, vpnMode: 'full', directDomains: ['example.test'] })
  assert.equal(cfg.route.final, 'proxy')
  assert.equal(
    cfg.route.rules.some((r) => r.ip_is_private || r.domain_suffix),
    false
  )
  assert.equal(cfg.route.rules[0].outbound, 'proxy')
  assert.equal(cfg.outbounds.find((o) => o.tag === 'proxy').type, 'socks')
})

test('bundled lists cannot add hidden direct exceptions to Full', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'magnetgate-rule-policy-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
  fs.mkdirSync(path.join(fixtureRoot, 'src'))
  fs.mkdirSync(path.join(fixtureRoot, 'tools/sing-box'), { recursive: true })
  fs.copyFileSync(
    path.join(root, 'src/transport-config.cjs'),
    path.join(fixtureRoot, 'src/transport-config.cjs')
  )
  // The builder must ignore this file even when a previous install left it behind.
  fs.writeFileSync(
    path.join(fixtureRoot, 'tools/sing-box/itdoginfo-inside-russia.srs'),
    'fixture'
  )
  for (const vpnMode of ['full', 'split']) {
    const cfg = buildVpnConfig({
      root: fixtureRoot,
      cfg: validateConfig({ vpnMode, directDomains: ['chosen.test'] }),
      dp: [native],
      bypass: [],
      clashPort: 19090,
      clashSecret: 'fixture',
      clientPath: 'fixture.exe'
    })
    const directRules = cfg.route.rules.filter((r) => r.outbound === 'direct')
    assert.equal(
      directRules.some((r) => r.rule_set),
      false
    )
    assert.deepEqual(
      directRules.filter((r) => r.domain_suffix).map((r) => r.domain_suffix),
      [['chosen.test']]
    )
    assert.equal(
      cfg.route.rule_set.some((r) => r.tag === 'ru-inside'),
      false
    )
  }
})
test('split mode retains domain exceptions and native fallback across multiple exits', () => {
  const reality = {
    t: 'reality',
    host: '203.0.113.2',
    port: 443,
    uuid: '11111111-1111-4111-8111-111111111111',
    pbk: 'fixture',
    sid: '0123456789abcdef',
    sni: 'example.test',
    exitId: 'b'
  }
  const cfg = build({ vpnMode: 'split', tunnelDomains: ['example.test'] }, [native, reality])
  assert.equal(cfg.route.final, 'proxy')
  assert.equal(cfg.experimental.clash_api.default_mode, 'Rule')
  assert.deepEqual(cfg.route.rules.at(-1), {
    clash_mode: 'Rule',
    action: 'route',
    outbound: 'direct'
  })
  assert.equal(cfg.outbounds.find((o) => o.tag === 'proxy').type, 'urltest')
  assert.equal(
    cfg.outbounds.some((o) => o.tag === 'native'),
    true
  )
  assert.equal(
    cfg.route.rules.some(
      (r) => r.domain_suffix?.includes('example.test') && r.outbound === 'proxy'
    ),
    true
  )
})

test('ordinary Full and Split load identical policies with different initial modes', () => {
  const full = build({
    vpnMode: 'full',
    directDomains: ['direct.test'],
    tunnelDomains: ['tunnel.test']
  })
  const split = build({
    vpnMode: 'split',
    directDomains: ['direct.test'],
    tunnelDomains: ['tunnel.test']
  })
  assert.equal(full.experimental.clash_api.default_mode, 'Global')
  split.experimental.clash_api.default_mode = 'Global'
  assert.deepEqual(split, full)
  assert.equal(
    full.route.rules.find((r) => r.domain_suffix?.includes('direct.test')).clash_mode,
    'Global'
  )
  assert.equal(
    full.route.rules.find((r) => r.domain_suffix?.includes('tunnel.test')).clash_mode,
    'Rule'
  )
})
test('unpinned hysteria2 offer is rejected, never silently made insecure', () => {
  assert.throws(
    () => build({}, [{ t: 'hy2', host: 'example.test', port: 443, pw: 'fixture' }]),
    /no supported endpoint/
  )
})

test('owned TUN alias is configurable without reusing the legacy adapter name', () => {
  const cfg = buildVpnConfig({
    root,
    cfg: validateConfig({}),
    dp: [native],
    bypass: [],
    clashPort: 19090,
    clashSecret: 'fixture',
    clientPath: process.execPath,
    tunnelAlias: 'magnetgate-abcdef123456'
  })
  assert.equal(cfg.inbounds[0].interface_name, 'magnetgate-abcdef123456')
  assert.equal(cfg.log.output, undefined)
})

test('named processes are validated and routed outside the tunnel', () => {
  // accepts a bare name or a full path, lowercases, dedupes
  const cfg = validateConfig({
    directProcesses: [
      ' C:\\Program Files\\qBittorrent\\qBittorrent.exe ',
      'qbittorrent.exe',
      'Steam.exe'
    ]
  })
  assert.deepEqual(cfg.directProcesses, ['qbittorrent.exe', 'steam.exe'])

  for (const bad of [
    { directProcesses: 'qbittorrent.exe' },
    { directProcesses: ['ok.exe', 'bad name'] },
    { directProcesses: [1] },
    { directProcesses: Array(33).fill('a.exe') }
  ])
    assert.throws(() => validateConfig(bad), /invalid process/)

  const rule = build({ vpnMode: 'full', directProcesses: ['qbittorrent.exe'] }).route.rules.find(
    (r) => r.process_name
  )
  assert.deepEqual(rule, {
    process_name: ['qbittorrent.exe'],
    action: 'route',
    outbound: 'direct'
  })
  // no rule is emitted when the list is empty, so nothing changes by default
  assert.equal(
    build({ vpnMode: 'full' }).route.rules.some((r) => r.process_name),
    false
  )
})
