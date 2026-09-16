// Package socks is the loopback SOCKS5 entry point of the Android core.
//
// It is the Go port of src/socks5.mjs, cut down to what a phone actually needs: RFC 1928, the "no
// authentication" greeting method and CONNECT. BIND and UDP ASSOCIATE are refused on purpose — the
// data plane used on Android is TCP (libbox outbounds and the native mux), so a UDP relay would be
// dead code.
//
// Two properties of the Node server are kept deliberately:
//
//   - the listener is bound to 127.0.0.1 and a connection from anywhere else is dropped, because the
//     SOCKS entry point is an unauthenticated local API;
//   - the success reply is sent only after the data plane has actually opened the stream, so a client
//     (a browser, libbox) never believes a dead target is ready.
//
// DialFunc is the seam: in the app it opens a session.Stream on the native plane or a libbox outbound,
// in tests it is a plain dialer.
package socks

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
)

// Version is the SOCKS protocol version spoken here (RFC 1928).
const Version = 5

// Tunables. The defaults mirror the Node server: a client that does not finish the greeting and the
// request in ten seconds is dropped, and a tunnel that moves nothing for ten minutes is closed.
var (
	RequestTimeout = 10 * time.Second
	IdleTimeout    = 10 * time.Minute
	DialTimeout    = 10 * time.Second
)

// Method identifiers from RFC 1928 §3.
const (
	methodNone         = 0x00
	methodUnacceptable = 0xff
)

// Reply codes from RFC 1928 §6.
const (
	replySuccess         = 0x00
	replyGeneralFailure  = 0x01
	replyRefused         = 0x05
	replyCmdUnsupported  = 0x07
	replyAtypUnsupported = 0x08
)

// Address types from RFC 1928 §5.
const (
	atypIPv4   = 0x01
	atypDomain = 0x03
	atypIPv6   = 0x04
)

// Commands from RFC 1928 §4.
const (
	cmdConnect      = 0x01
	cmdBind         = 0x02
	cmdUDPAssociate = 0x03
)

// Conn is the smallest surface the relay needs from one side of a proxied flow: bytes both ways, a
// half close towards the peer and a full close. session.Stream satisfies it as is, so the native plane
// needs no adapter, and WrapConn makes a net.Conn satisfy it.
type Conn interface {
	io.Reader
	io.Writer
	CloseWrite() error
	io.Closer
}

// DialFunc opens one stream to host:port through whichever data plane is active. CONNECT is answered
// only after this returns without an error.
type DialFunc func(ctx context.Context, host string, port int) (Conn, error)

// WrapConn adapts a plain net.Conn to Conn. A *net.TCPConn keeps its real half close; anything else
// falls back to a full close, which is all a generic net.Conn promises.
func WrapConn(c net.Conn) Conn { return wrappedConn{Conn: c} }

type wrappedConn struct{ net.Conn }

func (c wrappedConn) CloseWrite() error {
	if half, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return half.CloseWrite()
	}
	return nil
}

// Server is a SOCKS5 listener on loopback.
type Server struct {
	ln   net.Listener
	dial DialFunc

	mu     sync.Mutex
	conns  map[net.Conn]struct{}
	closed bool
}

// Listen binds 127.0.0.1:port and serves it in the background. Port 0 picks a free port, readable with
// Addr.
func Listen(port int, dial DialFunc) (*Server, error) {
	if dial == nil {
		return nil, errors.New("socks: no dialer")
	}
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	s := &Server{ln: ln, dial: dial, conns: make(map[net.Conn]struct{})}
	go s.acceptLoop()
	return s, nil
}

// Addr is the address the listener is bound to.
func (s *Server) Addr() net.Addr { return s.ln.Addr() }

// Close stops the listener and every flow it is carrying.
func (s *Server) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	conns := make([]net.Conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()

	err := s.ln.Close()
	for _, c := range conns {
		c.Close()
	}
	return err
}

func (s *Server) acceptLoop() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		// a connection that is not from loopback means the listener was exposed: refuse it
		if !isLoopbackHost(hostOf(conn.RemoteAddr())) {
			conn.Close()
			continue
		}
		if !s.track(conn) {
			conn.Close()
			return
		}
		go func() {
			defer s.untrack(conn)
			s.handle(conn)
		}()
	}
}

func (s *Server) track(c net.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	s.conns[c] = struct{}{}
	return true
}

func (s *Server) untrack(c net.Conn) {
	s.mu.Lock()
	delete(s.conns, c)
	s.mu.Unlock()
}

// handle serves one client: greeting, request, then a relay. Everything up to the success reply is
// covered by RequestTimeout, the relay by IdleTimeout.
func (s *Server) handle(raw net.Conn) {
	defer raw.Close()

	raw.SetReadDeadline(time.Now().Add(RequestTimeout))
	br := bufio.NewReader(raw)
	if err := negotiate(raw, br); err != nil {
		return
	}
	req, err := readRequest(br)
	if err != nil {
		var rej *refusal
		if errors.As(err, &rej) {
			writeReply(raw, rej.code)
		}
		return
	}
	raw.SetReadDeadline(time.Time{})

	ctx, cancel := context.WithTimeout(context.Background(), DialTimeout)
	defer cancel()
	upstream, err := s.dial(ctx, req.host, req.port)
	if err != nil {
		writeReply(raw, replyRefused)
		return
	}
	defer upstream.Close()

	if err := writeReply(raw, replySuccess); err != nil {
		return
	}
	// bytes the client pipelined after the request are still in br and are forwarded first
	relay(WrapConn(raw), br, upstream)
}

