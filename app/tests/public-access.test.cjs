const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateProfile, requestProfile } = require('../public-access.cjs')
const path = require('node:path')
const { validateConfig } = require('../../src/config.cjs')
const { buildVpnConfig } = require('../vpn-config.cjs')
const { safeConfig } = require('../mac-helper.cjs')

function profile() {
  return { version: 1, expires: Math.floor(Date.now() / 1000) + 3600, endpoints: [{
    t: 'hy2', host: '192.0.2.1', port: 4443, pw: 'a'.repeat(64), obfs: 'b'.repeat(64),
    country: 'FI', sni: 'magnet.norma.so', ca: '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----'
  }] }
}
test('Windows and macOS public profiles build without PSK or native SOCKS fallback', () => {
  const root = path.resolve(__dirname, '../..')
  const endpoints = validateProfile(profile()).endpoints.map(d => ({ ...d, exitId: 'public' }))
  for (const vpnMode of ['full', 'split']) {
    const cfg = validateConfig({ connectionSource: 'public', exits: [], vpnMode })
    const common = { root, cfg, dp: endpoints, bypass: endpoints.map(d => d.host),
      clashPort: 19090, clashSecret: 'a'.repeat(32), clientPath: process.execPath }
    const windows = buildVpnConfig({ ...common, platform: 'win32' })
    const mac = safeConfig(root, { ...common, snapshot: { v: 4, exits: [
      { id: 'public', ts: Date.now(), dp: endpoints }
    ] } })
    for (const conf of [windows, mac]) {
      assert.equal(cfg.exits.length, 0)
      assert.equal(conf.outbounds.find(d => d.tag === 'proxy').type, 'hysteria2')
      assert.equal(conf.outbounds.some(d => d.type === 'socks'), false)
      assert.equal(conf.route.rules.some(r => r.network === 'udp' && r.action === 'reject'), false)
      const transport = conf.outbounds.find(d => d.type === 'hysteria2')
      assert.equal(transport.password, endpoints[0].pw)
      assert.equal(transport.tls.insecure, undefined)
      assert.ok(transport.tls.certificate)
    }
  }
})
test('личный профиль сохраняет проверку TLS и отклоняет локальные назначения', () => {
  assert.equal(validateProfile(profile()).endpoints[0].t, 'hy2')
  for (const host of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.1.1', 'localhost', 'file:///secret']) {
    const value = profile(); value.endpoints[0].host = host
    assert.throws(() => validateProfile(value))
  }
  for (const change of [{ t: 'socks' }, { port: 80 }, { ca: '' }, { pw: 'short' }, { sni: 'untrusted.test' }]) {
    const value = profile(); Object.assign(value.endpoints[0], change)
    assert.throws(() => validateProfile(value))
  }
  const stale = profile(); stale.expires = 0
  assert.throws(() => validateProfile(stale))
})
test('личный код отправляется только на доверенный HTTPS endpoint без перенаправлений', async () => {
  let called = false
  await requestProfile('MG1-' + 'c'.repeat(64), 'd'.repeat(64), async (url, options) => {
    called = true
    assert.equal(url, 'https://magnet.norma.so/api/profile')
    assert.equal(options.redirect, 'error')
    assert.equal(JSON.parse(options.body).device, 'd'.repeat(64))
    return new Response(JSON.stringify(profile()))
  })
  assert.ok(called)
  await assert.rejects(requestProfile('https://untrusted.test', 'd'.repeat(64)), /MG1/)
  await assert.rejects(requestProfile('MG1-' + 'c'.repeat(64), 'd'.repeat(64), async () => new Response('x'.repeat(25000))), /большой/)
})
