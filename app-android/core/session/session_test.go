package session

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"magnetgate/core/proto"
)

// The test exit is a minimal server speaking the same wire as src/exit-session.mjs: it answers the
// handshake, opens a TCP connection on OPEN and pipes bytes. It exists so the multiplexer can be tested
// end to end in Go; once the core runs against the real Node exit (milestone 3) this remains the fast,
// hermetic version of the same scenario.
type testExit struct {
	boxKey   *[32]byte
	listener net.Listener
	dialer   func(host string, port int) (net.Conn, error)
	mu       sync.Mutex
	opens    int
	lastOpen Target
}

func startTestExit(t *testing.T, boxKey *[32]byte, dialer func(string, int) (net.Conn, error)) *testExit {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	exit := &testExit{boxKey: boxKey, listener: listener, dialer: dialer}
	go exit.acceptLoop()
	t.Cleanup(func() { listener.Close() })
	return exit
}

func (e *testExit) addr() (string, int) {
	host, portText, _ := net.SplitHostPort(e.listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	return host, port
}

func (e *testExit) stats() (int, Target) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.opens, e.lastOpen
}

func (e *testExit) acceptLoop() {
	for {
		conn, err := e.listener.Accept()
		if err != nil {
			return
		}
		go e.handle(conn)
	}
}

func (e *testExit) handle(conn net.Conn) {
	defer conn.Close()

	header := make([]byte, 2)
	if _, err := io.ReadFull(conn, header); err != nil {
		return
	}
	msg1 := make([]byte, binary.BigEndian.Uint16(header))
	if _, err := io.ReadFull(conn, msg1); err != nil {
		return
	}
	msg2, keys, _, err := proto.ExitRespond(e.boxKey, msg1, time.Now())
	if err != nil {
		return
	}
	binary.BigEndian.PutUint16(header, uint16(len(msg2)))
	if _, err := conn.Write(append(header, msg2...)); err != nil {
		return
	}

	var writeMu sync.Mutex
	encoder := proto.NewFrameEncoder(&keys.E2C)
	send := func(typ byte, id uint32, plain []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		if frame, err := encoder.Encode(typ, id, plain); err == nil {
			conn.Write(frame)
		}
	}

	var upMu sync.Mutex
	upstreams := map[uint32]net.Conn{}
	closeUpstream := func(id uint32) net.Conn {
		upMu.Lock()
		defer upMu.Unlock()
		up := upstreams[id]
		delete(upstreams, id)
		return up
	}

	var decoder *proto.Decoder
	decoder = proto.NewDecoder(&keys.C2E, func(f proto.Frame) {
		switch f.Type {
		case proto.FrameOpen:
			var target Target
			if err := json.Unmarshal(f.Plain, &target); err != nil {
				send(proto.FrameClose, f.StreamID, nil)
				return
			}
			e.mu.Lock()
			e.opens++
			e.lastOpen = target
			e.mu.Unlock()
			up, err := e.dialer(target.Host, target.Port)
			if err != nil {
				send(proto.FrameClose, f.StreamID, nil)
				return
			}
			upMu.Lock()
			upstreams[f.StreamID] = up
			upMu.Unlock()
			send(proto.FrameOpenOK, f.StreamID, nil)
			go func(id uint32) {
				buf := make([]byte, 16*1024)
				for {
					n, err := up.Read(buf)
					if n > 0 {
						send(proto.FrameData, id, buf[:n])
					}
					if err != nil {
						send(proto.FrameEnd, id, nil)
						return
					}
				}
			}(f.StreamID)
		case proto.FrameData:
			upMu.Lock()
			up := upstreams[f.StreamID]
			upMu.Unlock()
			if up != nil {
				up.Write(f.Plain)
			}
		case proto.FrameEnd:
			upMu.Lock()
			up := upstreams[f.StreamID]
			upMu.Unlock()
			if up != nil {
				if tcp, ok := up.(*net.TCPConn); ok {
					tcp.CloseWrite()
				} else {
					up.Close()
				}
			}
		case proto.FrameClose:
			if up := closeUpstream(f.StreamID); up != nil {
				up.Close()
			}
			send(proto.FrameClose, f.StreamID, nil)
		case proto.FramePing:
			send(proto.FramePong, 0, nil)
		default:
			decoder.Kill()
		}
	}, func() {})

	for {
		buf := make([]byte, 16*1024)
		n, err := conn.Read(buf)
		if n > 0 {
			decoder.Push(buf[:n])
		}
		if err != nil {
			break
		}
	}
	upMu.Lock()
	for _, up := range upstreams {
		up.Close()
	}
	upMu.Unlock()
}

// startEchoTarget is a TCP server that echoes everything back.
func startEchoTarget(t *testing.T) (string, int) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("echo listen: %v", err)
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

func testBoxKey(t *testing.T) *[32]byte {
	t.Helper()
	keys, err := proto.DeriveKeys("session-test-psk")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	return &keys.BoxKey
}