// negotiate answers the greeting. Only "no authentication" is offered: an unauthenticated local socket
// is the whole trust model, and offering a password method would pretend otherwise.
func negotiate(w io.Writer, br *bufio.Reader) error {
	head := make([]byte, 2)
	if _, err := io.ReadFull(br, head); err != nil {
		return err
	}
	if head[0] != Version || head[1] == 0 {
		return errors.New("socks: malformed greeting")
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(br, methods); err != nil {
		return err
	}
	if !bytes.Contains(methods, []byte{methodNone}) {
		w.Write([]byte{Version, methodUnacceptable})
		return errors.New("socks: no acceptable method")
	}
	_, err := w.Write([]byte{Version, methodNone})
	return err
}

// request is a parsed SOCKS request. Only CONNECT gets here.
type request struct {
	host string
	port int
}

// refusal is a request that must be answered with a specific reply code (RFC 1928 §6) instead of just
// dropping the connection.
type refusal struct {
	code byte
	why  string
}

func (r *refusal) Error() string { return r.why }

// readRequest parses the request and returns with the reader positioned on the first pipelined payload
// byte, which the caller relays as is.
func readRequest(br *bufio.Reader) (request, error) {
	head := make([]byte, 4)
	if _, err := io.ReadFull(br, head); err != nil {
		return request{}, err
	}
	if head[0] != Version || head[2] != 0 {
		return request{}, errors.New("socks: malformed request")
	}

	var host string
	switch head[3] {
	case atypIPv4:
		raw := make([]byte, net.IPv4len)
		if _, err := io.ReadFull(br, raw); err != nil {
			return request{}, err
		}
		host = net.IP(raw).String()
	case atypIPv6:
		raw := make([]byte, net.IPv6len)
		if _, err := io.ReadFull(br, raw); err != nil {
			return request{}, err
		}
		host = expandIPv6(raw)
	case atypDomain:
		length, err := br.ReadByte()
		if err != nil {
			return request{}, err
		}
		if length == 0 {
			return request{}, &refusal{code: replyAtypUnsupported, why: "socks: empty hostname"}
		}
		name := make([]byte, int(length))
		if _, err := io.ReadFull(br, name); err != nil {
			return request{}, err
		}
		host = string(name)
		if hasSpaceOrNul(host) {
			return request{}, &refusal{code: replyAtypUnsupported, why: "socks: invalid hostname"}
		}
	default:
		return request{}, &refusal{code: replyAtypUnsupported, why: "socks: unsupported address type"}
	}

	portRaw := make([]byte, 2)
	if _, err := io.ReadFull(br, portRaw); err != nil {
		return request{}, err
	}

	switch head[1] {
	case cmdConnect:
	case cmdBind, cmdUDPAssociate:
		return request{}, &refusal{code: replyCmdUnsupported, why: "socks: unsupported command"}
	default:
		return request{}, &refusal{code: replyCmdUnsupported, why: "socks: unknown command"}
	}

	port := int(binary.BigEndian.Uint16(portRaw))
	if port == 0 {
		return request{}, &refusal{code: replyGeneralFailure, why: "socks: invalid port"}
	}
	return request{host: host, port: port}, nil
}

// writeReply writes a 10-byte reply. The bound address is 127.0.0.1:0 for a success, as in the Node
// server: nothing useful is bound here, clients must not use it.
func writeReply(w io.Writer, code byte) error {
	_, err := w.Write([]byte{Version, code, 0, atypIPv4, 127, 0, 0, 1, 0, 0})
	return err
}

// relay pipes the two sides until both are done, honouring half closes the way the Node server does:
// an EOF on one side closes only that direction.
func relay(client Conn, clientIn io.Reader, upstream Conn) {
	var last atomic.Int64
	last.Store(time.Now().UnixNano())

	done := make(chan struct{}, 2)
	go func() {
		copyUntilEOF(upstream, clientIn, &last)
		upstream.CloseWrite()
		done <- struct{}{}
	}()
	go func() {
		copyUntilEOF(client, upstream, &last)
		client.CloseWrite()
		done <- struct{}{}
	}()

	stop := make(chan struct{})
	if IdleTimeout > 0 {
		go func() {
			ticker := time.NewTicker(watchdogInterval(IdleTimeout))
			defer ticker.Stop()
			for {
				select {
				case <-stop:
					return
				case <-ticker.C:
					if time.Since(time.Unix(0, last.Load())) > IdleTimeout {
						client.Close()
						upstream.Close()
						return
					}
				}
			}
		}()
	}

	<-done
	<-done
	close(stop)
}

// copyUntilEOF is io.Copy with an activity stamp, so the idle watchdog sees both directions.
func copyUntilEOF(dst io.Writer, src io.Reader, last *atomic.Int64) {
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			last.Store(time.Now().UnixNano())
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func watchdogInterval(idle time.Duration) time.Duration {
	interval := idle / 4
	if interval > 30*time.Second {
		interval = 30 * time.Second
	}
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	return interval
}

// expandIPv6 renders an address the way the Node client does — eight groups, no compression — so the
// host string handed to a dialer is identical on both sides of the cross-check.
func expandIPv6(raw []byte) string {
	groups := make([]string, 8)
	for i := range groups {
		groups[i] = strconv.FormatUint(uint64(binary.BigEndian.Uint16(raw[i*2:])), 16)
	}
	return strings.Join(groups, ":")
}

func hasSpaceOrNul(host string) bool {
	for _, r := range host {
		if r == 0 || unicode.IsSpace(r) {
			return true
		}
	}
	return false
}

func hostOf(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
