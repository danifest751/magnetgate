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
// Pure and side-effect free so the policy can be unit-tested without a network.
export const BACKOFF_MS = [30_000, 120_000, 600_000]

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
      const previous = state.get(key) ?? { fails: 0, until: 0 }
      const fails = previous.fails + 1
      const until = now() + nextBackoff(fails)
      state.set(key, { fails, until })
      return { fails, until, backoffMs: nextBackoff(fails) }
    },
    // a plane that worked is immediately healthy again
    ok(exitId, type) {
      state.delete(keyOf(exitId, type))
    },
    usable(exitId, type) {
      const entry = state.get(keyOf(exitId, type))
      return !entry || entry.until <= now()
    },
    // what diagnostics should show: which planes of this node are paused and until when
    cooling(exitId) {
      const out = []
      for (const [key, entry] of state) {
        if (entry.until <= now()) continue
        const separator = key.lastIndexOf(':')
        if (key.slice(0, separator) !== String(exitId)) continue
        out.push({ t: key.slice(separator + 1), until: entry.until, fails: entry.fails })
      }
      return out.sort((a, b) => a.t.localeCompare(b.t))
    }
  }
}
