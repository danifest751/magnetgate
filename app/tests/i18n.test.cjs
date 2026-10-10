const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const I18n = require('../renderer/i18n.js')
const { connectionView, countryOptions, countryMessage } = require('../renderer/state.js')
const { diagnosticText } = require('../renderer/privacy.js')

test('English is the default; only known languages are accepted', () => {
  assert.equal(I18n.detect(null), 'en')
  assert.equal(I18n.detect('de'), 'en')
  assert.equal(I18n.detect('ru'), 'ru')
  assert.equal(I18n.setLanguage('xx'), 'en')
  assert.equal(I18n.language(), 'en')
})

test('both languages have the same keys and the same placeholders', () => {
  const { en, ru } = I18n.STRINGS
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort())
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  for (const key of Object.keys(en)) assert.deepEqual(vars(ru[key]), vars(en[key]), key)
})

test('every key the window uses exists', () => {
  const dir = path.join(__dirname, '..', 'renderer')
  const used = new Set()
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1])
  for (const file of ['renderer.js', 'state.js', 'peer.js'])
    for (const m of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/\bt\('([\w.]+)'/g)) used.add(m[1])
  for (const key of used) assert.ok(key in I18n.STRINGS.en, key)
})

test('the connection view and the country list are English by default', () => {
  I18n.setLanguage('en')
  const view = connectionView({ exits: [{ name: 'x' }], vpnMode: 'full' }, { vpnOn: false, phase: 'idle' })
  assert.equal(view.title, 'Not connected')
  assert.equal(view.button, 'Connect')
  assert.deepEqual(countryOptions([{ cc: 'FI', nodes: 1 }]), [['', 'Automatic'], ['FI', 'Finland · 1 available']])
  assert.deepEqual(countryOptions([{ cc: 'DE', nodes: 2 }], '', 'germ'), [['', 'Automatic'], ['DE', 'Germany · 2 available']])
  assert.equal(countryMessage('DE', true), 'No live nodes in DE; using any')
  assert.equal(diagnosticText('dial 203.0.113.2:4443'), 'dial [address hidden]:4443')
})

test('switching to Russian changes the same views', () => {
  I18n.setLanguage('ru')
  const view = connectionView({ exits: [{ name: 'x' }], vpnMode: 'full' }, { vpnOn: false, phase: 'idle' })
  assert.equal(view.title, 'Не подключено')
  assert.deepEqual(countryOptions([{ cc: 'FI', nodes: 1 }]), [['', 'Авто'], ['FI', 'Финляндия · 1 доступно']])
  assert.equal(diagnosticText('dial 203.0.113.2:4443'), 'dial [адрес скрыт]:4443')
  assert.equal(I18n.t('country.available', { name: 'X', count: 3 }), 'X · 3 доступно')
  I18n.setLanguage('en')
})
