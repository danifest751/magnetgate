package nostr

import (
	"context"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// The hybrid exists for one measured situation: on a carrier network every public relay completed the
// WebSocket handshake and then carried nothing back, while the same relays served offers through the
// tunnel in the same minute. These tests stand in for that by making the direct road useless and the
// fallback the only one that works.

// blockedListener is the direct road on such a network: it accepts the connection and then says nothing.
// A listener that refused outright would be a weaker stand-in - refusing is easy to notice, and the
// failure being handled here is the one that looks like success.
func blockedListener(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	done := make(chan struct{})
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				<-done
				conn.Close()
			}()
		}
	}()
	t.Cleanup(func() {
		close(done)
		listener.Close()
	})
	return listener.Addr().String()
}

// A relay that is mute on the direct road has to end up reached through the fallback, or hy2 and the
// rule-set manifest never arrive at all.
func TestFallbackCarriesTheChannelWhenTheDirectRoadIsMute(t *testing.T) {
	_, realURL := startRelay(t, func(conn *websocket.Conn, request string, attempt int) {
		conn.WriteMessage(websocket.TextMessage, []byte(`["EOSE","mgt0"]`))
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	realAddr := strings.TrimPrefix(realURL, "ws://")

	var mu sync.Mutex
	viaFallback := 0
	channel, err := New(Config{
		PSK:    testPSK,
		Relays: []string{"ws://" + blockedListener(t)},
		// short on purpose: the direct attempt here hangs in the handshake, and the default eight seconds
		// would make this test measure the timeout rather than the rerouting
		DialTimeout: 300 * time.Millisecond,
		Backoff:     10 * time.Millisecond, MaxBackoff: 20 * time.Millisecond,
		ReplyTimeout: 200 * time.Millisecond, ReadTimeout: 400 * time.Millisecond,
		PingInterval: 100 * time.Millisecond,
		Fallback: func(ctx context.Context, network, address string) (net.Conn, error) {
			mu.Lock()
			viaFallback++
			mu.Unlock()
			// the fallback stands for the tunnel: it reaches the relay the direct road could not
			return net.Dial("tcp", realAddr)
		},
	})
	if err != nil {
		t.Fatalf("channel: %v", err)
	}
	t.Cleanup(channel.Close)

	if err := channel.Watch(0, func([]byte, string) {}); err != nil {
		t.Fatalf("watch: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := channel.WaitServing(ctx); err != nil {
		t.Fatalf("the channel never started serving through the fallback: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if viaFallback == 0 {
		t.Fatal("the fallback was never dialled, so this proves nothing about the mute road")
	}
}

// Without a fallback nothing changes: the channel must not invent a road it was not given.
func TestWithoutAFallbackTheChannelStaysDirect(t *testing.T) {
	channel := muteTestChannel(t, nil, "ws://"+blockedListener(t))
	if err := channel.Watch(0, func([]byte, string) {}); err != nil {
		t.Fatalf("watch: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := channel.WaitServing(ctx); err == nil {
		t.Fatal("a mute relay with no fallback must not report as serving")
	}
}

// A relay that works directly must stay on the direct road: the fallback costs an exit and shows that
// exit which relays this client talks to, so it is not a road to wander onto.
func TestAWorkingRelayNeverTakesTheFallback(t *testing.T) {
	_, url := startRelay(t, func(conn *websocket.Conn, request string, attempt int) {
		conn.WriteMessage(websocket.TextMessage, []byte(`["EOSE","mgt0"]`))
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})

	var mu sync.Mutex
	viaFallback := 0
	channel, err := New(Config{
		PSK:         testPSK,
		Relays:      []string{url},
		DialTimeout: 300 * time.Millisecond,
		Backoff:     10 * time.Millisecond, MaxBackoff: 20 * time.Millisecond,
		ReplyTimeout: 200 * time.Millisecond, ReadTimeout: time.Second,
		PingInterval: 200 * time.Millisecond,
		Fallback: func(ctx context.Context, network, address string) (net.Conn, error) {
			mu.Lock()
			viaFallback++
			mu.Unlock()
			return nil, net.ErrClosed
		},
	})
	if err != nil {
		t.Fatalf("channel: %v", err)
	}
	t.Cleanup(channel.Close)
	if err := channel.Watch(0, func([]byte, string) {}); err != nil {
		t.Fatalf("watch: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := channel.WaitServing(ctx); err != nil {
		t.Fatalf("the working relay never answered: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if viaFallback != 0 {
		t.Fatalf("a relay that answers directly was sent through the fallback %d time(s)", viaFallback)
	}
}

// The fallback is not taken before there is an exit to take it through. Without this the channel spends
// every other attempt learning that the data plane is empty, which on a network where the direct road
// works halves how often that road is tried.
func TestTheFallbackIsNotTakenBeforeAnExitExists(t *testing.T) {
	var mu sync.Mutex
	dialled := 0
	channel, err := New(Config{
		PSK:         testPSK,
		Relays:      []string{"ws://" + blockedListener(t)},
		DialTimeout: 200 * time.Millisecond,
		Backoff:     10 * time.Millisecond, MaxBackoff: 20 * time.Millisecond,
		ReplyTimeout: 150 * time.Millisecond, ReadTimeout: 300 * time.Millisecond,
		PingInterval: 100 * time.Millisecond,
		Fallback: func(ctx context.Context, network, address string) (net.Conn, error) {
			mu.Lock()
			dialled++
			mu.Unlock()
			return nil, net.ErrClosed
		},
		FallbackReady: func() bool { return false },
	})
	if err != nil {
		t.Fatalf("channel: %v", err)
	}
	t.Cleanup(channel.Close)
	if err := channel.Watch(0, func([]byte, string) {}); err != nil {
		t.Fatalf("watch: %v", err)
	}
	time.Sleep(time.Second)
	mu.Lock()
	defer mu.Unlock()
	if dialled != 0 {
		t.Fatalf("the fallback was dialled %d time(s) while no exit existed", dialled)
	}
}
