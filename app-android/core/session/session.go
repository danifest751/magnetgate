// Package session is the client side of the native data plane: connect, handshake, then multiplex
// TCP streams over one authenticated session. It mirrors src/native-client.mjs; the exit side is
// src/exit-session.mjs.
//
// Wire, exactly as the exit expects it:
//
//	→ [u16 msg1Len][msg1]
//	← [u16 msg2Len][msg2]
//	→ ← frames v4 (proto.EncodeFrame / proto.Decoder)
//
// A stream is opened with OPEN carrying {"host":...,"port":...}; the exit answers OPEN_OK once it has
// a connection, DATA in both directions, END for a half close and CLOSE when it is done. The session
// itself is kept alive with PING/PONG: a missing pong for 30 s destroys it, which is what makes a dead
// path fail over instead of hanging.
package session

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"magnetgate/core/proto"
)

// Limits mirror the Node client: a bounded read buffer per stream, and a handshake that cannot hang.
const (
	OpenTimeoutMs = 10_000
	// MaxQueuedBytes is what one stream may buffer before it is treated as a stuck receiver.
	MaxQueuedBytes = 4 * 1024 * 1024
	PingEvery      = 10 * time.Second
	PongDeadline   = 30 * time.Second
	HandshakeMs    = 5000
)

var (
	ErrSessionClosed = errors.New("session closed")
	ErrStreamClosed  = errors.New("stream closed")
	ErrSlowReceiver  = errors.New("slow receiver")
)

// Target is what an OPEN carries.
type Target struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

// Session is one authenticated connection to an exit.
type Session struct {
	conn    net.Conn
	enc     *proto.FrameEncoder
	dec     *proto.Decoder
	writeMu sync.Mutex

	mu      sync.Mutex
	streams map[uint32]*Stream
	nextID  uint32
	closed  bool

	lastPong time.Time
	pingStop chan struct{}
	onClose  func()
}

// Connect dials the endpoint, performs the handshake and starts the frame loop.
func Connect(ctx context.Context, host string, port int, boxKey *[32]byte) (*Session, error) {
	dialer := net.Dialer{Timeout: HandshakeMs * time.Millisecond}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, fmt.Sprint(port)))
	if err != nil {
		return nil, err
	}
	session, err := handshake(conn, boxKey)
	if err != nil {
		conn.Close()
		return nil, err
	}
	// keepalive at the TCP layer as well: a dead path must be noticed even before a ping is due
	if tcp, ok := conn.(*net.TCPConn); ok {
		tcp.SetKeepAlive(true)
		tcp.SetKeepAlivePeriod(15 * time.Second)
	}
	return session, nil
}

// handshake sends msg1 and verifies the exit's reply, leaving the connection positioned exactly after
// msg2 so leftover bytes can be fed to the decoder.
func handshake(conn net.Conn, boxKey *[32]byte) (*Session, error) {
	msg1, eph, err := proto.ClientInit(boxKey, time.Now())
	if err != nil {
		return nil, err
	}
	header := make([]byte, 2)
	binary.BigEndian.PutUint16(header, uint16(len(msg1)))
	if _, err := conn.Write(append(header, msg1...)); err != nil {
		return nil, err
	}

	deadline := time.Now().Add(HandshakeMs * time.Millisecond)
	buffered := make([]byte, 0, proto.HSMsg2Len+2)
	readBuf := make([]byte, proto.HSMsg2Len+2)
	for len(buffered) < 2+proto.HSMsg2Len {
		conn.SetReadDeadline(deadline)
		n, err := conn.Read(readBuf)
		if err != nil {
			return nil, fmt.Errorf("handshake read: %w", err)
		}
		buffered = append(buffered, readBuf[:n]...)
		if len(buffered) >= 2 && int(binary.BigEndian.Uint16(buffered)) != proto.HSMsg2Len {
			return nil, errors.New("unsupported native protocol")
		}
	}
	conn.SetReadDeadline(time.Time{})

	keys, err := proto.ClientFinish(boxKey, buffered[2:2+proto.HSMsg2Len], eph)
	if err != nil {
		return nil, errors.New("handshake authentication failed")
	}

	s := &Session{
		conn:     conn,
		enc:      proto.NewFrameEncoder(&keys.C2E),
		streams:  make(map[uint32]*Stream),
		nextID:   1,
		lastPong: time.Now(),
		pingStop: make(chan struct{}),
	}
	s.dec = proto.NewDecoder(&keys.E2C, s.onFrame, s.Close)
	if leftover := buffered[2+proto.HSMsg2Len:]; len(leftover) > 0 {
		s.dec.Push(leftover)
	}
	go s.readLoop()
	go s.pingLoop()
	return s, nil
}

