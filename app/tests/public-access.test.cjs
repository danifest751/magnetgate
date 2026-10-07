const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateProfile, requestProfile } = require('../public-access.cjs')

function profile() {
  return { version: 1, expires: Math.floor(Date.now() / 1000) + 3600, endpoints: [{
    t: 'hy2', host: '192.0.2.1', port: 4443, pw: 'a'.repeat(64), obfs: 'b'.repeat(64),
    country: 'FI', sni: 'magnet.norma.so', ca: '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----'
  }] }
}
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
