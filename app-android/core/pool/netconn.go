package pool

import (
	"errors"
	"net"
	"sync"
	"time"
)

// AsNetConn adapts a stream from the data plane to net.Conn, so code written against the standard
// library (a WebSocket client, an HTTP client) can be pointed through an exit.
//
// The deadlines are the reason this is not a two-line wrapper. A Conn carries no notion of one, and
// ignoring them would be the quiet kind of wrong this project keeps meeting: the Nostr channel decides
// that a relay has gone mute precisely by a read deadline expiring, so a SetReadDeadline that did
// nothing would bring back the failure it was written to catch. They are honoured by closing the stream
// when one expires - cruder than a real deadline, which fails a single operation, but it produces the
// same outcome for every caller here: the read fails and the connection is rebuilt.
func AsNetConn(stream Conn, remote string) net.Conn {
	return &netConn{stream: stream, remote: addr(remote)}
}

type netConn struct {
	stream Conn
	remote net.Addr

	mu     sync.Mutex
	read   *time.Timer
	write  *time.Timer
	closed bool
}

func (c *netConn) Read(p []byte) (int, error)  { return c.stream.Read(p) }
func (c *netConn) Write(p []byte) (int, error) { return c.stream.Write(p) }

func (c *netConn) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	stopTimer(&c.read)
	stopTimer(&c.write)
	c.mu.Unlock()
	return c.stream.Close()
}

// CloseWrite keeps the half-close the data plane supports, for callers that know about it.
func (c *netConn) CloseWrite() error { return c.stream.CloseWrite() }

func (c *netConn) LocalAddr() net.Addr  { return addr("plane") }
func (c *netConn) RemoteAddr() net.Addr { return c.remote }

func (c *netConn) SetDeadline(t time.Time) error {
	if err := c.SetReadDeadline(t); err != nil {
		return err
	}
	return c.SetWriteDeadline(t)
}

func (c *netConn) SetReadDeadline(t time.Time) error  { return c.arm(&c.read, t) }
func (c *netConn) SetWriteDeadline(t time.Time) error { return c.arm(&c.write, t) }

// arm replaces whatever deadline was set for one direction. The zero time clears it, which is what a
// caller means by "no deadline" - and what every caller must do after a write it has finished, or the
// write deadline would later close a perfectly healthy connection.
func (c *netConn) arm(slot **time.Timer, t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errors.New("pool: the stream is closed")
	}
	stopTimer(slot)
	if t.IsZero() {
		return nil
	}
	delay := time.Until(t)
	if delay <= 0 {
		go c.stream.Close()
		return nil
	}
	*slot = time.AfterFunc(delay, func() { c.stream.Close() })
	return nil
}

func stopTimer(slot **time.Timer) {
	if *slot != nil {
		(*slot).Stop()
		*slot = nil
	}
}

type addr string

func (a addr) Network() string { return "magnetgate" }
func (a addr) String() string  { return string(a) }