// SetOnClose registers the callback used when the session dies (the pool drops it there).
func (s *Session) SetOnClose(fn func()) {
	s.mu.Lock()
	s.onClose = fn
	s.mu.Unlock()
}

func (s *Session) readLoop() {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.conn.Read(buf)
		if n > 0 {
			s.dec.Push(buf[:n])
		}
		if err != nil {
			s.Close()
			return
		}
	}
}

func (s *Session) pingLoop() {
	ticker := time.NewTicker(PingEvery)
	defer ticker.Stop()
	for {
		select {
		case <-s.pingStop:
			return
		case <-ticker.C:
			s.mu.Lock()
			dead := s.closed || time.Since(s.lastPong) > PongDeadline
			s.mu.Unlock()
			if dead {
				s.Close()
				return
			}
			if err := s.send(proto.FramePing, 0, nil); err != nil {
				s.Close()
				return
			}
		}
	}
}

func (s *Session) send(typ byte, id uint32, plain []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return ErrSessionClosed
	}
	frame, err := s.enc.Encode(typ, id, plain)
	if err != nil {
		return err
	}
	_, err = s.conn.Write(frame)
	return err
}

// onFrame dispatches one decoded frame, mirroring the Node switch.
func (s *Session) onFrame(f proto.Frame) {
	switch f.Type {
	case proto.FrameOpenOK:
		s.stream(f.StreamID).markOpened()
	case proto.FrameData:
		if st := s.stream(f.StreamID); st != nil {
			if err := st.push(f.Plain); err != nil {
				st.destroy(err)
			}
		}
		// no stream: the local side closed while a response was in flight, drop the data
	case proto.FrameEnd:
		if st := s.stream(f.StreamID); st != nil {
			st.pushEOF()
		}
	case proto.FrameClose:
		if st := s.stream(f.StreamID); st != nil {
			st.peerClosed()
		}
	case proto.FramePong:
		s.mu.Lock()
		s.lastPong = time.Now()
		s.mu.Unlock()
	default:
		// an unknown or server-only type means the peer is not what we think it is
		s.Close()
	}
}

func (s *Session) stream(id uint32) *Stream {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.streams[id]
}

func (s *Session) register(st *Stream) {
	s.mu.Lock()
	s.streams[st.id] = st
	s.mu.Unlock()
}

func (s *Session) forget(id uint32) {
	s.mu.Lock()
	delete(s.streams, id)
	s.mu.Unlock()
}

// OpenStream opens one stream to `target` and returns once the exit confirmed it.
func (s *Session) OpenStream(ctx context.Context, target Target) (*Stream, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, ErrSessionClosed
	}
	if s.nextID == 0 {
		s.mu.Unlock()
		s.Close()
		return nil, errors.New("stream ids exhausted")
	}
	id := s.nextID
	s.nextID++
	s.mu.Unlock()

	st := newStream(s, id)
	s.register(st)
	payload, err := json.Marshal(target)
	if err != nil {
		s.forget(id)
		return nil, err
	}
	if err := s.send(proto.FrameOpen, id, payload); err != nil {
		s.forget(id)
		return nil, err
	}

	timer := time.NewTimer(OpenTimeoutMs * time.Millisecond)
	defer timer.Stop()
	select {
	case <-st.openedChan():
		return st, nil
	case err := <-st.failed:
		return nil, err
	case <-timer.C:
		st.destroy(errors.New("upstream timeout"))
		return nil, errors.New("upstream timeout")
	case <-ctx.Done():
		st.destroy(ctx.Err())
		return nil, ctx.Err()
	}
}

// Close tears the session down: streams get an error, the socket goes, the pool is told.
//
// It is idempotent and re-entrant on purpose: it is also the decoder's kill callback, so a violation
// inside the decoder calls back into Close — a sync.Once here would deadlock on itself.
func (s *Session) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	streams := make([]*Stream, 0, len(s.streams))
	for _, st := range s.streams {
		streams = append(streams, st)
	}
	s.streams = make(map[uint32]*Stream)
	onClose := s.onClose
	s.mu.Unlock()

	close(s.pingStop)
	s.dec.Kill()
	for _, st := range streams {
		st.destroy(ErrSessionClosed)
	}
	s.conn.Close()
	if onClose != nil {
		onClose()
	}
}

