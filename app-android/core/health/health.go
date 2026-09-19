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
	"sync"
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

// FirstByteSlowMs and FirstByteDeadlineMs judge a plane by the first byte that comes back over a real
// connection, because the open is not always evidence.
//
// On this client the open does not dial the exit: it opens a loopback SOCKS connection to the engine,
// and the engine answers "connected" while it is still sniffing, before it has dialled anything
// (sing/protocol/socks/lazy.go - LazyConn.Read writes the success reply on the first read, and
// HandshakeFailure afterwards returns os.ErrInvalid, so a dial that fails 15 s later is reported to
// nobody). Measured 530 times on 2026-09-19: a median of 5 ms for that reply against 378 ms for the
// path behind it. Everything judged by the open was therefore blind here, and a phone kept sending half
// its traffic into an exit that carried none of it.
//
// The threshold sits above a healthy phone (643 ms at p90 for a whole round trip on Wi-Fi) and well
// below the failures worth acting on (12-16 s). Kept in step with src/health.mjs.
const (
	FirstByteSlowMs     int64 = 2_000
	FirstByteDeadlineMs int64 = 8_000
)

// Verdict is what one connection's first byte says about the plane that carried it.
type Verdict string

const (
	// VerdictWait means no verdict yet: the connection is young and silent, which is normal.
	VerdictWait Verdict = "wait"
	VerdictOk   Verdict = "ok"
	VerdictSlow Verdict = "slow"
	VerdictFail Verdict = "fail"
)

// JudgeFirstByte mirrors judgeFirstByte in src/health.mjs; the policy lives there first.
//
// Silence past the deadline is a slow path rather than a dead one: the caller may be waiting for a
// server that has nothing to say yet, and a demotion is reversible where a pause is not. A real
// failure still arrives through closedWithError.
// deadlineMs is an argument rather than the constant read from inside, because whatever decides that a
// connection has been silent long enough is a timer somewhere, and a timer on one schedule judged
// against another returns "wait" for ever. That was the first version of this, and a test caught it.
// Zero means FirstByteDeadlineMs.
func JudgeFirstByte(elapsedMs, deadlineMs int64, gotByte, closedWithError bool) Verdict {
	if gotByte {
		if elapsedMs >= FirstByteSlowMs {
			return VerdictSlow
		}
		return VerdictOk
	}
	if closedWithError {
		return VerdictFail
	}
	if deadlineMs <= 0 {
		deadlineMs = FirstByteDeadlineMs
	}
	if elapsedMs >= deadlineMs {
		return VerdictSlow
	}
	return VerdictWait
}

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
//
// Guarded, because the verdicts no longer arrive from one goroutine. A plane used to be judged only by
// the caller that opened it; now the first byte of any live stream - and the timer watching a stream
// that produced none - reports from wherever it happens. An unguarded map under that is not a race in
// the tolerable sense: concurrent writes end the process outright, and this one holds a phone's tunnel.
type Health struct {
	mu    sync.Mutex
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
	h.mu.Lock()
	defer h.mu.Unlock()
	key := keyOf(exitID, plane)
	previous := h.state[key]
	fails := previous.fails + 1
	backoff := NextBackoff(fails)
	until := h.millis() + backoff
	h.state[key] = entry{fails: fails, until: until, demotedUntil: previous.demotedUntil}
	return Record{Fails: fails, Until: until, BackoffMs: backoff}
}

// Ok marks a plane healthy again: the escalation resets and so does any demotion.
func (h *Health) Ok(exitID, plane string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.state, keyOf(exitID, plane))
}

// Slow records a success that took too long. The plane is not paused - it may be the only way out -
// but it goes to the back of the queue, and because it answered at all the failure escalation is over.
func (h *Health) Slow(exitID, plane string) Demotion {
	h.mu.Lock()
	defer h.mu.Unlock()
	demotedUntil := h.millis() + DemoteMs
	h.state[keyOf(exitID, plane)] = entry{fails: 0, until: 0, demotedUntil: demotedUntil}
	return Demotion{DemotedUntil: demotedUntil, DemoteMs: DemoteMs}
}

// Degraded reports whether a plane is usable but should be offered last.
func (h *Health) Degraded(exitID, plane string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	current, ok := h.state[keyOf(exitID, plane)]
	return ok && current.demotedUntil > h.millis()
}

// Usable reports whether a plane may be tried right now.
func (h *Health) Usable(exitID, plane string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	current, ok := h.state[keyOf(exitID, plane)]
	return !ok || current.until <= h.millis()
}

// Cooling lists the planes of one node that are paused or demoted, sorted by plane name.
func (h *Health) Cooling(exitID string) []Cooling {
	h.mu.Lock()
	defer h.mu.Unlock()
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
