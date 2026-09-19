// Per-plane health for the client.
//
// A node can be perfectly alive while one of its data planes is unreachable from a given network: a
// Reality endpoint that this ISP blocks, a hysteria2/QUIC path a NAT drops, a native port filtered
// somewhere in between. Cooldown therefore belongs to a (node, plane) pair — cooling the whole node
// would hide a usable endpoint on the very same machine, which is the point of having several planes.
//
// Backoff grows with consecutive failures so a client does not hammer a dead path, and any success
// clears the pair immediately.
//
// Failure is not the only way a plane stops being usable. A path that answers, but takes seconds to do
// it, keeps winning against a healthy alternative — it never fails, so it is never paused — while the
// applications on top give up on their own timeouts. Measured on a phone on 2026-09-17: reality slid
// from 8 ms to whole seconds over two hours, a third of all connections ended in the app closing the
// socket before the tunnel answered, and hy2 was offered by both nodes the entire time and never once
// used. So a slow success demotes the plane: it stays usable, but it goes to the back of the queue
// until it proves itself fast again.
//
// Pure and side-effect free so the policy can be unit-tested without a network.
export const BACKOFF_MS = [30_000, 120_000, 600_000]

// An open that takes this long is not healthy. A data-plane open is milliseconds when the path is well
// (8-20 ms on that phone); by a second and a half something is wrong with the path, not with the load.
export const SLOW_MS = 1_500

// How long a plane stays at the back of the queue after answering slowly. Long enough for the traffic
// to move somewhere else, short enough that a path which recovers is tried again on its own.
export const DEMOTE_MS = 60_000

// The open is not always evidence. On the phone the client does not dial the exit itself: it opens a
// loopback SOCKS connection to the engine, and the engine answers "connected" while it is still
// sniffing, before it has dialled anything (sing/protocol/socks/lazy.go: LazyConn.Read writes the
// success reply on the first read). Measured 530 times on 2026-09-19: that reply arrives in a median
// of 5 ms while the path behind it costs 378 ms - and arrives just the same when the path is dead, so
// a failure 15 s later is reported to nobody. Every judgement built on the open was therefore blind on
// that client, which is why a phone kept sending half its traffic into an exit that carried nothing.
//
// What cannot lie is the first byte that comes back over the connection the user is actually using.
// It costs no extra traffic, it measures the whole chain, and a path that never produces one is dead
// whatever its handshake said.
//
// The threshold sits well above a healthy phone (p90 of the whole round trip was 643 ms on Wi-Fi and
// 358 ms of that was the round trip itself) and well below the failures worth acting on (12-16 s).
export const FIRST_BYTE_SLOW_MS = 2_000

// A connection that has produced nothing by now is treated as a slow path rather than a dead one: the
// caller may simply be waiting for a server that has nothing to say yet, and demotion is reversible
// while a pause is not. A real failure still arrives through [closedWithError].
export const FIRST_BYTE_DEADLINE_MS = 8_000

// What one connection's first byte says about the plane that carried it. Pure, so the decision can be
// tested without a network and shared between the clients.
//
// 'wait' means "no verdict yet" - the connection is young and silent, which is normal.
export function judgeFirstByte({
  elapsedMs = 0,
  gotByte = false,
  closedWithError = false,
  // The deadline is an argument rather than a constant read from inside, because the thing that decides
  // a connection has been silent long enough is a timer somewhere, and a timer that fires on one
  // schedule while the verdict is judged against another simply returns 'wait' for ever. That is not
  // hypothetical: it was the first version of this, and the test below is the one that caught it.
  deadlineMs = FIRST_BYTE_DEADLINE_MS,
} = {}) {
  const elapsed = Number(elapsedMs) || 0
  if (gotByte) return elapsed >= FIRST_BYTE_SLOW_MS ? 'slow' : 'ok'
  if (closedWithError) return 'fail'
  const deadline = Number(deadlineMs) > 0 ? Number(deadlineMs) : FIRST_BYTE_DEADLINE_MS
  return elapsed >= deadline ? 'slow' : 'wait'
}

export function nextBackoff(fails) {
  const count = Math.max(1, Number(fails) || 1)
  return BACKOFF_MS[Math.min(count, BACKOFF_MS.length) - 1]
}

export function createPlaneHealth({ now = () => Date.now() } = {}) {
  const state = new Map()
  const keyOf = (exitId, type) => `${exitId}:${type}`

  return {
    // record a transport failure for one plane of one node, and return the cooldown applied
    fail(exitId, type) {
      const key = keyOf(exitId, type)
      const previous = state.get(key) ?? { fails: 0, until: 0, demotedUntil: 0 }
      const fails = previous.fails + 1
      const until = now() + nextBackoff(fails)
      state.set(key, { fails, until, demotedUntil: previous.demotedUntil })
      return { fails, until, backoffMs: nextBackoff(fails) }
    },
    // a plane that worked quickly is immediately healthy again, demotion and all
    ok(exitId, type) {
      state.delete(keyOf(exitId, type))
    },
    // a plane that worked, but slowly: it is not paused - it may be the only way out - but anything
    // else is tried before it until the demotion expires
    slow(exitId, type) {
      const key = keyOf(exitId, type)
      const previous = state.get(key) ?? { fails: 0, until: 0, demotedUntil: 0 }
      const demotedUntil = now() + DEMOTE_MS
      // it answered, so the escalation from earlier failures is over; only the demotion remains
      state.set(key, { fails: 0, until: 0, demotedUntil })
      return { demotedUntil, demoteMs: DEMOTE_MS }
    },
    usable(exitId, type) {
      const entry = state.get(keyOf(exitId, type))
      return !entry || entry.until <= now()
    },
    // usable, but only after everything else has been offered a turn
    degraded(exitId, type) {
      const entry = state.get(keyOf(exitId, type))
      return Boolean(entry) && entry.demotedUntil > now()
    },
    // what diagnostics should show: which planes of this node are paused or demoted, and until when
    cooling(exitId) {
      const out = []
      for (const [key, entry] of state) {
        const paused = entry.until > now()
        const demoted = entry.demotedUntil > now()
        if (!paused && !demoted) continue
        const separator = key.lastIndexOf(':')
        if (key.slice(0, separator) !== String(exitId)) continue
        out.push({
          t: key.slice(separator + 1),
          until: paused ? entry.until : entry.demotedUntil,
          fails: entry.fails,
          slow: !paused
        })
      }
      return out.sort((a, b) => a.t.localeCompare(b.t))
    }
  }
}