// Stream is one multiplexed TCP stream. It is safe for concurrent use: frames are serialised by the
// session, the read buffer is guarded here.
type Stream struct {
	session *Session
	id      uint32

	mu      sync.Mutex
	cond    *sync.Cond
	buf     bytes.Buffer
	closed  bool
	err     error // why it closed, for the reader
	eof     bool  // peer sent END/CLOSE: drain, then io.EOF
	opened  bool
	limit   int
	openErr error

	openedCh chan struct{}
	failed   chan error
	once     sync.Once
}

func newStream(s *Session, id uint32) *Stream {
	st := &Stream{
		session:  s,
		id:       id,
		limit:    MaxQueuedBytes,
		openedCh: make(chan struct{}),
		failed:   make(chan error, 1),
	}
	st.cond = sync.NewCond(&st.mu)
	return st
}

// opened is a channel closed once OPEN_OK arrives.
func (st *Stream) openedChan() <-chan struct{} { return st.openedCh }

func (st *Stream) markOpened() {
	st.mu.Lock()
	st.opened = true
	st.mu.Unlock()
	st.once.Do(func() { close(st.openedCh) })
	st.cond.Broadcast()
}

func (st *Stream) fail(err error) {
	select {
	case st.failed <- err:
	default:
	}
}

// push appends received data, refusing to buffer without bound (a stuck reader is a stuck tunnel).
func (st *Stream) push(data []byte) error {
	st.mu.Lock()
	if st.closed {
		st.mu.Unlock()
		return nil
	}
	if st.buf.Len()+len(data) > st.limit {
		st.mu.Unlock()
		st.destroy(ErrSlowReceiver)
		return ErrSlowReceiver
	}
	st.buf.Write(data)
	st.cond.Broadcast()
	st.mu.Unlock()
	return nil
}

func (st *Stream) pushEOF() {
	st.mu.Lock()
	st.eof = true
	st.cond.Broadcast()
	st.mu.Unlock()
}

// peerClosed handles CLOSE: if the stream never opened, that is an error for the opener.
func (st *Stream) peerClosed() {
	st.mu.Lock()
	opened := st.opened
	st.mu.Unlock()
	if !opened {
		st.fail(ErrStreamClosed)
		st.destroy(ErrStreamClosed)
		return
	}
	st.pushEOF()
}

// Read implements io.Reader: it blocks until data arrives, the peer half-closes or the stream dies.
func (st *Stream) Read(p []byte) (int, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for {
		if st.buf.Len() > 0 {
			return st.buf.Read(p)
		}
		if st.eof {
			return 0, io.EOF
		}
		if st.closed {
			if st.err != nil {
				return 0, st.err
			}
			return 0, io.EOF
		}
		st.cond.Wait()
	}
}

// Write implements io.Writer: one DATA frame per call.
func (st *Stream) Write(p []byte) (int, error) {
	st.mu.Lock()
	closed := st.closed
	st.mu.Unlock()
	if closed {
		return 0, ErrStreamClosed
	}
	if err := st.session.send(proto.FrameData, st.id, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// CloseWrite half-closes the stream towards the exit (END).
func (st *Stream) CloseWrite() error {
	st.mu.Lock()
	closed := st.closed
	st.mu.Unlock()
	if closed {
		return ErrStreamClosed
	}
	return st.session.send(proto.FrameEnd, st.id, nil)
}

// Close tears the stream down and tells the exit. It is idempotent.
func (st *Stream) Close() error {
	st.destroy(nil)
	return nil
}

func (st *Stream) destroy(err error) {
	st.mu.Lock()
	if st.closed {
		st.mu.Unlock()
		return
	}
	st.closed = true
	if err != nil && st.err == nil {
		st.err = err
	}
	st.buf.Reset()
	st.cond.Broadcast()
	st.mu.Unlock()

	st.session.forget(st.id)
	// tell the opener why (if it is still waiting)
	if err != nil {
		st.fail(err)
	}
	st.session.send(proto.FrameClose, st.id, nil)
}
