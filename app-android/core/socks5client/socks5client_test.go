package socks5client

import (
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"magnetgate/core/socks"
)

// startEcho is a TCP target that echoes what it receives.
func startEcho(t *testing.T) (string, int) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				io.Copy(conn, conn)
			}()
		}
	}()
	t.Cleanup(func() { listener.Close() })
	host, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	return host, port
}

func plainDial(ctx context.Context, host string, port int) (socks.Conn, error) {
	conn, err := net.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	return socks.WrapConn(conn), nil
}

// startProxy runs the core's own SOCKS5 entry point in front of the target, so the client is checked
// against the server it will actually talk to.
func startProxy(t *testing.T, dial socks.DialFunc) string {
	t.Helper()
	server, err := socks.Listen(0, dial)
	if err != nil {
		t.Fatalf("listen proxy: %v", err)
	}
	t.Cleanup(func() { server.Close() })
	return server.Addr().String()
}

func TestDialReachesTheTarget(t *testing.T) {
	targetHost, targetPort := startEcho(t)
	proxy := startProxy(t, plainDial)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := Dial(ctx, proxy, targetHost, targetPort)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	payload := []byte("through the proxy")
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make([]byte, len(payload))
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("echo mismatch: %q", got)
	}
}

// A domain name must reach the proxy unresolved: resolving it locally would leak the target's name.
func TestDialSendsTheHostUnresolved(t *testing.T) {
	var seen string
	proxy := startProxy(t, func(ctx context.Context, host string, port int) (socks.Conn, error) {
		seen = host
		return nil, errors.New("not actually dialling")
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := Dial(ctx, proxy, "example.test", 443); err == nil {
		t.Fatal("a refused request must not report success")
	}
	if seen != "example.test" {
		t.Fatalf("the proxy saw %q, want the unresolved name", seen)
	}
}

func TestDialValidatesItsArguments(t *testing.T) {
	ctx := context.Background()
	if _, err := Dial(ctx, "127.0.0.1:1", "", 80); err == nil {
		t.Error("an empty host must be refused")
	}
	if _, err := Dial(ctx, "127.0.0.1:1", strings.Repeat("a", 300), 80); err == nil {
		t.Error("a host longer than 255 bytes must be refused")
	}
	if _, err := Dial(ctx, "127.0.0.1:1", "example.test", 70000); err == nil {
		t.Error("a port out of range must be refused")
	}
}

func TestDialReportsAProxyThatIsNotThere(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := Dial(ctx, "127.0.0.1:1", "example.test", 80); err == nil {
		t.Fatal("a proxy that refuses the connection must be reported")
	}
}

func TestDialContextSpeaksTheTransportInterface(t *testing.T) {
	targetHost, targetPort := startEcho(t)
	proxy := startProxy(t, plainDial)
	dial := DialContext(proxy)

	conn, err := dial(context.Background(), "tcp", net.JoinHostPort(targetHost, strconv.Itoa(targetPort)))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	conn.Close()

	if _, err := dial(context.Background(), "udp", "127.0.0.1:1"); err == nil {
		t.Fatal("a network other than tcp must be refused")
	}
	if _, err := dial(context.Background(), "tcp", "no-port"); err == nil {
		t.Fatal("an address without a port must be refused")
	}
}
