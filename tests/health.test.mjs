import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKOFF_MS, DEMOTE_MS, SLOW_MS, createPlaneHealth, nextBackoff } from '../src/health.mjs'

test('backoff grows with consecutive failures and stops growing', () => {
  assert.equal(nextBackoff(1), BACKOFF_MS[0])
  assert.equal(nextBackoff(2), BACKOFF_MS[1])
  assert.equal(nextBackoff(3), BACKOFF_MS[2])
  assert.equal(nextBackoff(9), BACKOFF_MS[2], 'it must not grow without bound')
  assert.equal(nextBackoff(0), BACKOFF_MS[0], 'a missing count is treated as the first failure')
})

test('a failed plane is paused, then usable again, and a success clears it', () => {
  let clock = 1_000
  const health = createPlaneHealth({ now: () => clock })

  assert.equal(health.usable(0, 'reality'), true, 'unknown planes are usable')

  const first = health.fail(0, 'reality')
  assert.equal(first.fails, 1)
  assert.equal(health.usable(0, 'reality'), false, 'a failed plane sits out its cooldown')

  clock += BACKOFF_MS[0] + 1
  assert.equal(health.usable(0, 'reality'), true, 'after the cooldown it is tried again')

  const second = health.fail(0, 'reality')
  assert.equal(second.fails, 2, 'failures accumulate while the cooldown never expires')
  assert.equal(second.backoffMs, BACKOFF_MS[1], 'the pause grows')

  health.ok(0, 'reality')
  assert.equal(health.usable(0, 'reality'), true)
  assert.equal(health.fail(0, 'reality').fails, 1, 'a success resets the escalation')
})

test('health is per plane: a broken reality does not hide a working hy2 on the same node', () => {
  const clock = 5_000
  const health = createPlaneHealth({ now: () => clock })
  health.fail(1, 'reality')
  health.fail(1, 'reality')
  assert.equal(health.usable(1, 'reality'), false)
  assert.equal(health.usable(1, 'hy2'), true, 'the other plane of the same node stays usable')
  assert.equal(health.usable(1, 'mgt'), true)
})

test('health is per node: cooling one exit leaves the other alone', () => {
  const clock = 9_000
  const health = createPlaneHealth({ now: () => clock })
  health.fail(0, 'reality')
  assert.equal(health.usable(0, 'reality'), false)
  assert.equal(health.usable(1, 'reality'), true, 'the second node is unaffected')
})

test('cooling() reports what diagnostics needs, and only for the asked node', () => {
  let clock = 100
  const health = createPlaneHealth({ now: () => clock })
  health.fail(0, 'hy2')
  health.fail(0, 'reality')
  health.fail(1, 'reality')

  const cooling = health.cooling(0)
  assert.deepEqual(
    cooling.map((c) => c.t),
    ['hy2', 'reality'],
    'sorted by plane, only this node'
  )
  assert.equal(cooling[0].fails, 1)
  assert.ok(cooling[0].until > clock)

  clock += BACKOFF_MS[0] + 1
  assert.deepEqual(health.cooling(0), [], 'expired cooldowns are not reported')
  assert.equal(health.cooling(2).length, 0, 'an unknown node has nothing cooling')
})

// The failure that cost an evening: a plane answering in seconds is never paused, so it keeps winning
// against a healthy alternative while applications give up on their own timeouts.
test('a slow plane keeps working but loses its turn', () => {
  let clock = 100
  const health = createPlaneHealth({ now: () => clock })

  health.slow(0, 'reality')
  assert.equal(health.usable(0, 'reality'), true, 'a slow plane may still be the only way out')
  assert.equal(health.degraded(0, 'reality'), true, 'but everything else is tried first')
  assert.equal(health.degraded(0, 'hy2'), false, 'the alternative is untouched')

  clock += DEMOTE_MS + 1
  assert.equal(health.degraded(0, 'reality'), false, 'the demotion expires on its own')
})

test('a fast success clears a demotion, and a slow one clears the escalation', () => {
  let clock = 100
  const health = createPlaneHealth({ now: () => clock })

  health.slow(0, 'reality')
  health.ok(0, 'reality')
  assert.equal(health.degraded(0, 'reality'), false, 'proving itself fast is enough')

  health.fail(0, 'reality')
  health.fail(0, 'reality')
  clock += BACKOFF_MS[1] + 1
  const record = health.slow(0, 'reality')
  assert.equal(record.demoteMs, DEMOTE_MS)
  assert.equal(health.usable(0, 'reality'), true, 'it answered, so it is not paused any more')
  assert.equal(health.degraded(0, 'reality'), true)
  health.fail(0, 'reality')
  assert.equal(
    health.cooling(0)[0].fails,
    1,
    'a success - even a slow one - ends the escalation, so the next failure starts over'
  )
})

test('cooling() distinguishes a paused plane from a demoted one', () => {
  let clock = 100
  const health = createPlaneHealth({ now: () => clock })
  health.fail(0, 'hy2')
  health.slow(0, 'reality')

  const cooling = health.cooling(0)
  assert.deepEqual(cooling.map((c) => c.t), ['hy2', 'reality'])
  assert.equal(cooling[0].slow, false, 'hy2 is paused after a failure')
  assert.equal(cooling[1].slow, true, 'reality only lost its turn')
  assert.equal(cooling[1].until, clock + DEMOTE_MS)
})

test('the slow threshold is what an open costs when the path is unwell, not when it is busy', () => {
  assert.ok(SLOW_MS >= 1_000, 'a normal open is milliseconds; anything under a second would be noise')
  assert.ok(SLOW_MS <= BACKOFF_MS[0] / 10, 'and it has to fire long before a pause would')
})
