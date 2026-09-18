// Package health is the client's per-plane health policy, mirroring src/health.mjs.
//
// A node can be perfectly alive while one of its planes is unreachable from a given network (a blocked
// Reality endpoint, a QUIC path a NAT drops). Cooldown therefore belongs to a (node, plane) pair:
// cooling the whole node would hide a usable endpoint on the same machine. The backoff grows with
// consecutive failures and any success clears the pair immediately.
//
// Failure is not the only way a plane stops being usable. A path that answers, but takes seconds to do
// it, keeps winning against a healthy alternative - it never fails, so it is never paused - while the
// applications on top give up on their own timeouts. Measured on a phone on 2026-09-17: reality slid
// from 8 ms to whole seconds over two hours, a third of all connections ended with the app closing the
// socket before the tunnel answered, and hy2 was offered by both nodes the entire time and never used.
// So a slow success demotes the plane: it stays usable, but everything else is tried before it.
//
// Pure apart from an injected clock, so the policy is unit-testable and can be pinned to the tracked
// vectors.
package health

import (
	"sort"
	"time"
)

// BackoffMs is the pause after the first, second and later consecutive failures.
var BackoffMs = []int64{30_000, 120_000, 600_000}

// SlowMs is the open that is not healthy. A data-plane open is milliseconds when the path is well
// (8-20 ms on that phone); by a second and a half something is wrong with the path, not with the load.
const SlowMs int64 = 1_500

// DemoteMs is how long a plane stays at the back of the queue after answering slowly: long enough for
// traffic to move elsewhere, short enough that a path which recovers is tried again on its own.
const DemoteMs int64 = 60_000

// NextBackoff is the pause for `fails` consecutive failures (1-based, never grows past the last step).
func NextBackoff(fails int) int64 {
	count := fails
	if count < 1 {
		count = 1
	}
	if count > len(BackoffMs) {
		count = len(BackoffMs)
	}
	return BackoffMs[count-1]
}

// Record is what a failure produced.
type Record struct {
	Fails     int   `json:"fails"`
	Until     int64 `json:"until"` // milliseconds since the epoch
	BackoffMs int64 `json:"backoffMs"`
}

// Demotion is what a slow success produced.
type Demotion struct {
	DemotedUntil int64 `json:"demotedUntil"`
	DemoteMs     int64 `json:"demoteMs"`
}

// Cooling is one paused or demoted plane of a node, for diagnostics.
type Cooling struct {
	Plane string `json:"t"`
	Until int64  `json:"until"`
	Fails int    `json:"fails"`
	// Slow is a plane that answers but lost its turn, as opposed to one paused after a failure.
	Slow bool `json:"slow"`
}

type entry struct {
	fails        int
	until        int64
	demotedUntil int64
}

// Health tracks the planes of every node.
type Health struct {
	state map[string]entry
	now   func() time.Time
}

// New returns a tracker. Pass a clock to make tests deterministic.
func New(now func() time.Time) *Health {
	if now == nil {
		now = time.Now
	}
	return &Health{state: make(map[string]entry), now: now}
}

func keyOf(exitID, plane string) string { return exitID + ":" + plane }

func (h *Health) millis() int64 { return h.now().UnixMilli() }

// Fail records a transport failure for one plane of one node and returns the cooldown applied.
func (h *Health) Fail(exitID, plane string) Record {
	key := keyOf(exitID, plane)
	previous := h.state[key]
	fails := previous.fails + 1
	backoff := NextBackoff(fails)
	until := h.millis() + backoff
	h.state[key] = entry{fails: fails, until: until, demotedUntil: previous.demotedUntil}
	return Record{Fails: fails, Until: until, BackoffMs: backoff}
}

// Ok marks a plane healthy again: the escalation resets and so does any demotion.
func (h *Health) Ok(exitID, plane string) { delete(h.state, keyOf(exitID, plane)) }

// Slow records a success that took too long. The plane is not paused - it may be the only way out -
// but it goes to the back of the queue, and because it answered at all the failure escalation is over.
func (h *Health) Slow(exitID, plane string) Demotion {
	demotedUntil := h.millis() + DemoteMs
	h.state[keyOf(exitID, plane)] = entry{fails: 0, until: 0, demotedUntil: demotedUntil}
	return Demotion{DemotedUntil: demotedUntil, DemoteMs: DemoteMs}
}

// Degraded reports whether a plane is usable but should be offered last.
func (h *Health) Degraded(exitID, plane string) bool {
	current, ok := h.state[keyOf(exitID, plane)]
	return ok && current.demotedUntil > h.millis()
}

// Usable reports whether a plane may be tried right now.
func (h *Health) Usable(exitID, plane string) bool {
	current, ok := h.state[keyOf(exitID, plane)]
	return !ok || current.until <= h.millis()
}

// Cooling lists the planes of one node that are paused or demoted, sorted by plane name.
func (h *Health) Cooling(exitID string) []Cooling {
	now := h.millis()
	out := make([]Cooling, 0, len(h.state))
	for key, current := range h.state {
		paused := current.until > now
		demoted := current.demotedUntil > now
		if !paused && !demoted {
			continue
		}
		separator := lastIndexByte(key, ':')
		if separator < 0 || key[:separator] != exitID {
			continue
		}
		until := current.demotedUntil
		if paused {
			until = current.until
		}
		out = append(out, Cooling{
			Plane: key[separator+1:],
			Until: until,
			Fails: current.fails,
			Slow:  !paused,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Plane < out[j].Plane })
	return out
}

func lastIndexByte(s string, b byte) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == b {
			return i
		}
	}
	return -1
}
