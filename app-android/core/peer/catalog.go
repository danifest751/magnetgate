package peer

import (
	"errors"
	"sort"
	"sync"
	"time"
)

const PresenceTTL = 15 * time.Second
const ReservationTTL = 3 * time.Second

type Country struct {
	Code  string `json:"cc"`
	Nodes int    `json:"nodes"`
}
type Node struct {
	Device  string `json:"device"`
	Country string `json:"country"`
	Epoch   string `json:"epoch"`
	Slots   int    `json:"slots"`
	Expires int64  `json:"expires"`
}
type Ticket struct {
	ID      string `json:"id"`
	Guest   string `json:"guest"`
	Exit    string `json:"exit"`
	Epoch   string `json:"epoch"`
	Country string `json:"country"`
	Expires int64  `json:"expires"`
}
type registration struct {
	node         Node
	path         string
	revision     uint64
	reservations map[string]*Ticket
}
type Catalog struct {
	mu          sync.Mutex
	nodes       map[string]*registration
	revision    uint64
	subscribers map[chan message]struct{}
}

func NewCatalog() *Catalog {
	return &Catalog{nodes: map[string]*registration{}, subscribers: map[chan message]struct{}{}}
}
func validCountry(cc string) bool {
	return len(cc) == 2 && cc[0] >= 'A' && cc[0] <= 'Z' && cc[1] >= 'A' && cc[1] <= 'Z'
}
func (c *Catalog) Update(device, path, epoch, country string, revision uint64, slots int, ready bool, now time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !validCountry(country) || epoch == "" || slots < 0 || slots > 2 {
		return errors.New("invalid readiness")
	}
	n := c.nodes[device]
	if n != nil && n.path == path && revision <= n.revision {
		return errors.New("stale readiness")
	}
	if n == nil || n.path != path || n.node.Epoch != epoch {
		n = &registration{path: path, reservations: map[string]*Ticket{}}
		c.nodes[device] = n
	}
	n.revision = revision
	n.node = Node{Device: device, Country: country, Epoch: epoch, Slots: slots, Expires: now.Add(PresenceTTL).UnixMilli()}
	if !ready {
		n.node.Slots = 0
	}
	c.publishLocked(now)
	return nil
}
func (c *Catalog) Remove(device, path string, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if n := c.nodes[device]; n != nil && n.path == path {
		delete(c.nodes, device)
		c.publishLocked(now)
	}
}
func (c *Catalog) Touch(device, path string, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if n := c.nodes[device]; n != nil && n.path == path {
		n.node.Expires = now.Add(PresenceTTL).UnixMilli()
	}
}
func (c *Catalog) expireLocked(now time.Time) bool {
	changed := false
	for d, n := range c.nodes {
		if n.node.Expires <= now.UnixMilli() {
			delete(c.nodes, d)
			changed = true
			continue
		}
		for id, t := range n.reservations {
			if t.Expires <= now.UnixMilli() {
				delete(n.reservations, id)
				changed = true
			}
		}
	}
	return changed
}
func (c *Catalog) snapshotLocked(now time.Time) message {
	m := message{Type: "snapshot", Revision: c.revision, Countries: []Country{}, Nodes: []Node{}}
	counts := map[string]int{}
	for _, n := range c.nodes {
		if n.node.Expires <= now.UnixMilli() || n.node.Slots <= len(n.reservations) {
			continue
		}
		row := n.node
		row.Slots -= len(n.reservations)
		m.Nodes = append(m.Nodes, row)
		counts[row.Country]++
	}
	sort.Slice(m.Nodes, func(i, j int) bool { return m.Nodes[i].Device < m.Nodes[j].Device })
	// MVP has a strict global 128-device admission cap, so snapshots stay bounded.
	for cc, n := range counts {
		m.Countries = append(m.Countries, Country{cc, n})
	}
	sort.Slice(m.Countries, func(i, j int) bool { return m.Countries[i].Code < m.Countries[j].Code })
	return m
}
func (c *Catalog) publishLocked(now time.Time) {
	c.revision++
	snapshot := c.snapshotLocked(now)
	for ch := range c.subscribers {
		select {
		case ch <- snapshot:
		default:
			delete(c.subscribers, ch)
			close(ch)
		}
	}
}

// Snapshot and subscription are installed under the same lock. No OFFLINE event
// can be lost between the initial snapshot and subsequent updates. Reconnects
// always get a fresh snapshot rather than assuming a stale journal cursor.
func (c *Catalog) Subscribe(now time.Time) (message, chan message, func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := make(chan message, 8)
	c.subscribers[ch] = struct{}{}
	return c.snapshotLocked(now), ch, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if _, ok := c.subscribers[ch]; ok {
			delete(c.subscribers, ch)
			close(ch)
		}
	}
}
func (c *Catalog) Sweep(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.expireLocked(now) {
		c.publishLocked(now)
	}
}
func (c *Catalog) Reserve(guest, country, id string, now time.Time) (Ticket, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.expireLocked(now)
	if len(id) != 48 {
		return Ticket{}, errors.New("invalid reservation ID")
	}
	for _, n := range c.nodes {
		if t := n.reservations[id]; t != nil {
			if t.Guest != guest {
				return Ticket{}, errors.New("reservation identity mismatch")
			}
			return *t, nil
		}
	}
	var chosen *registration
	for _, n := range c.nodes {
		if n.node.Device == guest || country != "" && n.node.Country != country || n.node.Slots <= len(n.reservations) {
			continue
		}
		if chosen == nil || len(n.reservations) < len(chosen.reservations) {
			chosen = n
		}
	}
	if chosen == nil {
		return Ticket{}, errors.New("selected country has no available exit")
	}
	t := Ticket{id, guest, chosen.node.Device, chosen.node.Epoch, chosen.node.Country, now.Add(ReservationTTL).UnixMilli()}
	chosen.reservations[id] = &t
	c.publishLocked(now)
	return t, nil
}
func (c *Catalog) Hold(t Ticket, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := c.nodes[t.Exit]
	if n == nil || n.node.Epoch != t.Epoch || n.node.Expires <= now.UnixMilli() {
		return false
	}
	saved := n.reservations[t.ID]
	if saved == nil || *saved != t || saved.Expires <= now.UnixMilli() {
		return false
	}
	// Admission handoff: active pair retains its slot until Close/lease expiry.
	saved.Expires = now.Add(60 * time.Second).UnixMilli()
	return true
}
func (c *Catalog) Release(t Ticket, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if n := c.nodes[t.Exit]; n != nil && n.node.Epoch == t.Epoch {
		delete(n.reservations, t.ID)
		c.publishLocked(now)
	}
}
func (c *Catalog) Renew(t Ticket, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := c.nodes[t.Exit]
	if n == nil || n.node.Epoch != t.Epoch || n.node.Country != t.Country || n.node.Slots == 0 || n.node.Expires <= now.UnixMilli() {
		return false
	}
	saved := n.reservations[t.ID]
	if saved == nil || saved.Guest != t.Guest || saved.Expires <= now.UnixMilli() {
		return false
	}
	saved.Expires = now.Add(time.Minute).UnixMilli()
	return true
}
