// Traffic totals for the UI.
//
// sing-box carries its own upload/download counters, but they restart whenever the engine restarts —
// a mode switch, a credential rotation, an engine crash. Showing them raw would make the volume jump
// back to zero mid-session, so fold the last value of a finished engine into a base and add the
// current counter on top. The result means "this connection"; the caller resets it on a new Connect.
//
// Kept pure and side-effect-free so it can be unit-tested without Electron.
function accumulate(base, prev, raw) {
  const next = { up: Number(base?.up) || 0, down: Number(base?.down) || 0 }
  const sample = { up: Number(raw?.up) || 0, down: Number(raw?.down) || 0 }
  for (const key of ['up', 'down']) {
    // a counter that went backwards means the engine restarted: keep what it had already reported
    if (prev && sample[key] < (Number(prev[key]) || 0)) next[key] += Number(prev[key]) || 0
  }
  return {
    base: next,
    sample,
    total: { up: next.up + sample.up, down: next.down + sample.down }
  }
}

// bytes per second, from a byte delta over a time delta (0 when there is nothing to compare with)
function rate(previous, current, seconds) {
  const dt = Number(seconds)
  if (!(dt > 0)) return 0
  const delta = (Number(current) || 0) - (Number(previous) || 0)
  return delta > 0 ? delta / dt : 0
}

module.exports = { accumulate, rate }
