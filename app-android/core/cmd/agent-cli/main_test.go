package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"magnetgate/core/socks"
)

// TestCheckGoesThroughTheListener drives the harness's own SOCKS client against the core's SOCKS
// server: two independent implementations of RFC 1928, so a mistake on either side shows up here.
func TestCheckGoesThroughTheListener(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("through the tunnel"))
	}))
	defer target.Close()
	targetHost, targetPort, err := net.SplitHostPort(strings.TrimPrefix(target.URL, "http://"))
	if err != nil {
		t.Fatalf("target address: %v", err)
	}
	port, _ := strconv.Atoi(targetPort)

	var mu sync.Mutex
	var seenHost string
	var seenPort int
	server, err := socks.Listen(0, func(ctx context.Context, host string, port int) (socks.Conn, error) {
		mu.Lock()
		seenHost, seenPort = host, port
		mu.Unlock()
		conn, err := net.Dial("tcp", net.JoinHostPort(targetHost, targetPort))
		if err != nil {
			return nil, err
		}
		return socks.WrapConn(conn), nil
	})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// "localhost" is sent unresolved, so the domain address type is covered end to end
	if err := check(ctx, server.Addr().String(), "http://localhost:"+strconv.Itoa(port)+"/"); err != nil {
		t.Fatalf("check: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if seenHost != "localhost" || seenPort != port {
		t.Fatalf("the dialer saw %s:%d, want localhost:%d", seenHost, seenPort, port)
	}
}

func TestCheckReportsAFailedRequest(t *testing.T) {
	server, err := socks.Listen(0, func(context.Context, string, int) (socks.Conn, error) {
		return nil, errors.New("no data plane")
	})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := check(ctx, server.Addr().String(), "http://example.test/"); err == nil {
		t.Fatal("a refused request must be reported as a failure")
	}
}

func TestSplitHostPort(t *testing.T) {
	host, port, err := splitHostPort("203.0.113.7:49001")
	if err != nil || host != "203.0.113.7" || port != 49001 {
		t.Fatalf("got %q %d %v", host, port, err)
	}
	for _, bad := range []string{"", "host", "host:0", "host:70000", ":443"} {
		if _, _, err := splitHostPort(bad); err == nil {
			t.Errorf("%q must be rejected", bad)
		}
	}
}
