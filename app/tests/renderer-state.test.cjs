const { test } = require('node:test')
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
