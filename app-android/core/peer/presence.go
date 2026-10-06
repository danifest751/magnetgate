package peer

import (
	"errors"
	"github.com/gorilla/websocket"
	"time"
)

func (c *Client) run() {
	defer c.wg.Done()
	backoff := time.Second
	for {
		if c.ctx.Err() != nil {
			return
		}
		if c.RefreshCredential != nil {
			c.mu.Lock()
			refresh := c.Credential.Claims.Expires <= time.Now().Add(15*time.Minute).Unix()
			c.mu.Unlock()
			if refresh {
				credential, e := c.RefreshCredential(c.ctx)
				if e == nil {
					e = credential.Verify(c.Authority, time.Now())
				}
				if e == nil && credential.Claims.Device != c.Identity.Public() {
					e = errors.New("renewed device identity mismatch")
				}
				if e != nil {
					c.mu.Lock()
					c.status.Error = e.Error()
					c.mu.Unlock()
					select {
					case <-c.ctx.Done():
						return
					case <-time.After(backoff):
					}
					continue
				}
				c.mu.Lock()
				c.Credential = credential
				c.mu.Unlock()
			}
		}
		ws, err := c.connect(c.ctx, "control")
		if err == nil {
			c.mu.Lock()
			c.ws = ws
			c.status.Error = ""
			c.mu.Unlock()
			backoff = time.Second
			c.readControl(ws)
		}
		c.mu.Lock()
		c.ws = nil
		c.status.Connected = false
		c.status.Sharing = false
		c.status.State = "OFFLINE"
		c.status.Countries = []Country{}
		if err != nil {
			c.status.Error = err.Error()
		}
		for session := range c.sessions {
			session.Close()
		}
		c.mu.Unlock()
		select {
		case <-c.ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 8*time.Second {
			backoff *= 2
		}
	}
}
func (c *Client) readControl(ws *websocket.Conn) {
	defer ws.Close()
	stop := make(chan struct{})
	defer close(stop)
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		heartbeat := time.NewTicker(5 * time.Second)
		network := time.NewTicker(time.Second)
		defer heartbeat.Stop()
		defer network.Stop()
		for {
			select {
			case <-stop:
				return
			case <-c.ctx.Done():
				return
			case <-heartbeat.C:
				if c.send(message{Type: "heartbeat"}) != nil {
					ws.Close()
					return
				}
			case <-network.C:
				c.checkNetwork()
			}
		}
	}()
	for {
		ws.SetReadDeadline(time.Now().Add(20 * time.Second))
		var m message
		if ws.ReadJSON(&m) != nil {
			return
		}
		switch m.Type {
		case "authenticated":
			if observer, ok := c.Network.(interface{ SetObserved(string) }); ok {
				observer.SetObserved(m.Observed)
			}
			c.mu.Lock()
			c.status.Connected = true
			c.status.Country = m.Country
			c.status.Revision = 0
			c.mu.Unlock()
			if c.Store != nil && c.Store.Policy().Enabled {
				if c.Store.Begin() != nil {
					return
				}
			}
			c.publishPresence()
		case "snapshot":
			c.mu.Lock()
			if m.Revision >= c.status.Revision {
				c.status.Revision = m.Revision
				c.status.Countries = m.Countries
			}
			c.mu.Unlock()
		case "reservation":
			c.mu.Lock()
			ch := c.waiters[m.ID]
			c.mu.Unlock()
			if ch != nil {
				select {
				case ch <- m:
				default:
				}
			}
		case "heartbeat":
		case "presence-ack":
			c.mu.Lock()
			if m.Epoch == c.epoch && m.Revision == c.sequence && c.advertisedReady && m.Ready && c.pausedReason == "" && c.Store != nil && c.Store.Available() && c.Network != nil && c.Network.Ready() {
				c.status.Sharing = true
				c.status.State = "READY"
			}
			c.mu.Unlock()
		case "offer":
			if m.Ticket != nil {
				c.acceptOffer(*m.Ticket)
			}
		case "error":
			c.mu.Lock()
			c.status.Error = m.Error
			c.status.Sharing = false
			c.status.State = "PAUSED"
			c.mu.Unlock()
		default:
			return
		}
	}
}
func (c *Client) checkNetwork() {
	if c.Network != nil && !c.Network.Ready() {
		c.mu.Lock()
		was := c.status.Sharing || c.advertisedReady
		if was {
			c.epoch = randomID()
			c.sequence++
		}
		c.advertisedReady = false
		c.status.Sharing = false
		c.status.State = "PAUSED"
		for session, exit := range c.sessions {
			if exit {
				session.Close()
			}
		}
		c.mu.Unlock()
		if was {
			c.publishPresence()
		}
		return
	}
	c.mu.Lock()
	paused := c.status.State == "PAUSED" && c.pausedReason == "" && validCountry(c.status.Country) && c.Credential.Claims.Exit && c.Store != nil && c.Store.Available()
	c.mu.Unlock()
	if paused {
		c.publishPresence()
	}
}

// SuspendExit is the host's synchronous barrier before it starts its own VPN.
// The Network adapter must already have marked its generation unavailable.
func (c *Client) SuspendExit() {
	c.mu.Lock()
	c.advertisedReady = false
	c.epoch = randomID()
	c.sequence++
	c.status.Sharing = false
	c.status.State = "PAUSED"
	for s, exit := range c.sessions {
		if exit {
			s.Close()
		}
	}
	c.mu.Unlock()
	c.publishPresence()
}
func (c *Client) publishPresence() {
	c.mu.Lock()
	if c.Store == nil {
		c.mu.Unlock()
		return
	}
	p := c.Store.Policy()
	if !c.Credential.Claims.Exit {
		c.mu.Unlock()
		return
	}
	ready := p.Enabled && c.Store.Available() && c.pausedReason == "" && c.Network != nil && c.Network.Ready() && validCountry(c.status.Country)
	c.sequence++
	m := message{Type: "presence", Epoch: c.epoch, Revision: c.sequence, Ready: ready, Slots: p.MaxGuests}
	c.advertisedReady = ready
	c.status.Sharing = false
	if ready {
		c.status.State = "PREPARING"
	} else if p.Enabled {
		c.status.State = "PAUSED"
	} else {
		c.status.State = "OFFLINE"
	}
	c.mu.Unlock()
	if err := c.send(m); err != nil {
		c.mu.Lock()
		c.status.State = "OFFLINE"
		c.mu.Unlock()
	}
}
