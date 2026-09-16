package socks

import (
	"context"
	"io"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"
)

// startEcho is a TCP target that echoes everything back.
func startEcho(t *testing.T) (string, int) {
	t.Helper()
	return startTarget(t, func(conn net.Conn) {
		io.Copy(conn, conn)
	})
}

// startHalfCloseTarget reads until the client half-closes and only then answers, so a reply proves the
// relay really propagated the half close instead of tearing the whole stream down.
func startHalfCloseTarget(t *testing.T) (string, int) {
	t.Helper()
	return startTarget(t, func(conn net.Conn) {
		io.Copy(io.Discard, conn)
		conn.Write([]byte("done"))
	})
}

// startSink accepts and then says nothing at all, to test the idle watchdog.
func startSink(t *testing.T) (string, int) {
	t.Helper()
	return startTarget(t, func(net.Conn) {})
}

func startTarget(t *testing.T, serve func(net.Conn)) (string, int) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("target listen: %v", err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				serve(conn)
			}()
		}
	}()
	t.Cleanup(func() { listener.Close() })
	host, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	return host, port
}

func startSocks(t *testing.T, dial DialFunc) *Server {
	t.Helper()
	server, err := Listen(0, dial)
	if err != nil {
		t.Fatalf("listen socks: %v", err)
	}
	t.Cleanup(func() { server.Close() })
	return server
}

// plainDialer connects straight to the target, standing in for a working data plane.
func plainDialer() DialFunc {
	return func(ctx context.Context, host string, port int) (Conn, error) {
		conn, err := net.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		if err != nil {
			return nil, err
		}
		return WrapConn(conn), nil
	}
}

type recorded struct {
	mu    sync.Mutex
	host  string
	port  int
	calls int
}

func (r *recorded) note(host string, port int) {
	r.mu.Lock()
	r.host, r.port, r.calls = host, port, r.calls+1
	r.mu.Unlock()
}

func (r *recorded) get() (string, int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.host, r.port, r.calls
}

// dummyConn stands in for a stream that opened but carries nothing.
type dummyConn struct{}

func (d *dummyConn) Read([]byte) (int, error)    { return 0, io.EOF }
func (d *dummyConn) Write(p []byte) (int, error) { return len(p), nil }
func (d *dummyConn) CloseWrite() error           { return nil }
func (d *dummyConn) Close() error                { return nil }

func dialSocks(t *testing.T, server *Server) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", server.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatalf("dial socks: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// greet performs the greeting handshake and fails if the server does not accept "no authentication".
func greet(t *testing.T, conn net.Conn) {
	t.Helper()
	if _, err := conn.Write([]byte{Version, 1, methodNone}); err != nil {
		t.Fatalf("greeting: %v", err)
	}
	reply := make([]byte, 2)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatalf("greeting reply: %v", err)
	}
	if reply[0] != Version || reply[1] != methodNone {
		t.Fatalf("greeting rejected: %v", reply)
	}
}

// readReply reads the fixed-size SOCKS reply.
func readReply(t *testing.T, conn net.Conn) []byte {
	t.Helper()
	reply := make([]byte, 10)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatalf("reply: %v", err)
	}
	return reply
}

// connectThrough runs the whole handshake against a 127.0.0.1 target and returns the reply code.
func connectThrough(t *testing.T, server *Server, cmd byte, host string, port int) (net.Conn, byte) {
	t.Helper()
	conn := dialSocks(t, server)
	greet(t, conn)
	if _, err := conn.Write(encodeRequest(cmd, host, port)); err != nil {
		t.Fatalf("request: %v", err)
	}
	return conn, readReply(t, conn)[1]
}

func encodeRequest(cmd byte, host string, port int) []byte {
	var addr []byte
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			addr = append([]byte{atypIPv4}, v4...)
		} else {
			addr = append([]byte{atypIPv6}, ip.To16()...)
		}
	} else {
		addr = append([]byte{atypDomain, byte(len(host))}, host...)
	}
	addr = append(addr, byte(port>>8), byte(port))
	return append([]byte{Version, cmd, 0x00}, addr...)
}

func TestConnectPipesBothWays(t *testing.T) {
	echoHost, echoPort := startEcho(t)
	server := startSocks(t, plainDialer())

	conn, code := connectThrough(t, server, cmdConnect, echoHost, echoPort)
	if code != replySuccess {
		t.Fatalf("expected success, got reply code %d", code)
	}
	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make([]byte, 5)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "hello" {
		t.Fatalf("echo mismatch: %q", got)
	}
}

