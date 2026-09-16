const { test } = require('node:test')
const assert = require('node:assert/strict')
const { summarize, select } = require('../countries.cjs')

const ep = (country, exitName, t = 'reality') => ({
  t,
  host: '203.0.113.1',
  port: 443,
  exitId: exitName,
  exitName,
  country
})

const endpoints = [
  ep('NL', 'nl-1'),
  ep('NL', 'nl-1', 'hy2'),
  ep('nl', 'nl-1', 'mgt'), // lower case must be folded
  ep('FI', 'fi-1'),
  ep(undefined, 'old-exit')
]

test('countries: the list counts nodes and endpoints per country, ignoring unknown ones', () => {
  assert.deepEqual(summarize(endpoints), [
    { cc: 'FI', nodes: 1, endpoints: 1 },
    { cc: 'NL', nodes: 1, endpoints: 3 }
  ])
  assert.deepEqual(summarize([]), [])
  assert.deepEqual(summarize(undefined), [])
})

test('countries: choosing one keeps only that country, and never hides its own nodes', () => {
  const sel = select(endpoints, 'fi')
  assert.equal(sel.fallback, false)
  assert.equal(sel.country, 'FI')
  assert.equal(sel.endpoints.length, 1)
  assert.equal(sel.endpoints[0].exitName, 'fi-1')
  assert.deepEqual(sel.available, summarize(endpoints), 'the list is always the full picture')
})

test('countries: no choice means everything', () => {
  for (const value of ['', null, undefined, 'x', 'XXX', 42]) {
    const sel = select(endpoints, value)
    assert.equal(sel.country, '', `"${value}" is not a country`)
    assert.equal(sel.endpoints.length, endpoints.length)
    assert.equal(sel.fallback, false)
  }
})

test('countries: a chosen country with nothing live falls back to everything and says so', () => {
  const sel = select(endpoints, 'DE')
  assert.equal(sel.country, 'DE')
  assert.equal(sel.fallback, true)
  assert.equal(sel.endpoints.length, endpoints.length, 'refusing to connect would be worse')
})

test('countries: a single old exit leaves no list, so the UI hides the control', () => {
  const sel = select([ep(undefined, 'legacy')], 'NL')
  assert.deepEqual(sel.available, [])
  assert.equal(sel.fallback, true)
  assert.equal(sel.endpoints.length, 1)
})