func connectFor(t *testing.T, exit *testExit, boxKey *[32]byte) *Session {
	t.Helper()
	host, port := exit.addr()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := Connect(ctx, host, port, boxKey)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

func echoDialer() func(string, int) (net.Conn, error) {
	return func(host string, port int) (net.Conn, error) {
		return net.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	}
}

func TestStreamRoundTrip(t *testing.T) {
	boxKey := testBoxKey(t)
	echoHost, echoPort := startEchoTarget(t)
	exit := startTestExit(t, boxKey, echoDialer())
	s := connectFor(t, exit, boxKey)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream, err := s.OpenStream(ctx, Target{Host: echoHost, Port: echoPort})
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	defer stream.Close()

	// a payload far larger than one frame exercises fragmentation and reassembly
	payload := strings.Repeat("magnetgate-", 7000)
	if _, err := stream.Write([]byte(payload)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := stream.CloseWrite(); err != nil {
		t.Fatalf("half close: %v", err)
	}
	got, err := io.ReadAll(stream)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, []byte(payload)) {
		t.Fatalf("echo mismatch: got %d bytes, want %d", len(got), len(payload))
	}

	opens, lastOpen := exit.stats()
	if opens != 1 || lastOpen.Host != echoHost || lastOpen.Port != echoPort {
		t.Errorf("expected one open to %s:%d, got %d to %+v", echoHost, echoPort, opens, lastOpen)
	}
}

func TestConcurrentStreams(t *testing.T) {
	boxKey := testBoxKey(t)
	echoHost, echoPort := startEchoTarget(t)
	exit := startTestExit(t, boxKey, echoDialer())
	s := connectFor(t, exit, boxKey)

	const streams = 8
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	errs := make(chan error, streams)
	for i := 0; i < streams; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			st, err := s.OpenStream(ctx, Target{Host: echoHost, Port: echoPort})
			if err != nil {
				errs <- err
				return
			}
			defer st.Close()
			payload := strings.Repeat(strconv.Itoa(index), 2000)
			if _, err := st.Write([]byte(payload)); err != nil {
				errs <- err
				return
			}
			st.CloseWrite()
			got, err := io.ReadAll(st)
			if err != nil {
				errs <- err
				return
			}
			if !bytes.Equal(got, []byte(payload)) {
				errs <- errors.New("payload mismatch on a concurrent stream")
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent stream failed: %v", err)
	}
	if opens, _ := exit.stats(); opens != streams {
		t.Errorf("expected %d opens, got %d", streams, opens)
	}
}

// A refused upstream must reject the opener instead of leaving it waiting for OPEN_OK.
func TestOpenIsRejectedWhenTheExitCannotConnect(t *testing.T) {
	boxKey := testBoxKey(t)
	exit := startTestExit(t, boxKey, func(string, int) (net.Conn, error) {
		return nil, errors.New("connection refused")
	})
	s := connectFor(t, exit, boxKey)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := s.OpenStream(ctx, Target{Host: "203.0.113.1", Port: 9}); err == nil {
		t.Fatal("opening a stream the exit cannot serve must fail")
	}
}

// A wrong PSK must be refused at the handshake, not accepted and then fail on the first frame.
func TestHandshakeRequiresTheSamePSK(t *testing.T) {
	boxKey := testBoxKey(t)
	exit := startTestExit(t, boxKey, echoDialer())
	other, err := proto.DeriveKeys("a-different-psk")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	host, port := exit.addr()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := Connect(ctx, host, port, &other.BoxKey); err == nil {
		t.Fatal("a session with the wrong PSK must not be established")
	}
}

func TestClosedSessionRefusesNewStreams(t *testing.T) {
	boxKey := testBoxKey(t)
	exit := startTestExit(t, boxKey, echoDialer())
	s := connectFor(t, exit, boxKey)
	s.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := s.OpenStream(ctx, Target{Host: "203.0.113.1", Port: 9}); !errors.Is(err, ErrSessionClosed) {
		t.Errorf("a closed session must refuse new streams, got %v", err)
	}
	if err := s.send(proto.FramePing, 0, nil); !errors.Is(err, ErrSessionClosed) {
		t.Errorf("a closed session must refuse frames, got %v", err)
	}
}

// A stream that never opens must fail the opener once the exit says CLOSE, not hang for 10 s.
func TestCloseBeforeOpenOkFailsTheOpener(t *testing.T) {
	boxKey := testBoxKey(t)
	exit := startTestExit(t, boxKey, func(string, int) (net.Conn, error) {
		return nil, errors.New("refused")
	})
	s := connectFor(t, exit, boxKey)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started := time.Now()
	if _, err := s.OpenStream(ctx, Target{Host: "203.0.113.1", Port: 9}); err == nil {
		t.Fatal("expected a failure")
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Errorf("the opener waited %v: a CLOSE must fail it immediately", elapsed)
	}
}
