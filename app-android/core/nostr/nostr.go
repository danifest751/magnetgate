// Package nostr is the second rendezvous channel: a NIP-01 subscriber for the parameterized replaceable
// events the exits publish (kind 30078).
//
// The channel only has to deliver bytes. Authenticity and confidentiality come from the same sealed
// envelope as the DHT path — the offer is sealed under the slot's box key with its sequence as the
// domain — so a relay, or a relay that ignores the author filter, cannot inject an offer: it would have
// to produce a MAC it cannot compute. The BIP-340 signature and the author, `d` and kind are checked as
// well, but only to drop relay garbage before it reaches the envelope.
//
// Unlike the DHT channel this one is push: a relay stores the latest event and serves it to a new
// subscriber immediately, which is why the same offer shows up here without waiting for a republish.
package nostr

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"

	"magnetgate/core/proto"
)

// Kind is the NIP-78 application-specific data event the exits publish.
const Kind = 30078

// The tag carrying the sequence, which is used verbatim as the seal domain: the exit publishes the
// Nostr offer under "n"+seq, a nonce space disjoint from the DHT's numeric one.
const seqTagName = "mgt-seq"

var seqPattern = regexp.MustCompile(`^n?[0-9]{1,16}$`)

// Config is what a subscriber needs.
type Config struct {
	PSK    string
	Relays []string
	// DialTimeout bounds one connection attempt; Backoff is the first retry delay and doubles up to
	// MaxBackoff, so a relay that is down is retried without hammering it.
	DialTimeout time.Duration
	Backoff     time.Duration
	MaxBackoff  time.Duration
	Logf        func(format string, args ...any)
}

// Channel is one subscriber across a set of relays.
type Channel struct {
	cfg          Config
	logf         func(string, ...any)
	publicKeyHex string

	mu     sync.Mutex
	slots  map[int]*watch
	relays []*relay
	closed bool
}

type watch struct {
	tag     string
	boxKey  [32]byte
	onOffer func(plain []byte, seq string)
}

// New derives the channel identity and starts connecting to the relays. A relay is dialled in the
// background: a subscription made before the socket is up is sent as soon as it is, and re-sent after
// every reconnect.
func New(cfg Config) (*Channel, error) {
	if cfg.PSK == "" {
		return nil, errors.New("nostr: no PSK")
	}
	if len(cfg.Relays) == 0 {
		return nil, errors.New("nostr: no relays")
	}
	_, publicKeyHex, err := proto.NostrKeys(cfg.PSK)
	if err != nil {
		return nil, err
	}
	if cfg.DialTimeout <= 0 {
		cfg.DialTimeout = 8 * time.Second
	}
	if cfg.Backoff <= 0 {
		cfg.Backoff = time.Second
	}
	if cfg.MaxBackoff <= 0 {
		cfg.MaxBackoff = 30 * time.Second
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	c := &Channel{cfg: cfg, logf: cfg.Logf, publicKeyHex: publicKeyHex, slots: make(map[int]*watch)}
	for _, url := range cfg.Relays {
		r := &relay{
			url:       url,
			cfg:       cfg,
			logf:      cfg.Logf,
			onEvent:   c.dispatch,
			subs:      make(map[string]string),
			done:      make(chan struct{}),
			connected: make(chan struct{}, 1),
		}
		c.relays = append(c.relays, r)
		go r.run()
	}
	return c, nil
}

// Watch subscribes to one slot. Calling it again for the same slot replaces the handler; the
// subscription itself is re-sent, so a caller can update what it wants to do with the offers.
func (c *Channel) Watch(slot int, onOffer func(plain []byte, seq string)) error {
	if err := proto.ValidSlot(slot); err != nil {
		return err
	}
	tag, err := proto.NostrTagOf(c.cfg.PSK, slot)
	if err != nil {
		return err
	}
	boxKey, err := proto.SlotBoxKey(c.cfg.PSK, slot)
	if err != nil {
		return err
	}

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return errors.New("nostr: channel is closed")
	}
	c.slots[slot] = &watch{tag: tag, boxKey: boxKey, onOffer: onOffer}
	relays := append([]*relay(nil), c.relays...)
	c.mu.Unlock()

	request := requestJSON(subID(slot), c.publicKeyHex, tag)
	for _, r := range relays {
		r.subscribe(subID(slot), request)
	}
	c.logf("nostr: subscribed for slot %d on %d relay(s)", slot, len(relays))
	return nil
}

