package pool

import "sync"

// What the client is carrying right now, for the diagnostics screen.
//
// The obvious place to ask would be the engine: libbox can stream its connection table
// (CommandConnections). It would also mean running a command server inside the engine and a streaming
// client in the app, for a view of the same streams this pool opened itself - the engine routes
// everything to the core, so every connection the tunnel carries passes through here first. So the list
// is kept here, where it costs a ring buffer.
//
// The one thing it does not include is the engine's own DNS: those queries are hijacked and answered by
// the engine's resolver and the core never sees them. Everything else on this list is everything.

// LiveMax is how many connections are remembered. Enough to see what a phone is doing at a glance, and
// small enough that a browser opening two hundred connections cannot turn diagnostics into a leak.
const LiveMax = 128

// Live is one connection as the screen shows it. The host is the one the application asked for - a name
// when the engine sniffed one - because the address the exit resolved is not ours to know.
type Live struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Plane    string `json:"t"`
	Slot     int    `json:"slot"`
	OpenedAt int64  `json:"at"`
	Sent     int64  `json:"sent"`
	Received int64  `json:"received"`
	// ClosedAt is zero while the connection is open, which is what makes the list readable: a phone with
	// eight live streams and a hundred finished ones must not look like one with a hundred live.
	ClosedAt int64 `json:"closed,omitempty"`
}

// liveEntry is one row while it is still changing.
type liveEntry struct {
	mu  sync.Mutex
	row Live
}

func (e *liveEntry) count(sent, received int64) {
	e.mu.Lock()
	e.row.Sent += sent
	e.row.Received += received
	e.mu.Unlock()
}

func (e *liveEntry) close(now int64) {
	e.mu.Lock()
	if e.row.ClosedAt == 0 {
		e.row.ClosedAt = now
	}
	e.mu.Unlock()
}

func (e *liveEntry) snapshot() Live {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.row
}

type liveRing struct {
	mu    sync.Mutex
	items []*liveEntry
	next  int
}

func (r *liveRing) add(entry *liveEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.items) < LiveMax {
		r.items = append(r.items, entry)
		return
	}
	r.items[r.next] = entry
	r.next = (r.next + 1) % LiveMax
}

// list copies the ring under its own lock and each row under its own, so a reader never holds either
// while rendering and never sees a row half-written.
func (r *liveRing) list() []Live {
	r.mu.Lock()
	entries := append([]*liveEntry(nil), r.items...)
	r.mu.Unlock()
	out := make([]Live, 0, len(entries))
	for _, entry := range entries {
		if entry != nil {
			out = append(out, entry.snapshot())
		}
	}
	// newest first, by when the connection opened: the ring's own order depends on where it wrapped
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].OpenedAt > out[j-1].OpenedAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Live is what the client is carrying, newest first, for the diagnostics screen.
func (p *Pool) Live() []Live { return p.live.list() }