// Bytes pipelined right after the request must not be lost: they are part of the stream.
func TestPipelinedPayloadIsForwarded(t *testing.T) {
	echoHost, echoPort := startEcho(t)
	server := startSocks(t, plainDialer())

	conn := dialSocks(t, server)
	greet(t, conn)
	payload := "pipelined"
	request := append(encodeRequest(cmdConnect, echoHost, echoPort), []byte(payload)...)
	if _, err := conn.Write(request); err != nil {
		t.Fatalf("write: %v", err)
	}
	if code := readReply(t, conn)[1]; code != replySuccess {
		t.Fatalf("expected success, got reply code %d", code)
	}
	got := make([]byte, len(payload))
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != payload {
		t.Fatalf("echo mismatch: %q", got)
	}
}

func TestHalfCloseReachesTheTarget(t *testing.T) {
	targetHost, targetPort := startHalfCloseTarget(t)
	server := startSocks(t, plainDialer())

	conn, code := connectThrough(t, server, cmdConnect, targetHost, targetPort)
	if code != replySuccess {
		t.Fatalf("expected success, got reply code %d", code)
	}
	if _, err := conn.Write([]byte("payload")); err != nil {
		t.Fatalf("write: %v", err)
	}
	half, ok := conn.(interface{ CloseWrite() error })
	if !ok {
		t.Fatal("the test client needs a half close")
	}
	if err := half.CloseWrite(); err != nil {
		t.Fatalf("half close: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	got, err := io.ReadAll(conn)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "done" {
		t.Fatalf("expected the target's answer after half close, got %q", got)
	}
}

// The success reply is the promise that the data plane is up: it must not arrive earlier.
func TestReplyWaitsForTheDataPlane(t *testing.T) {
	echoHost, echoPort := startEcho(t)
	release := make(chan struct{})
	server := startSocks(t, func(ctx context.Context, host string, port int) (Conn, error) {
		<-release
		conn, err := net.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		if err != nil {
			return nil, err
		}
		return WrapConn(conn), nil
	})

	conn := dialSocks(t, server)
	greet(t, conn)
	if _, err := conn.Write(encodeRequest(cmdConnect, echoHost, echoPort)); err != nil {
		t.Fatalf("request: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if n, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatalf("the reply arrived before the stream was open (%d bytes)", n)
	}
	close(release)
	if code := readReply(t, conn)[1]; code != replySuccess {
		t.Fatalf("expected success after the stream opened, got reply code %d", code)
	}
}

func TestGreetingRefusesAnUnknownMethod(t *testing.T) {
	server := startSocks(t, plainDialer())
	conn := dialSocks(t, server)

	if _, err := conn.Write([]byte{Version, 1, 0x02}); err != nil {
		t.Fatalf("greeting: %v", err)
	}
	reply := make([]byte, 2)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatalf("greeting reply: %v", err)
	}
	if reply[0] != Version || reply[1] != methodUnacceptable {
		t.Fatalf("expected method rejection, got %v", reply)
	}
}

func TestMalformedGreetingIsDropped(t *testing.T) {
	for name, greeting := range map[string][]byte{
		"wrong version": {4, 1, 0},
		"no methods":    {Version, 0},
	} {
		t.Run(name, func(t *testing.T) {
			server := startSocks(t, plainDialer())
			conn := dialSocks(t, server)
			if _, err := conn.Write(greeting); err != nil {
				t.Fatalf("greeting: %v", err)
			}
			conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			if n, err := conn.Read(make([]byte, 1)); err == nil {
				t.Fatalf("expected the connection to be dropped, got %d bytes", n)
			}
		})
	}
}

func TestBindAndUdpAssociateAreRefused(t *testing.T) {
	echoHost, echoPort := startEcho(t)
	server := startSocks(t, plainDialer())

	for _, cmd := range []byte{cmdBind, cmdUDPAssociate} {
		_, code := connectThrough(t, server, cmd, echoHost, echoPort)
		if code != replyCmdUnsupported {
			t.Errorf("command %d: expected reply code %d, got %d", cmd, replyCmdUnsupported, code)
		}
	}
}

func TestUnsupportedAddressTypeIsRefused(t *testing.T) {
	server := startSocks(t, plainDialer())
	conn := dialSocks(t, server)
	greet(t, conn)

	request := []byte{Version, cmdConnect, 0x00, 0x05, 0, 0, 0, 0, 0, 0}
	if _, err := conn.Write(request); err != nil {
		t.Fatalf("request: %v", err)
	}
	if code := readReply(t, conn)[1]; code != replyAtypUnsupported {
		t.Fatalf("expected reply code %d, got %d", replyAtypUnsupported, code)
	}
}

func TestPortZeroIsRefused(t *testing.T) {
	server := startSocks(t, plainDialer())
	_, code := connectThrough(t, server, cmdConnect, "127.0.0.1", 0)
	if code != replyGeneralFailure {
		t.Fatalf("expected reply code %d, got %d", replyGeneralFailure, code)
	}
}

func TestDialFailureIsReportedAsRefused(t *testing.T) {
	server := startSocks(t, func(context.Context, string, int) (Conn, error) {
		return nil, io.ErrUnexpectedEOF
	})
	_, code := connectThrough(t, server, cmdConnect, "example.test", 443)
	if code != replyRefused {
		t.Fatalf("expected reply code %d, got %d", replyRefused, code)
	}
}

// A domain name must reach the data plane unresolved: the phone resolves it on the exit side.
func TestDomainNameReachesTheDialer(t *testing.T) {
	rec := &recorded{}
	server := startSocks(t, func(ctx context.Context, host string, port int) (Conn, error) {
		rec.note(host, port)
		return &dummyConn{}, nil
	})
	if _, code := connectThrough(t, server, cmdConnect, "example.test", 8443); code != replySuccess {
		t.Fatalf("expected success, got reply code %d", code)
	}
	host, port, calls := rec.get()
	if calls != 1 || host != "example.test" || port != 8443 {
		t.Fatalf("dialer saw %d calls to %s:%d", calls, host, port)
	}
}

func TestIPv6TargetIsExpandedLikeTheNodeClient(t *testing.T) {
	rec := &recorded{}
	server := startSocks(t, func(ctx context.Context, host string, port int) (Conn, error) {
		rec.note(host, port)
		return &dummyConn{}, nil
	})
	if _, code := connectThrough(t, server, cmdConnect, "::1", 443); code != replySuccess {
		t.Fatalf("expected success, got reply code %d", code)
	}
	host, _, _ := rec.get()
	if host != "0:0:0:0:0:0:0:1" {
		t.Fatalf("expected the Node rendering of ::1, got %q", host)
	}
}

// The request may arrive in arbitrarily small pieces; that must not confuse the parser.
func TestRequestReadInParts(t *testing.T) {
	echoHost, echoPort := startEcho(t)
	server := startSocks(t, plainDialer())

	conn := dialSocks(t, server)
	for _, b := range []byte{Version, 1, methodNone} {
		conn.Write([]byte{b})
		time.Sleep(2 * time.Millisecond)
	}
	reply := make([]byte, 2)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatalf("greeting reply: %v", err)
	}
	for _, b := range encodeRequest(cmdConnect, echoHost, echoPort) {
		conn.Write([]byte{b})
		time.Sleep(2 * time.Millisecond)
	}
	if code := readReply(t, conn)[1]; code != replySuccess {
		t.Fatalf("expected success, got reply code %d", code)
	}
}