// RelayCount is how many relays the channel is subscribed across.
func (c *Channel) RelayCount() int { return len(c.relays) }

// Close stops every relay.
func (c *Channel) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	relays := append([]*relay(nil), c.relays...)
	c.mu.Unlock()
	for _, r := range relays {
		r.close()
	}
}

// WaitConnected blocks until at least one relay is connected, or the context ends. A caller that wants
// to know whether the channel is usable before reporting "nothing found" uses this.
func (c *Channel) WaitConnected(ctx context.Context) error {
	connected := make(chan struct{}, 1)
	c.mu.Lock()
	for _, r := range c.relays {
		connected = r.connected
	}
	c.mu.Unlock()
	select {
	case <-connected:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *Channel) dispatch(subID string, ev event) {
	slot, ok := slotOfSubID(subID)
	if !ok {
		return
	}
	c.mu.Lock()
	w := c.slots[slot]
	c.mu.Unlock()
	if w == nil {
		return
	}
	if ev.Kind != Kind || ev.PubKey != c.publicKeyHex || tagOf(ev, "d") != w.tag {
		return
	}
	seq := tagOf(ev, seqTagName)
	if !seqPattern.MatchString(seq) {
		return
	}
	id, err := hex.DecodeString(ev.ID)
	if err != nil {
		return
	}
	sig, err := hex.DecodeString(ev.Sig)
	if err != nil {
		return
	}
	if !proto.NostrVerify(ev.PubKey, id, sig, signedData(ev)) {
		c.logf("nostr: slot %d: dropping an event whose signature does not verify", slot)
		return
	}
	sealed, err := base64.StdEncoding.DecodeString(ev.Content)
	if err != nil {
		return
	}
	plain := proto.Unseal(&w.boxKey, sealed, seq)
	if plain == nil {
		// the MAC is the real gate: a relay cannot forge this, and a genuine event cannot fail it
		c.logf("nostr: slot %d: envelope did not unseal at %q", slot, seq)
		return
	}
	w.onOffer(plain, seq)
}

// event is the subset of a NIP-01 event this channel needs.
type event struct {
	ID        string     `json:"id"`
	PubKey    string     `json:"pubkey"`
	CreatedAt int64      `json:"created_at"`
	Kind      int        `json:"kind"`
	Tags      [][]string `json:"tags"`
	Content   string     `json:"content"`
	Sig       string     `json:"sig"`
}

// signedData rebuilds the bytes the event id hashes and the signature covers, exactly as buildEvent()
// does in src/nostr.mjs: the compact JSON of [0, pubkey, created_at, kind, tags, content]. HTML
// escaping is off because the JS encoder does not escape <, > or &.
func signedData(ev event) []byte {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode([]any{0, ev.PubKey, ev.CreatedAt, ev.Kind, ev.Tags, ev.Content}); err != nil {
		return nil
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

func tagOf(ev event, name string) string {
	for _, tag := range ev.Tags {
		if len(tag) >= 2 && tag[0] == name {
			return tag[1]
		}
	}
	return ""
}

func subID(slot int) string { return fmt.Sprintf("mgt%d", slot) }

func slotOfSubID(id string) (int, bool) {
	if len(id) < 4 || id[:3] != "mgt" {
		return 0, false
	}
	slot := 0
	for _, digit := range id[3:] {
		if digit < '0' || digit > '9' {
			return 0, false
		}
		slot = slot*10 + int(digit-'0')
	}
	if err := proto.ValidSlot(slot); err != nil {
		return 0, false
	}
	return slot, true
}

// requestJSON builds the subscription: the author filter is what keeps a relay from sending us
// everyone else's events, and the `d` tag narrows it to this slot's replaceable event.
func requestJSON(id, publicKeyHex, dTag string) string {
	filter := map[string]any{
		"authors": []string{publicKeyHex},
		"kinds":   []int{Kind},
		"#d":      []string{dTag},
		"limit":   1,
	}
	encoded, err := json.Marshal([]any{"REQ", id, filter})
	if err != nil {
		return ""
	}
	return string(encoded)
}
