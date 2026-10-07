const { test } = require('node:test')
const assert = require('node:assert/strict')
const { diagnosticText } = require('../renderer/privacy.js')

test('diagnostics conceal IP addresses while retaining time and hostnames', () => {
  assert.equal(diagnosticText('19:53:48 dial 203.0.113.2:4443 failed'), '19:53:48 dial [адрес скрыт]:4443 failed')
  assert.equal(diagnosticText('dial [2001:db8::1]:443 / ::1'), 'dial [[адрес скрыт]]:443 / [адрес скрыт]')
  assert.equal(diagnosticText('https://example.com at 20:06:01'), 'https://example.com at 20:06:01')
})
