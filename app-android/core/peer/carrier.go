package peer

import (
	"context"
	"crypto/tls"
	"errors"
	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
	"io"
	"time"
)

func muxConfig() *yamux.Config {
	cfg := yamux.DefaultConfig()
	cfg.AcceptBacklog = 32
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = 10 * time.Second
	cfg.ConnectionWriteTimeout = 5 * time.Second
	cfg.StreamOpenTimeout = 5 * time.Second
	// A FIN must not reset a delayed response before the local session lease.
	cfg.StreamCloseTimeout = 5 * time.Minute
	cfg.MaxStreamWindowSize = 256 * 1024
	cfg.LogOutput = io.Discard
	return cfg
}
func (c *Client) pairSession(ctx context.Context, t Ticket, role string) (*yamux.Session, *leaseDeadline, error) {
	ws, err := c.connect(ctx, "pair")
	if err != nil {
		return nil, nil, err
	}
	return c.pairSessionOn(ctx, t, role, ws)
}

func (c *Client) pairSessionOn(ctx context.Context, t Ticket, role string, ws *websocket.Conn) (*yamux.Session, *leaseDeadline, error) {
	var err error
	if err = ws.WriteJSON(message{Type: "join", Ticket: &t, Role: role}); err != nil {
		ws.Close()
		return nil, nil, err
	}
	remote := t.Exit
	if role == "exit" {
		remote = t.Guest
	}
	cfg, err := c.Identity.tlsConfig(remote, role == "exit")
	if err != nil {
		ws.Close()
		return nil, nil, err
	}
	carrier := newWS(ws)
	stopSetup := context.AfterFunc(ctx, func() { carrier.Close() })
	defer stopSetup()
	stopClient := context.AfterFunc(c.ctx, func() { carrier.Close() })
	defer stopClient()
	carrier.SetDeadline(time.Now().Add(5 * time.Second))
	var secure *tls.Conn
	if role == "exit" {
		secure = tls.Server(carrier, cfg)
	} else {
		secure = tls.Client(carrier, cfg)
	}
	if err = secure.HandshakeContext(ctx); err != nil {
		carrier.Close()
		return nil, nil, err
	}
	lease, err := c.authorizeSession(secure, t, role)
	if err != nil {
		secure.Close()
		return nil, nil, err
	}
	carrier.SetDeadline(time.Time{})
	var session *yamux.Session
	if role == "exit" {
		session, err = yamux.Server(secure, muxConfig())
	} else {
		session, err = yamux.Client(secure, muxConfig())
	}
	if err != nil {
		secure.Close()
		return nil, nil, err
	}
	deadline := newLeaseDeadline(session, lease.Expires)
	// Pending management setup is already owned, so consent withdrawal and Stop
	// can close it even if the remote peer never opens the first yamux stream.
	c.mu.Lock()
	allowed := c.ctx.Err() == nil && (role != "exit" || c.status.Sharing && c.epoch == t.Epoch)
	if allowed {
		c.sessions[session] = role == "exit"
	}
	c.mu.Unlock()
	if !allowed {
		session.Close()
		return nil, nil, errors.New("peer session setup cancelled")
	}
	if err := c.startLeaseControl(session, deadline, t, role, lease); err != nil {
		session.Close()
		c.mu.Lock()
		delete(c.sessions, session)
		c.mu.Unlock()
		return nil, nil, err
	}
	return session, deadline, nil
}
