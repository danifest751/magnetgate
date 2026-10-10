const { test } = require('node:test')
const assert = require('node:assert/strict')
const { requestPayment, validatePayment, validateProfile } = require('../public-access.cjs')
const I18n = require('../renderer/i18n.js')
const { formatRqt, paymentView } = require('../renderer/state.js')

const ADDRESS = 'trq1q64k873ph3ngupg63e70cv5e276nk43ry23742j8clmm6m5wsn99qnqa0ak'
function payment(change = {}) {
  return { currency: 'RQT', network: 'test', atomsPerRqt: 1e8, priceAtomsPerDay: 10_000_000,
    discounts: [[7, 10], [30, 20], [90, 30]], confirmations: 6, address: ADDRESS, tier: 'free',
    paidUntil: 0, expires: 1_900_000_000, balanceAtoms: 0, credits: [], ...change }
}

test('payment details are checked before they are shown', () => {
  assert.equal(validatePayment(payment()).address, ADDRESS)
  for (const change of [{ address: 'bc1qxyz' }, { address: ADDRESS.toUpperCase() }, { tier: 'gold' },
    { priceAtomsPerDay: 0 }, { discounts: [[7, 100]] }, { balanceAtoms: -1 }, { credits: [{ txid: 'x' }] }])
    assert.throws(() => validatePayment(payment(change)))
})

test('the code goes only to the trusted service; no payments there is not an error', async () => {
  const code = 'MG1-' + 'c'.repeat(64)
  const got = await requestPayment(code, async (url, options) => {
    assert.equal(url, 'https://magnet.norma.so/api/payment')
    assert.equal(options.redirect, 'error')
    assert.deepEqual(JSON.parse(options.body), { code })
    return new Response(JSON.stringify(payment()))
  })
  assert.equal(got.tier, 'free')
  const off = await requestPayment(code, async () => new Response(JSON.stringify({ error: 'off' }), { status: 404 }))
  assert.equal(off, null)
  await assert.rejects(requestPayment(code, async () => new Response(JSON.stringify({ error: 'busy' }), { status: 503 })), /busy/)
  await assert.rejects(requestPayment('nope', async () => assert.fail('sent')))
})

test('the full tier listener port is accepted in a profile', () => {
  const endpoint = { t: 'hy2', host: '192.0.2.1', port: 8443, pw: 'a'.repeat(64), obfs: 'b'.repeat(64), country: 'FI',
    sni: 'magnet.norma.so', ca: '-----BEGIN CERTIFICATE-----\nx' }
  const profile = { version: 1, expires: Math.floor(Date.now() / 1000) + 60, tier: 'full', endpoints: [endpoint] }
  assert.equal(validateProfile(profile).tier, 'full')
  assert.throws(() => validateProfile({ ...profile, tier: 'gold' }))
})

test('prices with discounts, tier and balance in both languages', () => {
  assert.equal(formatRqt(150_000_000), '1.5')
  assert.equal(formatRqt(10_000_000), '0.1')
  assert.equal(formatRqt(200_000_000), '2')
  assert.equal(paymentView(null), null)
  I18n.setLanguage('en')
  const free = paymentView(payment())
  assert.equal(free.status, 'Free tier')
  assert.deepEqual(free.prices, ['1 d — 0.1 RQT', '7 d — 0.63 RQT (10% off)', '30 d — 2.4 RQT (20% off)', '90 d — 6.3 RQT (30% off)'])
  assert.equal(free.balance, '')
  const full = paymentView(payment({ tier: 'full', paidUntil: 1_800_000_000, balanceAtoms: 7_000_000 }), 1_700_000_000_000)
  assert.ok(full.full && full.status.startsWith('Full access until'))
  assert.equal(full.balance, 'Balance: 0.07 RQT')
  I18n.setLanguage('ru')
  assert.equal(paymentView(payment()).prices[1], '7 дн. — 0.63 RQT (скидка 10%)')
  I18n.setLanguage('en')
})
