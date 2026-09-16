// Package health is the client's per-plane health policy, mirroring src/health.mjs.
//
// A node can be perfectly alive while one of its planes is unreachable from a given network (a blocked
// Reality endpoint, a QUIC path a NAT drops). Cooldown therefore belongs to a (node, plane) pair:
// cooling the whole node would hide a usable endpoint on the same machine. The backoff grows with
// consecutive failures and any success clears the pair immediately.
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

// Cooling is one paused plane of a node, for diagnostics.
type Cooling struct {
	Plane string `json:"t"`
	Until int64  `json:"until"`
	Fails int    `json:"fails"`
}

type entry struct {
	fails int
	until int64
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
	h.state[key] = entry{fails: fails, until: until}
	return Record{Fails: fails, Until: until, BackoffMs: backoff}
}

// Ok marks a plane healthy again: the escalation resets.
func (h *Health) Ok(exitID, plane string) { delete(h.state, keyOf(exitID, plane)) }

// Usable reports whether a plane may be tried right now.
func (h *Health) Usable(exitID, plane string) bool {
	current, ok := h.state[keyOf(exitID, plane)]
	return !ok || current.until <= h.millis()
}

// Cooling lists the planes of one node that are paused, sorted by plane name.
func (h *Health) Cooling(exitID string) []Cooling {
	now := h.millis()
	out := make([]Cooling, 0, len(h.state))
	for key, current := range h.state {
		if current.until <= now {
			continue
		}
		separator := lastIndexByte(key, ':')
		if separator < 0 || key[:separator] != exitID {
			continue
		}
		out = append(out, Cooling{Plane: key[separator+1:], Until: current.until, Fails: current.fails})
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
