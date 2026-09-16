// Package agent is the rendezvous half of the client: it reads each slot's sealed offer, unseals it,
// merges what the two channels say about the same node and learns further slots a node advertises.
//
// It is deliberately transport-free. A single Getter (the DHT today, Nostr next to it) is injected, so
// the loop can be tested against sealed offers without a network, and the app can run the same code
// against a different channel.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"magnetgate/core/offer"
	"magnetgate/core/proto"
)

// DefaultFresh is how long a record counts as usable. It mirrors OFFER_TTL_MS in src/client.js: a node
// publishes every 60 s, so twelve minutes of silence means it is gone.
const DefaultFresh = 12 * time.Minute

// futureSkew is how far ahead of us an offer's timestamp may be before it is refused, matching the
// tolerance src/client.js applies (60000 ms).
const futureSkew = time.Minute

// Getter is one rendezvous channel: it reads the sealed offer published for (pk, salt).
type Getter interface {
	Get(ctx context.Context, pk [32]byte, salt []byte) ([]byte, int64, error)
}

// Record is one node as this client currently sees it.
type Record struct {
	Slot    int
	Seq     int64
	Node    string
	Country string
	Offer   *offer.Offer
	Seen    time.Time
}

// Endpoint is a native transport of a found node.
type Endpoint struct {
	Slot int
	Host string
	Port int
}

// Config is what an agent needs to run.
type Config struct {
	PSK      string
	Slots    []int
	Getter   Getter
	MaxSlots int
	Fresh    time.Duration
	Logf     func(format string, args ...any)
	Now      func() time.Time
}

// Agent polls the slots it knows and keeps the newest offer per slot.
type Agent struct {
	cfg  Config
	keys proto.Keys
	now  func() time.Time
	logf func(string, ...any)

	mu      sync.Mutex
	records map[int]*Record
	slots   map[int]bool
}

// New derives the keys and prepares the slot set. The first poll is the caller's job, so a caller that
// wants a different cadence can drive it.
func New(cfg Config) (*Agent, error) {
	if cfg.Getter == nil {
		return nil, errors.New("agent: no rendezvous channel")
	}
	if cfg.PSK == "" {
		return nil, errors.New("agent: no PSK")
	}
	keys, err := proto.DeriveKeys(cfg.PSK)
	if err != nil {
		return nil, err
	}
	if cfg.MaxSlots <= 0 {
		cfg.MaxSlots = proto.MaxSlots
	}
	if cfg.Fresh <= 0 {
		cfg.Fresh = DefaultFresh
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	a := &Agent{
		cfg:     cfg,
		keys:    keys,
		now:     cfg.Now,
		logf:    cfg.Logf,
		records: make(map[int]*Record),
		slots:   make(map[int]bool),
	}
	for _, slot := range cfg.Slots {
		if err := proto.ValidSlot(slot); err != nil {
			return nil, err
		}
		a.slots[slot] = true
	}
	return a, nil
}

// Slots lists the slots the agent knows about: the configured ones plus any learned from `peers`.
func (a *Agent) Slots() []int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return sortedSlots(a.slots)
}

// Records returns what is currently held, newest first per slot.
func (a *Agent) Records() []Record {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]Record, 0, len(a.records))
	for _, rec := range a.records {
		out = append(out, *rec)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Slot < out[j].Slot })
	return out
}

// Endpoints lists the native endpoints of fresh records, in slot order: the caller picks the first one
// it can actually reach, which is what makes a dead node fail over to the next.
func (a *Agent) Endpoints() []Endpoint {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []Endpoint
	for slot, rec := range a.records {
		if a.now().Sub(rec.Seen) > a.cfg.Fresh {
			continue
		}
		for _, raw := range rec.Offer.DP {
			if offer.TypeOf(raw) != "mgt" {
				continue
			}
			var entry struct {
				Host string `json:"host"`
				Port int    `json:"port"`
			}
			if err := json.Unmarshal(raw, &entry); err != nil || entry.Host == "" || entry.Port == 0 {
				continue
			}
			out = append(out, Endpoint{Slot: slot, Host: entry.Host, Port: entry.Port})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Slot < out[j].Slot })
	return out
}

