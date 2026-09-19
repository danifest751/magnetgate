// Package pool is the client's data plane: it holds the nodes the rendezvous found, remembers which
// (node, plane) pairs are usable and opens streams with failover.
//
// Health is tracked per pair, never per node, mirroring src/health.mjs: a node can be perfectly alive
// while one of its planes is unreachable from this network, and writing the whole node off would hide a
// usable endpoint on the same machine — which is the entire point of a node advertising several planes.
//
// Which transport a plane actually uses is not decided here. A Connector is injected per plane type:
// the native mux is the one this repository ships (see Native), the app adds libbox outbounds for
// Reality and hysteria2, and tests inject fakes so the policy can be checked without a network.
package pool

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strconv"
	"sync"
	"time"

	"magnetgate/core/health"
	"magnetgate/core/offer"
)

// DefaultFresh is how long an offer stays usable: the same window the Node client applies
// (OFFER_TTL_MS), because a node publishes every minute.
const DefaultFresh = 12 * time.Minute

// DefaultOpenTimeout bounds one attempt at one plane. It sits between health.SlowMs, past which a plane
// is demoted, and the patience of the applications above: a browser gives up in a few seconds and shows
// a reset connection, so the pool has to have tried the alternative well before that.
const DefaultOpenTimeout = 4 * time.Second

var (
	// ErrNoNode means nothing fresh has been discovered yet.
	ErrNoNode = errors.New("pool: no exit discovered yet")
	// ErrAllCooling means every plane of every node is sitting out its cooldown.
	ErrAllCooling = errors.New("pool: every plane is cooling down")
	// ErrNoPlane means the nodes that are left do not carry a plane this client can speak.
	ErrNoPlane = errors.New("pool: no usable plane in the offer")
)

// Conn is one proxied stream. socks.Conn has exactly this shape, so a Conn can be handed to the SOCKS
// entry point as is; a test asserts that at compile time.
type Conn interface {
	io.Reader
	io.Writer
	CloseWrite() error
	io.Closer
}

// Target is where a stream should end up, as the exit resolves it.
type Target struct {
	Host string
	Port int
}

// Node is one exit as the data plane sees it.
type Node struct {
	Slot  int
	Name  string
	Offer *offer.Offer
	Seen  time.Time
}

// Connector opens a stream through one plane of one node. `plane` is the raw offer entry, because only
// the connector for that type knows its fields (Reality keys, a pinned certificate, a port).
type Connector interface {
	Open(ctx context.Context, node Node, plane json.RawMessage, target Target) (Conn, error)
}

// ConnectorFunc adapts a function to Connector.
type ConnectorFunc func(ctx context.Context, node Node, plane json.RawMessage, target Target) (Conn, error)

func (f ConnectorFunc) Open(ctx context.Context, node Node, plane json.RawMessage, target Target) (Conn, error) {
	return f(ctx, node, plane, target)
}

// Config is what a pool needs to run.
type Config struct {
	// Preference is the plane order, e.g. {"reality", "hy2", "mgt"}: the first one that works wins.
	Preference []string
	// Connectors maps a plane type to the thing that can speak it. A type with no connector is skipped
	// without any health effect — we never tried it, so we have nothing to report about it.
	Connectors map[string]Connector
	Health     *health.Health
	// OpenTimeout bounds one attempt at one plane. Without it a path that has degraded but not died
	// holds the caller for as long as it likes - measured at 15 to 18 seconds on a phone - while the
	// application on top gives up after three and reports a reset connection. Zero means the default.
	OpenTimeout time.Duration
	// FirstByteDeadline is how long a stream may stay silent before its plane is demoted for it. Zero
	// means health.FirstByteDeadlineMs; tests shorten it so that silence can be observed in milliseconds.
	FirstByteDeadline time.Duration
	Fresh             time.Duration
	Now               func() time.Time
	Logf              func(format string, args ...any)
}

// Pool is the data plane.
type Pool struct {
	cfg  Config
	now  func() time.Time
	logf func(string, ...any)

	mu      sync.Mutex
	nodes   map[int]Node
	rr      int
	country string
	// carried and delivered are every byte this client has sent and received through a plane since the
	// tunnel came up; see Traffic.
	sent     int64
	received int64
	// live is what the client is carrying, for the diagnostics screen; see live.go
	live liveRing
	// when each (node, plane) was last reported as not yet wired to the engine; see unwired
	saidUnwired map[string]time.Time
}

