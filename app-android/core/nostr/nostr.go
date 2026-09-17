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
	"net"
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
	// ReplyTimeout is how long a relay may stay silent after it has been sent a subscription. A relay
	// that accepts the socket and answers nothing is the failure this client meets on a mobile network,
	// and without a deadline it looks exactly like a relay with nothing to serve.
	ReplyTimeout time.Duration
	// ReadTimeout is how long an answering relay may stay quiet before the connection is rebuilt, and
	// PingInterval is how often it is pinged to keep that window open.
	ReadTimeout  time.Duration
	PingInterval time.Duration
	// UserAgent goes out with the upgrade. gorilla sends none, and an edge in front of a relay refuses
	// a header-less upgrade often enough to matter.
	UserAgent string
	// Fallback dials a relay through the data plane, and is tried only after a direct attempt failed to
	// get an answer. It exists because a mobile network can let the handshake through and carry nothing
	// back: measured on a phone, all three public relays went mute on the carrier and all three served
	// offers through the tunnel in the same minute. The offers that ride this channel - hy2 and the
	// rule-set manifest - are otherwise simply lost.
	//
	// It is a fallback rather than the normal route on purpose: rendezvous that goes through an exit
	// depends on an exit already working, and lets that exit see which relays this client talks to.
	// On a network where the direct path works, nothing takes this road.
	Fallback func(ctx context.Context, network, addr string) (net.Conn, error)
	// FallbackReady says whether that road exists yet. Without it the channel would spend every other
	// attempt discovering that no exit has been found, which on a network where the direct road works
	// halves how often it is tried - a fallback that slows down the path it is meant to back up.
	FallbackReady func() bool
	Logf          func(format string, args ...any)
}

// DefaultUserAgent names this client to a relay. It is not a disguise: the point is only that the
// header is there at all.
const DefaultUserAgent = "magnetgate/1.0"

// RelayState is what one relay is doing, which is what separates "nothing was published" from "this
// network does not let this relay through".
type RelayState struct {
	URL       string `json:"url"`
	Connected bool   `json:"connected"`
	Answering bool   `json:"answering"`
	LastError string `json:"lastError,omitempty"`
}

// Channel is one subscriber across a set of relays.
type Channel struct {
	cfg          Config
	logf         func(string, ...any)
	publicKeyHex string

	// serving is raised by whichever relay answers first; it is buffered so a relay never blocks on it
	serving chan struct{}

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
	if cfg.ReplyTimeout <= 0 {
		cfg.ReplyTimeout = 15 * time.Second
	}
	if cfg.PingInterval <= 0 {
		cfg.PingInterval = 30 * time.Second
	}
	if cfg.ReadTimeout <= 0 {
		// two missed pings: long enough that a slow network is not mistaken for a dead one
		cfg.ReadTimeout = 2*cfg.PingInterval + 15*time.Second
	}
	if cfg.UserAgent == "" {
		cfg.UserAgent = DefaultUserAgent
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	c := &Channel{
		cfg:          cfg,
		logf:         cfg.Logf,
		publicKeyHex: publicKeyHex,
		slots:        make(map[int]*watch),
		serving:      make(chan struct{}, 1),
	}
	for _, url := range cfg.Relays {
		r := &relay{
			url:     url,
			cfg:     cfg,
			logf:    cfg.Logf,
			onEvent: c.dispatch,
			subs:    make(map[string]string),
			done:    make(chan struct{}),
			serving: c.serving,
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
	sent := 0
	for _, r := range relays {
		if r.subscribe(subID(slot), request) {
			sent++
		}
	}
	// "subscribed on N relays" used to be printed whether or not a single socket was up, so a channel
	// that reached nothing read exactly like one that was waiting for an offer. Say what went out.
	c.logf("nostr: slot %d: subscription sent to %d of %d relay(s), queued for the rest", slot, sent, len(relays))
	return nil
}

// RelayCount is how many relays the channel is subscribed across.
func (c *Channel) RelayCount() int { return len(c.relays) }

// State reports what every relay is doing, so a caller can show why no offer has arrived.
func (c *Channel) State() []RelayState {
	c.mu.Lock()
	relays := append([]*relay(nil), c.relays...)
	c.mu.Unlock()
	out := make([]RelayState, 0, len(relays))
	for _, r := range relays {
		out = append(out, r.state())
	}
	return out
}

// Answering is how many relays have answered a subscription. Zero with relays configured means this
// network is not carrying the channel, whatever the nodes have published.
func (c *Channel) Answering() int {
	count := 0
	for _, state := range c.State() {
		if state.Answering {
			count++
		}
	}
	return count
}

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

// WaitServing blocks until some relay has answered a subscription, or the context ends. A caller that
// wants to know whether the channel is usable before reporting "nothing found" uses this.
//
// It waits on an answer rather than on a connected socket on purpose: a socket that opens and then
// carries nothing back is the failure seen on a mobile network, and it would satisfy any weaker test.
// (The loop this replaced waited on whichever relay happened to be last in the list, so two working
// relays behind one dead one counted for nothing — a single-relay test could not see it.)
func (c *Channel) WaitServing(ctx context.Context) error {
	if c.Answering() > 0 {
		return nil
	}
	select {
	case <-c.serving:
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