// PollAll polls every known slot once. Slots are visited in order; a slot that is not published yet is
// not an error, it is the normal state before a node comes up.
func (a *Agent) PollAll(ctx context.Context) {
	for _, slot := range a.Slots() {
		_, err := a.Poll(ctx, slot)
		if err != nil && !errors.Is(err, ErrNotPublished) {
			a.logf("slot %d: %v", slot, err)
		}
	}
}

// ErrNotPublished is what a poll returns when the channel has nothing for that slot yet.
var ErrNotPublished = errors.New("agent: slot not published")

// Poll reads one slot, unseals the offer and folds it into the record held for that slot. Further slots
// a node advertises in `peers` are added to the agent.
func (a *Agent) Poll(ctx context.Context, slot int) (*Record, error) {
	if err := proto.ValidSlot(slot); err != nil {
		return nil, err
	}
	salt, err := proto.SlotSalt(a.cfg.PSK, slot)
	if err != nil {
		return nil, err
	}
	key, err := proto.SlotBoxKey(a.cfg.PSK, slot)
	if err != nil {
		return nil, err
	}
	value, seq, err := a.cfg.Getter.Get(ctx, a.keys.Pk, salt)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNotPublished, err)
	}
	// the sequence is the domain the envelope was sealed with, so a record and its seq travel together
	plain := proto.Unseal(&key, value, strconv.FormatInt(seq, 10))
	if plain == nil {
		return nil, fmt.Errorf("agent: slot %d: the envelope did not unseal at seq %d", slot, seq)
	}
	var incoming offer.Offer
	if err := json.Unmarshal(plain, &incoming); err != nil {
		return nil, fmt.Errorf("agent: slot %d: offer is not JSON: %w", slot, err)
	}
	if !incoming.Valid() {
		return nil, fmt.Errorf("agent: slot %d: offer is not usable (schema %d)", slot, incoming.V)
	}
	// Freshness comes from the offer's own timestamp, not from when we happened to read it: a record can
	// be correctly signed and still be a replay of a generation whose node is long gone, and only the
	// timestamp tells those apart. The Node client applies the same window, plus a minute of tolerance
	// for a node whose clock runs ahead (src/client.js: OFFER_TTL_MS).
	age := a.now().Sub(time.UnixMilli(incoming.TS))
	if age >= a.cfg.Fresh {
		return nil, fmt.Errorf("agent: slot %d: offer is stale (%s old)", slot, age.Round(time.Second))
	}
	if age < -futureSkew {
		return nil, fmt.Errorf("agent: slot %d: offer is dated %s in the future", slot, (-age).Round(time.Second))
	}
	// `peers` is read from the raw field and strictly: a null slot must never be read as slot 0
	var head struct {
		Peers json.RawMessage `json:"peers"`
	}
	_ = json.Unmarshal(plain, &head)
	peers, peerErr := offer.ParsePeers(head.Peers)

	a.mu.Lock()
	// Merge returns nil only for an unusable offer, which was just ruled out
	merged := offer.Merge(a.currentOffer(slot), &incoming)
	record := &Record{
		Slot:    slot,
		Seq:     seq,
		Node:    merged.Node,
		Country: merged.Country,
		Offer:   merged,
		Seen:    a.now(),
	}
	a.records[slot] = record
	var learned []int
	if peerErr == nil {
		learned = offer.NewPeerSlots(a.slotsLocked(), peers, a.cfg.MaxSlots)
		for _, slot := range learned {
			a.slots[slot] = true
		}
	}
	a.mu.Unlock()

	if peerErr != nil {
		a.logf("slot %d: ignoring a malformed peers list: %v", slot, peerErr)
	}
	for _, slot := range learned {
		a.logf("slot %d: discovered slot %d from peers", record.Slot, slot)
	}
	return record, nil
}

func (a *Agent) currentOffer(slot int) *offer.Offer {
	if rec := a.records[slot]; rec != nil {
		return rec.Offer
	}
	return nil
}

func (a *Agent) slotsLocked() []int {
	out := make([]int, 0, len(a.slots))
	for slot := range a.slots {
		out = append(out, slot)
	}
	return out
}

func sortedSlots(set map[int]bool) []int {
	out := make([]int, 0, len(set))
	for slot := range set {
		out = append(out, slot)
	}
	sort.Ints(out)
	return out
}