// unwired says once, and not oftener than every few seconds, that a plane cannot be used because the
// engine has not been told where it listens.
//
// It is worth a line: if it keeps appearing outside a reload, the engine and the core disagree about
// which planes exist, and that is a defect rather than a moment. It is worth suppressing too - during a
// reload every stream in flight hits it, and a flood would push the reason out of the 200-line ring
// that diagnostics can actually show (trap 49).
func (p *Pool) unwired(slot int, plane string) {
	now := p.now()
	id := key(slot, plane)
	p.mu.Lock()
	if p.saidUnwired == nil {
		p.saidUnwired = make(map[string]time.Time)
	}
	said := p.saidUnwired[id]
	quiet := !said.IsZero() && now.Sub(said) < 5*time.Second
	if !quiet {
		p.saidUnwired[id] = now
	}
	p.mu.Unlock()
	if quiet {
		return
	}
	p.logf("plane not wired yet: %s slot %d (the engine is being reconfigured; not a node failure)", plane, slot)
}

// New prepares a pool. With no preference the native plane is the only one, which is what a build
// without libbox can actually speak.
func New(cfg Config) *Pool {
	if len(cfg.Preference) == 0 {
		cfg.Preference = []string{"mgt"}
	}
	if cfg.Health == nil {
		cfg.Health = health.New(cfg.Now)
	}
	if cfg.Fresh <= 0 {
		cfg.Fresh = DefaultFresh
	}
	if cfg.OpenTimeout <= 0 {
		cfg.OpenTimeout = DefaultOpenTimeout
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	return &Pool{
		cfg:   cfg,
		now:   cfg.Now,
		logf:  cfg.Logf,
		nodes: make(map[int]Node),
	}
}

// Update records a node (or replaces what was known about it). Called on every poll, so it must stay
// cheap: nodes carry the offer that was just merged by the rendezvous.
func (p *Pool) Update(record Node) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.nodes[record.Slot] = record
}

// Nodes lists the fresh nodes, in slot order, for diagnostics.
func (p *Pool) Nodes() []Node {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]Node, 0, len(p.nodes))
	for _, node := range p.nodes {
		if p.stale(node) {
			continue
		}
		out = append(out, node)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Slot < out[j].Slot })
	return out
}

// countBytes adds one stream's traffic to the totals. Called from whichever goroutine is reading or
// writing that stream, which is why it takes the lock rather than trusting atomics to be enough for a
// pair of numbers that are also read together.
func (p *Pool) countBytes(sent, received int64) {
	p.mu.Lock()
	p.sent += sent
	p.received += received
	p.mu.Unlock()
}

// Traffic is every byte carried through a plane since this pool was built: what the screen shows as
// counters, and the only place they can be counted honestly. Everything the tunnel carries passes
// through here - the engine routes all of it to the core - so these are totals, not a sample.
func (p *Pool) Traffic() (sent, received int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sent, p.received
}

// AdvertisedUpdate is the newest build any node advertises, or nil. (Named apart from Update, which
// records a node: one is what the rendezvous found, the other is what it says about this client.)
//
// The newest wins rather than whichever node was discovered first: nodes are deployed one at a time,
// so for a while they disagree, and taking the first would make a phone's offer depend on the order
// discovery happened to finish in - the same trap the rule-set manifest fell into.
func (p *Pool) AdvertisedUpdate() *offer.Update {
	var best *offer.Update
	for _, node := range p.Nodes() {
		if node.Offer == nil || !node.Offer.Update.Valid() {
			continue
		}
		if best == nil || node.Offer.Update.VersionCode > best.VersionCode {
			best = node.Offer.Update
		}
	}
	return best
}

// Cooling lists the planes of one node that are paused, for the diagnostics table.
func (p *Pool) Cooling(slot int) []health.Cooling { return p.cfg.Health.Cooling(idOf(slot)) }

// Fresh reports whether a node holds a usable offer right now.
func (p *Pool) Fresh(slot int) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	node, ok := p.nodes[slot]
	return ok && !p.stale(node)
}

