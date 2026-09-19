import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKOFF_MS,
  DEMOTE_MS,
  FAIL_WINDOW_MS,
  FIRST_BYTE_DEADLINE_MS,
  FIRST_BYTE_SLOW_MS,
  SLOW_MS,
  createPlaneHealth,
  judgeFirstByte,
  nextBackoff,
} from '../src/health.mjs'

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

test('the first byte judges the plane, because the open does not always dial', () => {
  assert.equal(judgeFirstByte({ gotByte: true, elapsedMs: 200 }), 'ok')
  assert.equal(
    judgeFirstByte({ gotByte: true, elapsedMs: FIRST_BYTE_SLOW_MS }),
    'slow',
    'a path that answers, but takes seconds about it, must lose its turn'
  )
  assert.equal(
    judgeFirstByte({ gotByte: false, elapsedMs: 500 }),
    'wait',
    'a young silent connection is normal and must not be judged at all'
  )
  assert.equal(
    judgeFirstByte({ gotByte: false, elapsedMs: FIRST_BYTE_DEADLINE_MS }),
    'slow',
    'nothing at all by the deadline demotes the plane - it does not pause it, the caller may be waiting'
  )
  assert.equal(
    judgeFirstByte({ gotByte: false, closedWithError: true, elapsedMs: 15_000 }),
    'fail',
    'a connection that died without ever answering is the failure the open could not report'
  )
  assert.equal(
    judgeFirstByte({ gotByte: true, closedWithError: true, elapsedMs: 100 }),
    'ok',
    'a stream that carried data and then broke says nothing bad about the path that carried it'
  )
  assert.equal(judgeFirstByte(), 'wait', 'no evidence is not a verdict')
  assert.equal(
    judgeFirstByte({ gotByte: false, elapsedMs: 25, deadlineMs: 20 }),
    'slow',
    'whoever holds the timer decides when silence has lasted long enough, or nothing is ever judged'
  )
})

test('the first-byte thresholds sit between a healthy phone and a broken exit', () => {
  // Measured on the owner's phone on 2026-09-19: the whole round trip was 643 ms at p90 on Wi-Fi, and
  // the failures worth acting on were 12-16 s.
  assert.ok(FIRST_BYTE_SLOW_MS > 643, 'a healthy phone must not demote itself')
  assert.ok(FIRST_BYTE_SLOW_MS < 12_000, 'and a dead exit must be demoted long before it times out')
  assert.ok(
    FIRST_BYTE_DEADLINE_MS > FIRST_BYTE_SLOW_MS,
    'silence is judged later than a slow answer, not sooner'
  )
  assert.ok(FIRST_BYTE_DEADLINE_MS < BACKOFF_MS[0], 'and it must say something before a pause would end')
})

test('a burst of failures from one network event is one failure, not fifty', () => {
  let clock = 1000
  const health = createPlaneHealth({ now: () => clock })

  // one event, fifty dead streams: this is what a Wi-Fi handover looks like from inside
  const first = health.fail(0, 'reality')
  for (let i = 0; i < 49; i++) {
    clock += 10
    const repeat = health.fail(0, 'reality')
    assert.equal(repeat.repeat, true, 'a failure inside the window must not escalate anything')
    assert.equal(repeat.until, first.until, 'and must not extend the pause it already has')
  }
  assert.equal(health.cooling(0)[0].fails, 1, 'one event is one failure')
  assert.equal(
    health.cooling(0)[0].until,
    1000 + BACKOFF_MS[0],
    'a phone must not be paused for ten minutes because one handover killed fifty streams'
  )

  // a genuinely separate failure, later, still escalates - that is what the ladder is for
  clock += FAIL_WINDOW_MS + 1
  const second = health.fail(0, 'reality')
  assert.equal(second.fails, 2)
  assert.equal(second.backoffMs, BACKOFF_MS[1])
})
