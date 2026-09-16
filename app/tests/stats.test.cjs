const { test } = require('node:test')
const assert = require('node:assert/strict')
const { accumulate, rate } = require('../stats.cjs')

test('traffic: totals add up while the counter grows', () => {
  let base = { up: 0, down: 0 }
  let prev = null
  const samples = [
    { up: 100, down: 1000 },
    { up: 300, down: 5000 },
    { up: 600, down: 9000 }
  ]
  let last = null
  for (const raw of samples) {
    const acc = accumulate(base, prev, raw)
    base = acc.base
    prev = acc.sample
    last = acc.total
  }
  assert.deepEqual(last, { up: 600, down: 9000 }, 'no folding when nothing restarted')
})

test('traffic: an engine restart keeps what the finished engine reported', () => {
  // first engine reported 5 MB up / 50 MB down, then sing-box restarted (counters back to zero)
  let base = { up: 0, down: 0 }
  const first = accumulate(base, null, { up: 5_000_000, down: 50_000_000 })
  base = first.base
  const beforeRestart = accumulate(base, first.sample, { up: 6_000_000, down: 60_000_000 })
  base = beforeRestart.base
  const afterRestart = accumulate(base, beforeRestart.sample, { up: 0, down: 0 })
  assert.deepEqual(
    afterRestart.total,
    { up: 6_000_000, down: 60_000_000 },
    'the volume must not drop to zero mid-session'
  )
  const later = accumulate(afterRestart.base, afterRestart.sample, { up: 1_000, down: 2_000 })
  assert.deepEqual(later.total, { up: 6_001_000, down: 60_002_000 })
})

test('traffic: a caller reset starts from zero again', () => {
  const acc = accumulate({ up: 0, down: 0 }, null, { up: 10, down: 20 })
  assert.deepEqual(acc.total, { up: 10, down: 20 })
  // resetTraffic() passes a zeroed base and no previous sample, as a new Connect does
  const fresh = accumulate({ up: 0, down: 0 }, null, { up: 0, down: 0 })
  assert.deepEqual(fresh.total, { up: 0, down: 0 })
})

test('traffic: garbage in the API response is treated as zero', () => {
  const acc = accumulate(undefined, { up: 5, down: 5 }, { up: 'x', down: null })
  assert.deepEqual(acc.total, { up: 5, down: 5 }, 'a reset with junk keeps the folded value')
})

test('traffic: rate is bytes per second and never negative', () => {
  assert.equal(rate(1000, 3000, 2), 1000)
  assert.equal(rate(3000, 1000, 2), 0, 'a restart must not produce a negative speed')
  assert.equal(rate(0, 100, 0), 0, 'no time delta, no speed')
  assert.equal(rate(undefined, 100, 1), 100)
})