// Dial opens one stream, preferring the configured planes and falling through to the next candidate
// when a plane or a whole node fails.
//
// This is the policy the desktop client applies (src/client.js): round robin over the nodes, plane
// preference within each node, a pair that failed recently is skipped instead of retried, and the
// cooldown grows with consecutive failures.
func (p *Pool) Dial(ctx context.Context, host string, port int) (Conn, error) {
	target := Target{Host: host, Port: port}
	candidates := p.Nodes()
	if len(candidates) == 0 {
		return nil, ErrNoNode
	}
	// The country the user asked for, if they asked and it is there. A preference that cannot be
	// honoured right now is reported once per stream rather than enforced: see SelectCountry.
	if selection := SelectCountry(candidates, p.Country()); selection.Country != "" {
		candidates = selection.Nodes
		if selection.Fallback {
			p.logf("no node in %s right now, using every country for this stream", selection.Country)
		}
	}

	p.mu.Lock()
	start := p.rr % len(candidates)
	p.mu.Unlock()

	var lastErr error
	attempts, cooling := 0, 0
	slowEnough := time.Duration(health.SlowMs) * time.Millisecond
	// Two rounds over the same candidates: the planes that are behaving, and then the ones that only
	// answered slowly. A demoted plane is never dropped - it may be the only way out of this network -
	// but it waits until everything healthy has had its turn, which is what lets traffic leave a path
	// that is rotting rather than failing.
	for round := 0; round < 2 && lastErrIsRetryable(lastErr); round++ {
		wantDegraded := round == 1
		for i := range candidates {
			node := candidates[(start+i)%len(candidates)]
			for _, plane := range p.cfg.Preference {
				connector := p.cfg.Connectors[plane]
				if connector == nil {
					continue // we cannot speak this plane, so there is nothing to report about it
				}
				if !p.cfg.Health.Usable(idOf(node.Slot), plane) {
					if !wantDegraded {
						cooling++ // counted once, not once per round
					}
					continue
				}
				if p.cfg.Health.Degraded(idOf(node.Slot), plane) != wantDegraded {
					continue
				}
				raw := node.Offer.Pick([]string{plane})
				if raw == nil {
					continue // this node does not offer that plane
				}
				attempts++
				openCtx, cancel := context.WithTimeout(ctx, p.cfg.OpenTimeout)
				started := p.now()
				conn, err := connector.Open(openCtx, node, raw, target)
				took := p.now().Sub(started)
				// no connector keeps the context after Open returns (socks5client clears the deadline,
				// session.Connect only dials with it), so this cannot pull a live stream down
				cancel()
				if err == nil {
					if took >= slowEnough {
						demotion := p.cfg.Health.Slow(idOf(node.Slot), plane)
						p.logf("slow plane: %s slot %d answered in %s, others go first for %s",
							plane, node.Slot, took.Round(time.Millisecond),
							time.Duration(demotion.DemoteMs)*time.Millisecond)
					} else {
						p.cfg.Health.Ok(idOf(node.Slot), plane)
					}
					p.mu.Lock()
					p.rr = (start + i + 1) % len(candidates)
					p.mu.Unlock()
					p.logf("stream to %s:%d via %s slot %d", host, port, plane, node.Slot)
					// The open above is worth what it measured, which on this client is a loopback reply
					// from the engine written before it dialled anything. What the stream does next is
					// worth more, so the verdict is revisited when the first byte comes back - or fails
					// to (see watchFirstByte).
					id, slot := idOf(node.Slot), node.Slot
					entry := &liveEntry{row: Live{
						Host:     host,
						Port:     port,
						Plane:    plane,
						Slot:     slot,
						OpenedAt: p.now().UnixMilli(),
					}}
					p.live.add(entry)
					return watchFirstByte(conn, p.cfg.FirstByteDeadline, func(verdict health.Verdict, after time.Duration) {
						switch verdict {
						case health.VerdictOk:
							p.cfg.Health.Ok(id, plane)
						case health.VerdictSlow:
							demotion := p.cfg.Health.Slow(id, plane)
							p.logf("slow plane: %s slot %d answered after %s, others go first for %s",
								plane, slot, after.Round(time.Millisecond),
								time.Duration(demotion.DemoteMs)*time.Millisecond)
						case health.VerdictFail:
							record := p.cfg.Health.Fail(id, plane)
							p.logf("dead plane: %s slot %d carried nothing in %s, paused for %s",
								plane, slot, after.Round(time.Millisecond),
								time.Duration(record.BackoffMs)*time.Millisecond)
						}
					}, func(sent, received int64) {
						entry.count(sent, received)
						p.countBytes(sent, received)
					}, func() { entry.close(p.now().UnixMilli()) }), nil
				}
				lastErr = err
				// A plane the engine has not been told about yet is this client reconfiguring itself, not
				// the node failing, and pausing the pair for it is actively harmful. Measured on the phone
				// on 17.09: every engine reload emptied the port map for an instant, all four engine planes
				// were cooled for 30s at once, and the pool fell through to the plane the engine does not
				// carry - on a network that blocks that plane, the tunnel had nowhere left to go and the
				// pause escalated to ten minutes. The same thing happened at startup, when a node was found
				// before the engine had a listener for it.
				if errors.Is(err, errUnknownPlane) {
					p.unwired(node.Slot, plane)
					continue
				}
				record := p.cfg.Health.Fail(idOf(node.Slot), plane)
				p.logf("transport failed: %s slot %d (paused %s after %d failure(s)): %v",
					plane, node.Slot, time.Duration(record.BackoffMs)*time.Millisecond, record.Fails, err)
			}
		}
	}
	if attempts == 0 && cooling > 0 {
		// Every pair is paused, and refusing here is worse than trying. The pause exists to stop a client
		// hammering a path that just failed; it was never meant to mean "this phone has no internet".
		// Measured on the owner's phone on 19.09: one network event paused every pair at once, and for
		// ten minutes the core answered every connection - and every DNS query - with a refusal, which is
		// what "it hung" looked like from the outside.
		//
		// So the last resort is the pair whose pause ends soonest: the one the policy dislikes least.
		if node, plane, ok := p.leastCooling(candidates); ok {
			p.logf("every plane is paused; trying %s slot %d anyway rather than refusing", plane, node.Slot)
			openCtx, cancel := context.WithTimeout(ctx, p.cfg.OpenTimeout)
			conn, err := p.cfg.Connectors[plane].Open(openCtx, node, node.Offer.Pick([]string{plane}), target)
			cancel()
			if err == nil {
				p.logf("stream to %s:%d via %s slot %d (last resort)", host, port, plane, node.Slot)
				id, slot := idOf(node.Slot), node.Slot
				entry := &liveEntry{row: Live{
					Host: host, Port: port, Plane: plane, Slot: slot, OpenedAt: p.now().UnixMilli(),
				}}
				p.live.add(entry)
				return watchFirstByte(conn, p.cfg.FirstByteDeadline, func(verdict health.Verdict, after time.Duration) {
					if verdict == health.VerdictOk {
						p.cfg.Health.Ok(id, plane)
					}
					// a last-resort attempt that fails again says nothing new: the pair is already paused
				}, func(sent, received int64) {
					entry.count(sent, received)
					p.countBytes(sent, received)
				}, func() { entry.close(p.now().UnixMilli()) }), nil
			}
			lastErr = err
		}
		return nil, ErrAllCooling
	}
	if attempts == 0 {
		return nil, ErrNoPlane
	}
	return nil, lastErr
}

