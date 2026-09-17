package nostr

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// muteRelay accepts the upgrade, reads whatever is sent and then answers nothing at all. This is the
// failure measured on a real phone: on the carrier network every public relay completed the WebSocket
// handshake, took the subscription and never sent a byte back. Before this was treated as a failure it
// was indistinguishable from a relay with nothing to serve, which is why the channel reported itself
// healthy for a day while delivering no offers.
func startMuteRelay(t *testing.T) (string, *sync.WaitGroup) {
	t.Helper()
	var accepted sync.WaitGroup
	accepted.Add(1)
	var once sync.Once
	var upgrader websocket.Upgrader
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		once.Do(accepted.Done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				conn.Close()
				return
			}
		}
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http"), &accepted
}

func muteTestChannel(t *testing.T, logf func(string, ...any), relays ...string) *Channel {
	t.Helper()
	channel, err := New(Config{
		PSK: testPSK, Relays: relays,
		Backoff: 10 * time.Millisecond, MaxBackoff: 20 * time.Millisecond,
		ReplyTimeout: 200 * time.Millisecond, ReadTimeout: 200 * time.Millisecond,
		PingInterval: 50 * time.Millisecond,
		Logf:         logf,
	})
	if err != nil {
		t.Fatalf("channel: %v", err)
	}
	t.Cleanup(channel.Close)
	return channel
}

// A relay that connects and stays silent must not pass for a working one.
func TestARelayThatAnswersNothingIsNotServing(t *testing.T) {
	url, accepted := startMuteRelay(t)
	var mu sync.Mutex
	var lines []string
	channel := muteTestChannel(t, func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		lines = append(lines, fmt.Sprintf(format, args...))
	}, url)

	if err := channel.Watch(0, func([]byte, string) {}); err != nil {
		t.Fatalf("watch: %v", err)
	}
	accepted.Wait()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := channel.WaitServing(ctx); err == nil {
		t.Fatal("a relay that answers nothing must not report as serving")
	}
	if got := channel.Answering(); got != 0 {
		t.Fatalf("answering relays: %d, want 0", got)
	}

	// and the reason has to reach the log, because the silence itself never will
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		joined := strings.Join(lines, "\n")
		mu.Unlock()
		if strings.Contains(joined, "answered no subscription") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	t.Fatalf("the log never said why nothing arrived; it said:\n%s", strings.Join(lines, "\n"))
}

// The regression that hid the bug above: WaitConnected looped over the relays and kept only the last
// one's signal, so a working relay anywhere but the end of the list counted for nothing. A test with a
// single relay cannot see that, which is why this one uses two.
func TestWaitServingAcceptsAnyRelayNotOnlyTheLast(t *testing.T) {
	_, url := startRelay(t, func(conn *websocket.Conn, request string, attempt int) {
		conn.WriteMessage(websocket.TextMessage, []byte(`["EOSE","mgt0"]`))
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	mute, _ := startMuteRelay(t)

	for _, order := range [][]string{{url, mute}, {mute, url}} {
		channel := muteTestChannel(t, nil, order...)
		if err := channel.Watch(0, func([]byte, string) {}); err != nil {
			t.Fatalf("watch: %v", err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		err := channel.WaitServing(ctx)
		cancel()
		if err != nil {
			t.Fatalf("relays %v: a working relay was not noticed: %v", order, err)
		}
	}
}

// An edge that refuses the upgrade says why in the status line; gorilla drops it from the error, and
// "bad handshake" on its own is what sent a previous session looking at the wrong half of the system.
func TestARefusedUpgradeReportsItsStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)

	var mu sync.Mutex
	var lines []string
	channel := muteTestChannel(t, func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		lines = append(lines, fmt.Sprintf(format, args...))
	}, "ws"+strings.TrimPrefix(server.URL, "http"))
	if err := channel.Watch(0, func([]byte, string) {}); err != nil {
		t.Fatalf("watch: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		joined := strings.Join(lines, "\n")
		mu.Unlock()
		if strings.Contains(joined, "503") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	t.Fatalf("the refusal status never reached the log; it said:\n%s", strings.Join(lines, "\n"))
}

// The upgrade carries a User-Agent. gorilla sends none, and a relay behind an edge answered a
// header-less upgrade with 503 two times out of three when measured from the phone.
func TestTheUpgradeCarriesAUserAgent(t *testing.T) {
	seen := make(chan string, 1)
	var upgrader websocket.Upgrader
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case seen <- r.Header.Get("User-Agent"):
		default:
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn.Close()
	}))
	t.Cleanup(server.Close)

	muteTestChannel(t, nil, "ws"+strings.TrimPrefix(server.URL, "http"))
	select {
	case agent := <-seen:
		if agent == "" {
			t.Fatal("the upgrade went out with no User-Agent")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the relay was never dialled")
	}
}
