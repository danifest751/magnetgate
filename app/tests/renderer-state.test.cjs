const { test } = require('node:test')
// these tests check the Russian strings; the English default is covered by i18n.test.cjs
require('../renderer/i18n.js').setLanguage('ru')
const assert = require('node:assert/strict')
const { connectionView, needsDisconnect } = require('../renderer/state.js')
const cfg = { exits: [{ name: 'fixture' }], vpnMode: 'full' }
test('firewall recovery takes precedence over missing exits and another tunnel', () => {
  const state = {
    vpnOn: false,
    guardRecoveryRequired: true,
    otherTunnel: 'WireGuard',
    phase: 'blocked'
  }
  const view = connectionView({ exits: [] }, state)
  assert.equal(view.button, 'Восстановить интернет')
  assert.equal(view.empty, false)
  assert.equal(needsDisconnect(state), true)
})
test('blocked connection can be retried after the user disables the other VPN', () => {
  assert.equal(
    connectionView(cfg, { vpnOn: false, phase: 'blocked', otherTunnel: 'WireGuard' }).button,
    'Повторить'
  )
})
test('a selected but unapplied mode cannot appear connected', () => {
  const view = connectionView(
    { ...cfg, vpnMode: 'split' },
    { vpnOn: true, vpnHealthy: true, engineReady: true, activeMode: 'full', phase: 'connected' }
  )
  assert.equal(view.connected, false)
  assert.equal(view.pending, true)
  assert.equal(view.button, 'Отменить')
})
test('stale health cannot show Connected after engine readiness is lost', () => {
  assert.equal(
    connectionView(cfg, {
      vpnOn: true,
      vpnHealthy: true,
      engineReady: false,
      activeMode: 'full',
      phase: 'connected'
    }).connected,
    false
  )
})
test('configured protection is not reported as applied protection', () => {
  const view = connectionView(
    { ...cfg, killSwitch: true },
    {
      vpnOn: true,
      vpnHealthy: true,
      engineReady: true,
      activeMode: 'full',
      phase: 'connected',
      trafficProtected: false
    }
  )
  assert.equal(view.detail.includes('исключения отключены'), false)
})

test('country selector: options show the code and node count, never an address', () => {
  const { countryOptions, countryMessage } = require('../renderer/state.js')
  assert.deepEqual(countryOptions([]), [['', 'Авто']])
  assert.deepEqual(countryOptions(undefined), [['', 'Авто']])
  assert.deepEqual(countryOptions([{ cc: 'FI', nodes: 1 }, { cc: 'NL', nodes: 2 }]), [
    ['', 'Авто'],
    ['FI', 'Финляндия · 1 доступно'],
    ['NL', 'Нидерланды · 2 доступно']
  ])
  // malformed entries are dropped rather than rendered as a broken option
  assert.deepEqual(countryOptions([{ cc: 'x' }, { cc: 'DEU' }, null, { cc: 'de', nodes: 1 }]), [
    ['', 'Авто'],
    ['DE', 'Германия · 1 доступно']
  ])
  assert.equal(
    countryOptions([{ cc: 'FI', nodes: 1 }]).some(([, label]) => /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/.test(label)),
    false,
    'an address must never appear in the list'
  )
})

test('country search keeps the selected unavailable country and matches names or codes', () => {
  const { countryOptions } = require('../renderer/state.js')
  const countries = [{ cc: 'DE', nodes: 2 }, { cc: 'NL', nodes: 1 }]
  assert.deepEqual(countryOptions(countries, '', 'Герм'), [['', 'Авто'], ['DE', 'Германия · 2 доступно']])
  assert.deepEqual(countryOptions(countries, '', 'nl'), [['', 'Авто'], ['NL', 'Нидерланды · 1 доступно']])
  assert.deepEqual(countryOptions(countries, 'FI', 'nl').at(-1), ['FI', 'Финляндия · сейчас недоступна'])
})

test('country selector: the caption explains the choice and the fallback', () => {
  const { countryMessage } = require('../renderer/state.js')
  assert.equal(countryMessage('', false), 'Любая страна с живой нодой')
  assert.equal(countryMessage('FI', false), 'Выход через FI')
  assert.equal(countryMessage('DE', true), 'В DE нет живых нод — используется любая')
  assert.equal(countryMessage(undefined, false), 'Любая страна с живой нодой')
})

test('diagnostics rows show node, country, planes and paused ones - never an address', () => {
  const { nodeRows } = require('../renderer/state.js')
  assert.deepEqual(nodeRows([{ key: 'nl-1', country: 'NL', planes: ['reality', 'hy2', 'mgt'], cooling: [] }]), [
    { label: 'nl-1 · NL', value: 'reality, hy2, mgt', cooling: false }
  ])
  assert.deepEqual(
    nodeRows([{ key: 'fi-1', country: 'FI', planes: ['reality', 'mgt'], cooling: ['hy2'] }]),
    [{ label: 'fi-1 · FI', value: 'reality, mgt · пауза: hy2', cooling: true }]
  )
  assert.deepEqual(nodeRows([]), [])
  assert.deepEqual(nodeRows(undefined), [])
  const rendered = JSON.stringify(nodeRows([{ key: 'x', country: 'DE', planes: ['reality'], cooling: [] }]))
  assert.equal(/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/.test(rendered), false, 'no address may appear')
})
