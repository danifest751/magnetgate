package peer

import (
	"crypto/tls"
	"errors"
	"github.com/hashicorp/yamux"
	"sync"
	"time"
)

type SessionLease struct {
	Version  int    `json:"version"`
	Audience string `json:"audience"`
	ID       string `json:"id"`
	Guest    string `json:"guest"`
	Exit     string `json:"exit"`
	Epoch    string `json:"epoch"`
	Country  string `json:"country"`
	Expires  int64  `json:"expires"`
	MaxFlows int    `json:"maxFlows"`
	TCP      bool   `json:"tcp"`
}

// Relay authorization is insufficient: the exit verifies the guest's service
// credential again INSIDE pinned TLS, then issues its own ephemeral lease.
func (c *Client) authorizeSession(secure *tls.Conn, t Ticket, role string) (SessionLease, error) {
	if role == "guest" {
		c.mu.Lock()
		credential := c.Credential
		c.mu.Unlock()
		if err := writeObject(secure, credential); err != nil {
			return SessionLease{}, err
		}
		var lease SessionLease
		if err := readObject(secure, &lease); err != nil {
			return SessionLease{}, err
		}
		return lease, validLease(lease, t, credential)
	}
	var credential Credential
	if err := readObject(secure, &credential); err != nil {
		return SessionLease{}, err
	}
	lease, err := c.issueLease(t, credential)
	if err != nil {
		return SessionLease{}, err
	}
	return lease, writeObject(secure, lease)
}

func validLease(lease SessionLease, t Ticket, credential Credential) error {
	now := time.Now()
	// Independently synchronized devices can differ by a few seconds. Admission
	// tolerates at most five; the local timer still caps each grant at 60 seconds.
	if lease.Version != Version || lease.Audience != Audience || lease.ID != t.ID || lease.Guest != t.Guest || lease.Exit != t.Exit || lease.Epoch != t.Epoch || lease.Country != t.Country || lease.Expires <= now.UnixMilli() || lease.Expires > now.Add(time.Minute+5*time.Second).UnixMilli() || lease.Expires > credential.Claims.Expires*1000 || !lease.TCP || lease.MaxFlows != 32 {
		return errors.New("invalid exit lease")
	}
	return nil
}
func (c *Client) issueLease(t Ticket, credential Credential) (SessionLease, error) {
	if err := credential.Verify(c.Authority, time.Now()); err != nil {
		return SessionLease{}, err
	}
	if credential.Claims.Device != t.Guest || !credential.Claims.Guest {
		return SessionLease{}, errors.New("guest is not admitted by the service")
	}
	c.mu.Lock()
	allowed := c.status.Sharing && c.epoch == t.Epoch
	ownerExpires := c.Credential.Claims.Expires * 1000
	c.mu.Unlock()
	if !allowed || c.Store == nil || !c.Store.Available() || c.Network == nil || !c.Network.Ready() {
		return SessionLease{}, errors.New("exit consent withdrawn")
	}
	expires := time.Now().Add(60 * time.Second).UnixMilli()
	if credential.Claims.Expires*1000 < expires {
		expires = credential.Claims.Expires * 1000
	}
	if ownerExpires < expires {
		expires = ownerExpires
	}
	if expires <= time.Now().UnixMilli() {
		return SessionLease{}, errors.New("exit credential expired")
	}
	lease := SessionLease{Version, Audience, t.ID, t.Guest, t.Exit, t.Epoch, t.Country, expires, 32, true}
	return lease, nil
}

// A short lease is renewed on the already pinned TLS channel. Neither a relay
// heartbeat nor a late renewal can resurrect a locally expired session.
type leaseDeadline struct {
	mu      sync.Mutex
	session *yamux.Session
	expires int64
	timer   *time.Timer
	control *yamux.Stream
}

func newLeaseDeadline(session *yamux.Session, expires int64) *leaseDeadline {
	expires = min(expires, time.Now().Add(time.Minute).UnixMilli())
	l := &leaseDeadline{session: session, expires: expires}
	l.timer = time.AfterFunc(time.Until(time.UnixMilli(expires)), func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		if time.Now().UnixMilli() >= l.expires {
			session.Close()
		}
	})
	go func() { <-session.CloseChan(); l.mu.Lock(); l.timer.Stop(); l.mu.Unlock() }()
	return l
}
func (l *leaseDeadline) extend(expires int64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.session.IsClosed() || time.Now().UnixMilli() >= l.expires || expires <= time.Now().UnixMilli() {
		return false
	}
	expires = min(expires, time.Now().Add(time.Minute).UnixMilli())
	l.expires = expires
	l.timer.Reset(time.Until(time.UnixMilli(expires)))
	return true
}
func (g *Guest) renew() {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-g.client.ctx.Done():
			return
		case <-g.session.CloseChan():
			return
		case <-ticker.C:
			if !g.renewOnce() {
				g.session.Close()
				return
			}
		}
	}
}
func (g *Guest) renewOnce() bool {
	stream := g.deadline.control
	stream.SetDeadline(time.Now().Add(5 * time.Second))
	g.client.mu.Lock()
	credential := g.client.Credential
	g.client.mu.Unlock()
	if writeObject(stream, credential) != nil {
		return false
	}
	var lease SessionLease
	return readObject(stream, &lease) == nil && validLease(lease, g.ticket, credential) == nil && g.deadline.extend(lease.Expires)
}

// Stream 1 is a single management channel, reserved before data admission.
// Saturating all 32/64 data slots cannot prevent consent/lease renewal.
func (c *Client) startLeaseControl(session *yamux.Session, deadline *leaseDeadline, ticket Ticket, role string, lease SessionLease) error {
	var stream *yamux.Stream
	var err error
	if role == "guest" {
		stream, err = session.OpenStream()
	} else {
		stream, err = session.AcceptStream()
	}
	if err != nil {
		return err
	}
	stream.SetDeadline(time.Now().Add(5 * time.Second))
	if role == "guest" {
		if err = writeObject(stream, "lease-control"); err != nil {
			return err
		}
		var confirmed SessionLease
		if err = readObject(stream, &confirmed); err != nil {
			return err
		}
		if confirmed != lease {
			return errors.New("management lease mismatch")
		}
		deadline.control = stream
		return nil
	}
	var label string
	if err = readObject(stream, &label); err != nil {
		return err
	}
	if label != "lease-control" {
		return errors.New("missing management channel")
	}
	if err = writeObject(stream, lease); err != nil {
		return err
	}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer session.Close()
		last := time.Time{}
		for {
			stream.SetDeadline(time.Now().Add(30 * time.Second))
			var credential Credential
			if readObject(stream, &credential) != nil || time.Since(last) < 10*time.Second {
				return
			}
			last = time.Now()
			renewed, err := c.issueLease(ticket, credential)
			if err != nil || !deadline.extend(renewed.Expires) {
				return
			}
			if c.send(message{Type: "renew", ID: ticket.ID, Epoch: ticket.Epoch}) != nil || writeObject(stream, renewed) != nil {
				return
			}
		}
	}()
	return nil
}
