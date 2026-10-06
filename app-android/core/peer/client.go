package peer

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"errors"
	"net"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
)

type Status struct {
	Connected bool      `json:"connected"`
	Sharing   bool      `json:"sharing"`
	State     string    `json:"state"`
	Country   string    `json:"country"`
	Countries []Country `json:"countries"`
	Error     string    `json:"error,omitempty"`
	Revision  uint64    `json:"revision"`
}
type Client struct {
	Identity   Identity
	Credential Credential
	Authority  ed25519.PublicKey
	URL        string
	Store      *Store
	Network    Network
	// OuterTLS is an optional trust store/pin, never InsecureSkipVerify.
	OuterTLS          *tls.Config
	LinkDial          func(context.Context, string, string) (net.Conn, error)
	RefreshCredential func(context.Context) (Credential, error)
	mu                sync.Mutex
	writeMu           sync.Mutex
	policyMu          sync.Mutex
	ws                *websocket.Conn
	ctx               context.Context
	cancel            context.CancelFunc
	status            Status
	waiters           map[string]chan message
	sessions          map[*yamux.Session]bool // true = exit-owned session
	epoch             string
	sequence          uint64
	wg                sync.WaitGroup
	exitSlots         chan struct{}
	flows             chan struct{}
	dials             chan struct{}
	limits            *exitLimits
	pausedReason      string
	advertisedReady   bool
	guestBudgets      map[string]*guestBudget
}

func (c *Client) Start(ctx context.Context) error {
	if len(c.Identity.Key) != ed25519.PrivateKeySize || len(c.Authority) != ed25519.PublicKeySize {
		return errors.New("invalid peer identity or authority")
	}
	u, err := url.Parse(c.URL)
	if err != nil || u.Scheme != "wss" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("peer service requires a wss URL")
	}
	if c.OuterTLS != nil && c.OuterTLS.InsecureSkipVerify {
		return errors.New("unverified service TLS is forbidden")
	}
	if adapter, ok := c.Network.(interface {
		SetControl(context.Context, string) error
	}); ok {
		setup, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := adapter.SetControl(setup, u.Hostname())
		cancel()
		if err != nil {
			return err
		}
	}
	if err = c.Credential.Verify(c.Authority, time.Now()); err != nil {
		return err
	}
	if c.Credential.Claims.Device != c.Identity.Public() {
		return errors.New("credential is for another device")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cancel != nil {
		return errors.New("peer client already started")
	}
	c.ctx, c.cancel = context.WithCancel(ctx)
	c.waiters = map[string]chan message{}
	c.sessions = map[*yamux.Session]bool{}
	c.exitSlots = make(chan struct{}, 2)
	c.flows = make(chan struct{}, 64)
	c.dials = make(chan struct{}, 8)
	c.epoch = randomID()
	c.status.State = "OFFLINE"
	c.limits = newExitLimits()
	if c.Store != nil {
		c.limits.observe(c.Store.Policy(), 0)
	}
	c.guestBudgets = map[string]*guestBudget{}
	c.wg.Add(1)
	go c.run()
	return nil
}
func (c *Client) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.status
	s.Countries = append([]Country{}, s.Countries...)
	return s
}

func (c *Client) CanShare() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if supported, ok := c.Network.(interface{ CanShare() bool }); ok && !supported.CanShare() {
		return false
	}
	return c.Credential.Claims.Exit
}
func (c *Client) Stop() error {
	c.mu.Lock()
	if c.cancel == nil {
		c.mu.Unlock()
		return nil
	}
	c.cancel()
	if c.ws != nil {
		c.ws.Close()
	}
	for session := range c.sessions {
		session.Close()
	}
	c.mu.Unlock()
	c.wg.Wait()
	c.mu.Lock()
	c.status = Status{State: "OFFLINE", Countries: []Country{}}
	c.cancel = nil
	c.mu.Unlock()
	if c.Store != nil {
		return c.Store.End()
	}
	return nil
}

// SetPolicy denies locally before writing or telling the catalog. Existing
// sessions are closed even when the subsequent persistence operation fails.
func (c *Client) SetPolicy(p Policy) error {
	c.policyMu.Lock()
	defer c.policyMu.Unlock()
	if c.Store == nil {
		return errors.New("no private policy store")
	}
	if err := p.Validate(); err != nil {
		return err
	}
	if p.Enabled && !c.CanShare() {
		return errors.New("sharing is not available on this device")
	}
	c.mu.Lock()
	for session, exit := range c.sessions {
		if exit {
			session.Close()
		}
	}
	c.status.Sharing = false
	c.advertisedReady = false
	c.epoch = randomID()
	c.pausedReason = ""
	c.mu.Unlock()
	if err := c.Store.Save(p); err != nil {
		c.publishPresence()
		return err
	}
	c.limits.observe(p, 0)
	if p.Enabled {
		if err := c.Store.Begin(); err != nil {
			c.publishPresence()
			return err
		}
	} else {
		if err := c.Store.End(); err != nil {
			c.publishPresence()
			return err
		}
	}
	c.publishPresence()
	return nil
}
func (c *Client) connect(ctx context.Context, scope string) (*websocket.Conn, error) {
	c.mu.Lock()
	credential := c.Credential
	c.mu.Unlock()
	d := websocket.Dialer{HandshakeTimeout: 5 * time.Second, TLSClientConfig: c.OuterTLS, NetDialContext: c.LinkDial, ReadBufferSize: 4096, WriteBufferSize: 4096}
	ws, _, err := d.DialContext(ctx, c.URL+"/v1/"+scope, nil)
	if err != nil {
		return nil, err
	}
	stopSetup := context.AfterFunc(ctx, func() { ws.Close() })
	defer stopSetup()
	ws.SetReadLimit(64 * 1024)
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	var m message
	if err = ws.ReadJSON(&m); err == nil && (m.Type != "challenge" || len(m.Challenge) != 48) {
		err = errors.New("invalid service challenge")
	}
	if err == nil {
		err = ws.WriteJSON(message{Type: "auth", Credential: &credential, Proof: proof(c.Identity.Key, m.Challenge, scope)})
	}
	if err != nil {
		ws.Close()
		return nil, err
	}
	return ws, nil
}
func (c *Client) send(m message) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.mu.Lock()
	ws := c.ws
	c.mu.Unlock()
	if ws == nil {
		return errors.New("peer service offline")
	}
	ws.SetWriteDeadline(time.Now().Add(3 * time.Second))
	return ws.WriteJSON(m)
}
