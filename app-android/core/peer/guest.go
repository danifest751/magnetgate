package peer

import (
	"context"
	"errors"
	"github.com/hashicorp/yamux"
	"magnetgate/core/socks"
	"net"
	"sync"
	"time"
)

func (c *Client) reserve(ctx context.Context, country string) (Ticket, error) {
	id := randomID()
	ch := make(chan message, 1)
	c.mu.Lock()
	if len(c.waiters) >= 8 {
		c.mu.Unlock()
		return Ticket{}, errors.New("too many pending peer requests")
	}
	c.waiters[id] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.waiters, id); c.mu.Unlock() }()
	if err := c.send(message{Type: "reserve", ID: id, Country: country}); err != nil {
		return Ticket{}, err
	}
	select {
	case <-ctx.Done():
		_ = c.send(message{Type: "release", ID: id})
		return Ticket{}, ctx.Err()
	case m := <-ch:
		if m.Error != "" {
			return Ticket{}, errors.New(m.Error)
		}
		if m.Ticket == nil || m.Ticket.Guest != c.Identity.Public() || country != "" && m.Ticket.Country != country {
			return Ticket{}, errors.New("invalid reservation response")
		}
		return *m.Ticket, nil
	}
}

// OpenGuest pins a country for the session; no automatic fallback to another
// country or the local connection. The caller closes it on selection change.
func (c *Client) OpenGuest(ctx context.Context, country string) (*Guest, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	t, err := c.reserve(ctx, country)
	if err != nil {
		return nil, err
	}
	session, deadline, err := c.pairSession(ctx, t, "guest")
	if err != nil {
		_ = c.send(message{Type: "release", ID: t.ID})
		return nil, err
	}
	c.mu.Lock()
	if c.ctx.Err() != nil || c.ws == nil {
		c.mu.Unlock()
		session.Close()
		return nil, errors.New("peer client stopped")
	}
	c.sessions[session] = false
	c.wg.Add(1)
	c.mu.Unlock()
	g := &Guest{client: c, session: session, ticket: t, slots: make(chan struct{}, 32), deadline: deadline}
	go func() { defer c.wg.Done(); g.renew() }()
	return g, nil
}

type Guest struct {
	client   *Client
	session  *yamux.Session
	ticket   Ticket
	slots    chan struct{}
	once     sync.Once
	deadline *leaseDeadline
}

func (g *Guest) Country() string { return g.ticket.Country }
func (g *Guest) Close() error {
	g.once.Do(func() {
		g.session.Close()
		g.client.mu.Lock()
		delete(g.client.sessions, g.session)
		g.client.mu.Unlock()
		_ = g.client.send(message{Type: "release", ID: g.ticket.ID})
	})
	return nil
}

type openRequest struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}
type openResponse struct {
	Error string `json:"error,omitempty"`
}

func (g *Guest) Dial(ctx context.Context, host string, port int) (socks.Conn, error) {
	select {
	case g.slots <- struct{}{}:
	default:
		return nil, errors.New("peer flow limit")
	}
	stream, err := g.session.OpenStream()
	if err != nil {
		<-g.slots
		return nil, err
	}
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	stream.SetDeadline(deadline)
	if err = writeObject(stream, openRequest{Host: host, Port: port}); err == nil {
		var response openResponse
		err = readObject(stream, &response)
		if err == nil && response.Error != "" {
			err = errors.New(response.Error)
		}
	}
	if err != nil {
		stream.Close()
		<-g.slots
		return nil, err
	}
	stream.SetDeadline(time.Time{})
	return &guestConn{Stream: stream, release: func() { <-g.slots }}, nil
}

type guestConn struct {
	*yamux.Stream
	once    sync.Once
	release func()
}

func (c *guestConn) Close() error      { err := c.Stream.Close(); c.once.Do(c.release); return err }
func (c *guestConn) CloseWrite() error { return c.Stream.Close() }

var _ net.Conn = (*wsConn)(nil)
