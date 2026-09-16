package nostr

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/gorilla/websocket"

	"magnetgate/core/proto"
)

const testPSK = "nostr-test-psk"

// fakeRelay is a NIP-01 relay that does only what these tests need: accept a subscription and let the
// test decide what to send back.
type fakeRelay struct {
	mu       sync.Mutex
	upgrader websocket.Upgrader
	requests []string
	conns    []*websocket.Conn
}

func startRelay(t *testing.T, serve func(conn *websocket.Conn, request string, attempt int)) (*fakeRelay, string) {
	t.Helper()
	relay := &fakeRelay{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := relay.upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		relay.mu.Lock()
		relay.conns = append(relay.conns, conn)
		attempt := len(relay.conns)
		relay.mu.Unlock()

		// the first message a subscriber sends is its subscription
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		relay.mu.Lock()
		relay.requests = append(relay.requests, string(data))
		relay.mu.Unlock()

		if serve != nil {
			serve(conn, string(data), attempt)
		}
	}))
	t.Cleanup(func() {
		server.Close()
		relay.mu.Lock()
		for _, conn := range relay.conns {
			conn.Close()
		}
		relay.mu.Unlock()
	})
	return relay, "ws" + strings.TrimPrefix(server.URL, "http")
}

func (r *fakeRelay) subscriptionCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.requests)
}

// publish builds the event an exit sends: kind 30078, the slot's `d` tag, the sequence in `mgt-seq` and
// the sealed envelope in base64, signed with the channel identity.
//
// The layout is built here with the same helper the subscriber verifies with, so these tests cover the
// pipeline rather than the wire format; the stand, where the publisher is the real Node exit, is what
// pins the format itself.
func publish(t *testing.T, psk string, slot int, seqTag string, sealed []byte) []byte {
	t.Helper()
	sk, pkHex, err := proto.NostrKeys(psk)
	if err != nil {
		t.Fatalf("nostr keys: %v", err)
	}
	tag, err := proto.NostrTagOf(psk, slot)
	if err != nil {
		t.Fatalf("nostr tag: %v", err)
	}
	ev := event{
		PubKey:    pkHex,
		CreatedAt: time.Now().Unix(),
		Kind:      Kind,
		Tags:      [][]string{{"d", tag}, {seqTagName, seqTag}},
		Content:   base64.StdEncoding.EncodeToString(sealed),
	}
	sum := sha256.Sum256(signedData(ev))
	ev.ID = hex.EncodeToString(sum[:])
	private, _ := btcec.PrivKeyFromBytes(sk)
	signature, err := schnorr.Sign(private, sum[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	ev.Sig = hex.EncodeToString(signature.Serialize())

	message, err := json.Marshal([]any{"EVENT", subID(slot), ev})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return message
}

func sealOffer(t *testing.T, psk string, slot int, seqTag string, plain string) []byte {
	t.Helper()
	boxKey, err := proto.SlotBoxKey(psk, slot)
	if err != nil {
		t.Fatalf("box key: %v", err)
	}
	sealed, err := proto.Seal(&boxKey, []byte(plain), seqTag)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	return sealed
}

// collector records what the channel handed over.
type collector struct {
	mu    sync.Mutex
	plain []string
	seqs  []string
	got   chan struct{}
}

func newCollector() *collector { return &collector{got: make(chan struct{}, 16)} }

func (c *collector) offer(plain []byte, seq string) {
	c.mu.Lock()
	c.plain = append(c.plain, string(plain))
	c.seqs = append(c.seqs, seq)
	c.mu.Unlock()
	select {
	case c.got <- struct{}{}:
	default:
	}
}

func (c *collector) wait(t *testing.T, timeout time.Duration) bool {
	t.Helper()
	select {
	case <-c.got:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (c *collector) offers() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.plain...)
}

func (c *collector) sequences() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.seqs...)
}

func newTestChannel(t *testing.T, relays ...string) *Channel {
	t.Helper()
	channel, err := New(Config{PSK: testPSK, Relays: relays, Backoff: 10 * time.Millisecond, MaxBackoff: 50 * time.Millisecond})
	if err != nil {
		t.Fatalf("channel: %v", err)
	}
	t.Cleanup(channel.Close)
	return channel
}

// The whole point of the channel: an offer published for a slot arrives unsealed, with the sequence the
// envelope was sealed under.
func TestWatchDeliversAnUnsealedOffer(t *testing.T) {
	plain := `{"v":3,"ts":1,"slot":0,"node":"lab-a","dp":[{"t":"mgt","host":"127.0.0.1","port":29601}]}`
	sealed := sealOffer(t, testPSK, 0, "n7", plain)
	_, url := startRelay(t, func(conn *websocket.Conn, request string, _ int) {
		conn.WriteMessage(websocket.TextMessage, publish(t, testPSK, 0, "n7", sealed))
	})

	channel := newTestChannel(t, url)
	collector := newCollector()
	if err := channel.Watch(0, collector.offer); err != nil {
		t.Fatalf("watch: %v", err)
	}
	if !collector.wait(t, 5*time.Second) {
		t.Fatal("the offer was never handed over")
	}
	if got := collector.offers(); len(got) != 1 || got[0] != plain {
		t.Fatalf("offer: %q", got)
	}
	if got := collector.sequences(); len(got) != 1 || got[0] != "n7" {
		t.Fatalf("sequence: %q", got)
	}
}