func TestSilentClientIsDropped(t *testing.T) {
	restore := RequestTimeout
	RequestTimeout = 200 * time.Millisecond
	t.Cleanup(func() { RequestTimeout = restore })

	server := startSocks(t, plainDialer())
	conn := dialSocks(t, server)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	started := time.Now()
	if n, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatalf("expected a silent client to be dropped, got %d bytes", n)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("the silent client was held for %v", elapsed)
	}
}

func TestIdleTunnelIsClosed(t *testing.T) {
	restore := IdleTimeout
	IdleTimeout = 200 * time.Millisecond
	t.Cleanup(func() { IdleTimeout = restore })

	targetHost, targetPort := startSink(t)
	server := startSocks(t, plainDialer())

	conn, code := connectThrough(t, server, cmdConnect, targetHost, targetPort)
	if code != replySuccess {
		t.Fatalf("expected success, got reply code %d", code)
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if n, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatalf("expected the idle tunnel to be closed, got %d bytes", n)
	}
}

func TestListenerIsLoopbackOnly(t *testing.T) {
	server := startSocks(t, plainDialer())
	addr, ok := server.Addr().(*net.TCPAddr)
	if !ok || !addr.IP.IsLoopback() {
		t.Fatalf("the listener must be on loopback, got %v", server.Addr())
	}
	for host, want := range map[string]bool{
		"127.0.0.1": true,
		"::1":       true,
		"localhost": true,
		"10.0.0.1":  false,
		"0.0.0.0":   false,
		"":          false,
	} {
		if got := isLoopbackHost(host); got != want {
			t.Errorf("isLoopbackHost(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestCloseStopsTheListener(t *testing.T) {
	server := startSocks(t, plainDialer())
	addr := server.Addr().String()
	if err := server.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err == nil {
		conn.Close()
		t.Fatal("a closed server must not accept connections")
	}
}