// leastCooling is the pair to try when the policy has paused them all: the one whose pause ends first,
// which is the one it dislikes least. Only pairs this client can actually speak and this node actually
// offers are considered.
func (p *Pool) leastCooling(candidates []Node) (Node, string, bool) {
	var best Node
	var bestPlane string
	var bestUntil int64
	found := false
	for _, node := range candidates {
		for _, plane := range p.cfg.Preference {
			if p.cfg.Connectors[plane] == nil || node.Offer == nil || node.Offer.Pick([]string{plane}) == nil {
				continue
			}
			until := int64(0)
			for _, cooling := range p.cfg.Health.Cooling(idOf(node.Slot)) {
				if cooling.Plane == plane {
					until = cooling.Until
				}
			}
			if !found || until < bestUntil {
				best, bestPlane, bestUntil, found = node, plane, until, true
			}
		}
	}
	return best, bestPlane, found
}

// lastErrIsRetryable keeps the second round from running when the caller has already given up: a
// cancelled context is not a reason to go through every demoted plane as well.
func lastErrIsRetryable(err error) bool {
	return !errors.Is(err, context.Canceled)
}

// Snapshot is the diagnostics view: every fresh node with the planes it advertises and the ones this
// client is sitting out. It mirrors what the desktop writes to MAGNETGATE_DP_OUT.
type Snapshot struct {
	V     int           `json:"v"`
	Exits []SnapshotRow `json:"exits"`
}

// SnapshotRow is one node in the diagnostics view.
type SnapshotRow struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Slot    int               `json:"slot"`
	TS      int64             `json:"ts"`
	Node    string            `json:"node,omitempty"`
	Country string            `json:"country,omitempty"`
	DP      []json.RawMessage `json:"dp"`
	Cooling []health.Cooling  `json:"cooling"`
	// The routing lists this node says a client should be using. Only nodes reached over Nostr carry it.
	RuleSets *offer.RuleSets `json:"rs,omitempty"`
	// The build this node says clients should be running; see offer.Update for what it is and is not.
	Update *offer.Update `json:"up,omitempty"`
}

// Snapshot builds the diagnostics view.
func (p *Pool) Snapshot() Snapshot {
	out := Snapshot{V: 4, Exits: []SnapshotRow{}}
	for _, node := range p.Nodes() {
		row := SnapshotRow{
			ID:      idOf(node.Slot),
			Name:    node.Name,
			Slot:    node.Slot,
			TS:      node.Offer.TS,
			Node:    node.Offer.Node,
			Country: node.Offer.Country,
			DP:      node.Offer.DP,
			Cooling: p.Cooling(node.Slot),
		}
		if node.Offer.RuleSets.Valid() {
			row.RuleSets = node.Offer.RuleSets
		}
		if node.Offer.Update.Valid() {
			row.Update = node.Offer.Update
		}
		if row.Cooling == nil {
			row.Cooling = []health.Cooling{}
		}
		out.Exits = append(out.Exits, row)
	}
	return out
}

func (p *Pool) stale(node Node) bool {
	return p.now().Sub(node.Seen) > p.cfg.Fresh
}

// idOf is the node identity the health policy keys on, matching the slot-derived id the desktop uses.
func idOf(slot int) string { return strconv.Itoa(slot) }