// A relay forgets subscriptions when the socket drops, so the channel has to send them again; this is
// the difference between "nothing published" and "quietly unsubscribed".
func TestSubscriptionIsResentAfterAReconnect(t *testing.T) {
	plain := `{"v":3,"ts":1,"slot":0,"node":"lab-a","dp":[{"t":"mgt","host":"127.0.0.1","port":29601}]}`
	sealed := sealOffer(t, testPSK, 0, "n7", plain)
	relay, url := startRelay(t, func(conn *websocket.Conn, request string, attempt int) {
		if attempt == 1 {
			conn.Close() // drop the first connection after the subscription
			return
		}
		conn.WriteMessage(websocket.TextMessage, publish(t, testPSK, 0, "n7", sealed))
	})

	channel := newTestChannel(t, url)
	collector := newCollector()
	if err := channel.Watch(0, collector.offer); err != nil {
		t.Fatalf("watch: %v", err)
	}
	if !collector.wait(t, 5*time.Second) {
		t.Fatal("the offer never arrived after the reconnect")
	}
	if relay.subscriptionCount() < 2 {
		t.Fatalf("the subscription was not re-sent (saw %d)", relay.subscriptionCount())
	}
}

// Everything a relay can send that is not a genuine offer for this slot must be dropped: the envelope
// MAC is the gate, and the kind/author/d-tag/sequence checks only save work before it.
func TestGarbageIsDropped(t *testing.T) {
	plain := `{"v":3,"ts":1,"slot":0,"node":"lab-a","dp":[{"t":"mgt","host":"127.0.0.1","port":29601}]}`

	variants := map[string]func() []byte{
		"another author": func() []byte {
			return publish(t, "another-psk", 0, "n7", sealOffer(t, testPSK, 0, "n7", plain))
		},
		"another slot's tag": func() []byte {
			return publish(t, testPSK, 1, "n7", sealOffer(t, testPSK, 0, "n7", plain))
		},
		"a sequence that is not a number": func() []byte {
			return publish(t, testPSK, 0, "abc", sealOffer(t, testPSK, 0, "abc", plain))
		},
		"an absurdly long sequence": func() []byte {
			seq := "n" + strings.Repeat("9", 20)
			return publish(t, testPSK, 0, seq, sealOffer(t, testPSK, 0, seq, plain))
		},
		"content sealed for another sequence": func() []byte {
			return publish(t, testPSK, 0, "n7", sealOffer(t, testPSK, 0, "n8", plain))
		},
		"content sealed with another slot's key": func() []byte {
			return publish(t, testPSK, 0, "n7", sealOffer(t, testPSK, 1, "n7", plain))
		},
		"a tampered signature": func() []byte {
			message := publish(t, testPSK, 0, "n7", sealOffer(t, testPSK, 0, "n7", plain))
			var decoded []any
			if err := json.Unmarshal(message, &decoded); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			ev := decoded[2].(map[string]any)
			sig := ev["sig"].(string)
			flip := byte('0')
			if sig[0] == '0' {
				flip = '1'
			}
			ev["sig"] = string(flip) + sig[1:]
			// re-encoding with the whole event as-is keeps the id intact, so only the signature is wrong
			tampered, err := json.Marshal([]any{"EVENT", subID(0), ev})
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			return tampered
		},
		"content that is not base64": func() []byte {
			message := publish(t, testPSK, 0, "n7", sealOffer(t, testPSK, 0, "n7", plain))
			var decoded []any
			if err := json.Unmarshal(message, &decoded); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			ev := decoded[2].(map[string]any)
			ev["content"] = "!!! not base64 !!!"
			replaced, err := json.Marshal([]any{"EVENT", subID(0), ev})
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			return replaced
		},
	}

	for name, build := range variants {
		t.Run(name, func(t *testing.T) {
			message := build()
			_, url := startRelay(t, func(conn *websocket.Conn, request string, _ int) {
				conn.WriteMessage(websocket.TextMessage, message)
			})
			channel := newTestChannel(t, url)
			collector := newCollector()
			if err := channel.Watch(0, collector.offer); err != nil {
				t.Fatalf("watch: %v", err)
			}
			if collector.wait(t, 500*time.Millisecond) {
				t.Fatalf("an offer was accepted from %s: %q", name, collector.offers())
			}
		})
	}
}

func TestWatchRejectsAnInvalidSlot(t *testing.T) {
	_, url := startRelay(t, nil)
	channel := newTestChannel(t, url)
	if err := channel.Watch(proto.MaxSlots, func([]byte, string) {}); err == nil {
		t.Fatal("a slot out of range must be refused")
	}
}

func TestNewRequiresAPSKAndRelays(t *testing.T) {
	if _, err := New(Config{Relays: []string{"ws://127.0.0.1:1"}}); err == nil {
		t.Fatal("a channel without a PSK must not start")
	}
	if _, err := New(Config{PSK: testPSK}); err == nil {
		t.Fatal("a channel without relays must not start")
	}
}

// WaitConnected is how a caller tells "subscribed and quiet" from "not subscribed yet".
func TestWaitConnectedReportsAnUnreachableRelay(t *testing.T) {
	channel := newTestChannel(t, "ws://127.0.0.1:1")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := channel.WaitConnected(ctx); err == nil {
		t.Fatal("a relay that never connects must not report as connected")
	}
	if channel.RelayCount() != 1 {
		t.Fatalf("relay count: %d", channel.RelayCount())
	}
}
