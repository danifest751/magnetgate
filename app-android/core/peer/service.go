package peer

import (
	"context"
	"crypto/ed25519"
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"
)

// Service is one logical presence authority and one blind relay. Deployment
// behind HTTPS must not trust forwarded headers from arbitrary clients.
type Service struct {
	Key     ed25519.PrivateKey
	Catalog *Catalog
	// Country resolves the *observed* socket source IP using a trusted host
	// database. An unknown/expired location never becomes READY.
	Country          func(net.IP) (string, error)
	Budget           *RelayBudget
	mu               sync.Mutex
	controls         map[string]*control
	pairs            map[string]*pair
	Revoked          map[string]bool
	revocationFile   string
	revocationFailed bool
	admit            *rate.Limiter
	ctx              context.Context
	cancel           context.CancelFunc
}
type control struct {
	credential Credential
	ws         *websocket.Conn
	send       chan message
	path       string
	country    string
	expires    time.Time
}
type pair struct {
	ticket    Ticket
	guest     *wsConn
	exit      *wsConn
	connected bool
	done      chan struct{}
	once      sync.Once
	principal string
	expires   time.Time
}

func NewService(key ed25519.PrivateKey, country func(net.IP) (string, error)) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{Key: key, Catalog: NewCatalog(), Country: country, controls: map[string]*control{}, pairs: map[string]*pair{}, Revoked: map[string]bool{}, admit: rate.NewLimiter(8, 16), ctx: ctx, cancel: cancel}
	s.Budget, _ = OpenRelayBudget("")
	go s.sweep()
	return s
}
func (s *Service) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("/v1/control", s.control)
	m.HandleFunc("/v1/pair", s.pair)
	return m
}
func (s *Service) Close() {
	s.cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.controls {
		c.ws.Close()
	}
	for _, p := range s.pairs {
		p.close()
	}
}
func (s *Service) Revoke(device string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := ParsePublic(device); err != nil {
		return err
	}
	s.Revoked[device] = true
	if c := s.controls[device]; c != nil {
		c.ws.Close()
	}
	for _, p := range s.pairs {
		if p.ticket.Guest == device || p.ticket.Exit == device {
			p.close()
		}
	}
	if s.revocationFile != "" {
		if err := atomicFile(s.revocationFile, s.Revoked); err != nil {
			s.revocationFailed = true
			return err
		}
	}
	return nil
}
func (s *Service) Denied(device string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.revocationFailed || s.Revoked[device]
}

var upgrader = websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }, HandshakeTimeout: 5 * time.Second}

func (s *Service) authenticate(w http.ResponseWriter, r *http.Request, scope string) (*websocket.Conn, Credential, error) {
	if !s.admit.Allow() {
		http.Error(w, "busy", http.StatusTooManyRequests)
		return nil, Credential{}, errors.New("admission rate")
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil, Credential{}, err
	}
	ws.SetReadLimit(maxMessage)
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	challenge := randomID()
	if err = ws.WriteJSON(message{Type: "challenge", Challenge: challenge}); err != nil {
		ws.Close()
		return nil, Credential{}, err
	}
	var m message
	err = ws.ReadJSON(&m)
	if err == nil && (m.Type != "auth" || m.Credential == nil) {
		err = errors.New("missing authentication")
	}
	if err == nil {
		err = m.Credential.Verify(s.Key.Public().(ed25519.PublicKey), time.Now())
	}
	if err == nil && !verifyProof(m.Credential.Claims.Device, challenge, scope, m.Proof) {
		err = errors.New("invalid device proof")
	}
	if err == nil {
		revoked := s.Denied(m.Credential.Claims.Device)
		if revoked {
			err = errors.New("revoked device")
		}
	}
	if err != nil {
		ws.Close()
		return nil, Credential{}, err
	}
	return ws, *m.Credential, nil
}
func (s *Service) control(w http.ResponseWriter, r *http.Request) {
	ws, credential, err := s.authenticate(w, r, "control")
	if err != nil {
		return
	}
	defer ws.Close()
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	cc := ""
	if s.Country != nil {
		cc, _ = s.Country(net.ParseIP(host))
	}
	c := &control{credential: credential, ws: ws, send: make(chan message, 16), path: randomID(), country: cc, expires: time.Unix(credential.Claims.Expires, 0)}
	device := credential.Claims.Device
	s.mu.Lock()
	if len(s.controls) >= 128 || s.controls[device] != nil {
		s.mu.Unlock()
		return
	}
	s.controls[device] = c
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.controls[device] == c {
			delete(s.controls, device)
		}
		for _, p := range s.pairs {
			if p.ticket.Guest == device || p.ticket.Exit == device {
				p.close()
			}
		}
		s.mu.Unlock()
		s.Catalog.Remove(device, c.path, time.Now())
	}()
	initial, events, unsubscribe := s.Catalog.Subscribe(time.Now())
	defer unsubscribe()
	c.send <- message{Type: "authenticated", Country: cc, Observed: host}
	c.send <- initial
	writerDone := make(chan struct{})
	writerStop := make(chan struct{})
	go func() {
		defer close(writerDone)
		defer ws.Close()
		for {
			var m message
			select {
			case m = <-c.send:
			case update, ok := <-events:
				if !ok {
					return
				}
				m = update
			case <-s.ctx.Done():
				return
			case <-writerStop:
				return
			}
			ws.SetWriteDeadline(time.Now().Add(3 * time.Second))
			if ws.WriteJSON(m) != nil {
				return
			}
		}
	}()
	defer func() {
		close(writerStop)
		ws.Close()
		select {
		case <-writerDone:
		case <-time.After(4 * time.Second):
		}
	}()
	ws.SetReadDeadline(time.Now().Add(PresenceTTL))
	for {
		var m message
		if ws.ReadJSON(&m) != nil {
			return
		}
		if time.Now().After(c.expires) {
			return
		}
		ws.SetReadDeadline(time.Now().Add(PresenceTTL))
		switch m.Type {
		case "presence":
			if !m.Ready {
				s.mu.Lock()
				for _, p := range s.pairs {
					if p.ticket.Exit == device {
						p.close()
					}
				}
				s.mu.Unlock()
			}
			if !credential.Claims.Exit || !validCountry(cc) {
				s.reply(c, message{Type: "error", ID: m.ID, Error: "exit location is not verified"})
				continue
			}
			err = s.Catalog.Update(device, c.path, m.Epoch, cc, m.Revision, m.Slots, m.Ready, time.Now())
			if err != nil {
				s.reply(c, message{Type: "error", ID: m.ID, Error: err.Error()})
			} else {
				s.reply(c, message{Type: "presence-ack", Epoch: m.Epoch, Revision: m.Revision, Ready: m.Ready})
			}
		case "heartbeat":
			if s.Country != nil {
				current, _ := s.Country(net.ParseIP(host))
				if current != cc || !validCountry(current) {
					s.Catalog.Remove(device, c.path, time.Now())
					if credential.Claims.Exit {
						return
					}
				}
			}
			// Heartbeats refresh the existing state, but never restore withdrawn consent.
			s.Catalog.Touch(device, c.path, time.Now())
			s.reply(c, message{Type: "heartbeat"})
		case "reserve":
			if !credential.Claims.Guest {
				continue
			}
			t, e := s.reserve(c, m.Country, m.ID)
			if e != nil {
				s.reply(c, message{Type: "reservation", ID: m.ID, Error: e.Error()})
			} else {
				s.reply(c, message{Type: "reservation", ID: m.ID, Ticket: &t})
			}
		case "release":
			s.mu.Lock()
			p := s.pairs[m.ID]
			if p != nil && p.ticket.Guest == device {
				p.close()
			}
			s.mu.Unlock()
		case "renew":
			s.mu.Lock()
			p := s.pairs[m.ID]
			if p != nil && p.connected && p.ticket.Exit == device && p.ticket.Epoch == m.Epoch {
				if !time.Now().Before(p.expires) || !s.Catalog.Renew(p.ticket, time.Now()) {
					p.close()
				} else {
					p.expires = time.Now().Add(time.Minute)
				}
			}
			s.mu.Unlock()
		default:
			return
		}
	}
}
func (s *Service) reply(c *control, m message) bool {
	select {
	case c.send <- m:
		return true
	default:
		c.ws.Close()
		return false
	}
}
func (s *Service) reserve(c *control, country, id string) (Ticket, error) {
	if country != "" && !validCountry(country) {
		return Ticket{}, errors.New("invalid country")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pairs) >= 256 {
		return Ticket{}, errors.New("relay at capacity")
	}
	active := 0
	for _, p := range s.pairs {
		if p.ticket.Guest == c.credential.Claims.Device {
			active++
		}
	}
	if active >= 2 {
		return Ticket{}, errors.New("guest session limit")
	}
	t, err := s.Catalog.Reserve(c.credential.Claims.Device, country, id, time.Now())
	if err != nil {
		return t, err
	}
	if s.pairs[t.ID] != nil {
		return t, nil
	}
	exit := s.controls[t.Exit]
	if exit == nil {
		s.Catalog.Release(t, time.Now())
		return Ticket{}, errors.New("exit disconnected")
	}
	p := &pair{ticket: t, done: make(chan struct{}), principal: c.credential.Claims.Principal}
	s.pairs[t.ID] = p
	if !s.reply(exit, message{Type: "offer", Ticket: &t}) {
		p.close()
		return Ticket{}, errors.New("exit busy")
	}
	return t, nil
}
func (p *pair) close() {
	p.once.Do(func() {
		close(p.done)
		if p.guest != nil {
			p.guest.Close()
		}
		if p.exit != nil {
			p.exit.Close()
		}
	})
}
func (s *Service) pair(w http.ResponseWriter, r *http.Request) {
	ws, credential, err := s.authenticate(w, r, "pair")
	if err != nil {
		return
	}
	defer ws.Close()
	var join message
	if ws.ReadJSON(&join) != nil || join.Type != "join" || join.Ticket == nil {
		return
	}
	t := *join.Ticket
	s.mu.Lock()
	p := s.pairs[t.ID]
	valid := p != nil && p.ticket == t && t.Expires > time.Now().UnixMilli()
	if valid {
		select {
		case <-p.done:
			valid = false
		default:
		}
	}
	device := credential.Claims.Device
	if valid {
		switch join.Role {
		case "guest":
			valid = device == t.Guest && credential.Claims.Guest && p.guest == nil
		case "exit":
			valid = device == t.Exit && credential.Claims.Exit && p.exit == nil
		default:
			valid = false
		}
	}
	if !valid {
		s.mu.Unlock()
		return
	}
	conn := newWS(ws)
	if join.Role == "guest" {
		p.guest = conn
	} else {
		p.exit = conn
	}
	if p.guest != nil && p.exit != nil && !p.connected {
		if !s.Catalog.Hold(t, time.Now()) {
			p.close()
			delete(s.pairs, t.ID)
			s.Catalog.Release(t, time.Now())
		} else {
			p.connected = true
			p.expires = time.Now().Add(time.Minute)
			go s.forward(p)
		}
	}
	s.mu.Unlock()
	select {
	case <-p.done:
	case <-s.ctx.Done():
	}
}
func (s *Service) forward(p *pair) {
	defer func() {
		s.mu.Lock()
		p.close()
		delete(s.pairs, p.ticket.ID)
		s.mu.Unlock()
		s.Catalog.Release(p.ticket, time.Now())
	}()
	// Relay allowance is global per pair, finite and independent from exit consent.
	ctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	go func() { <-ctx.Done(); s.mu.Lock(); p.close(); s.mu.Unlock() }()
	// Clear authentication read deadlines before the encrypted carrier begins.
	p.guest.SetDeadline(time.Time{})
	p.exit.SetDeadline(time.Time{})
	done := make(chan struct{}, 2)
	copyOne := func(dst, src *wsConn) { _ = s.Budget.copy(ctx, dst, src, p.principal); done <- struct{}{} }
	go copyOne(p.exit, p.guest)
	go copyOne(p.guest, p.exit)
	<-done
	p.close()
	<-done
}
func (s *Service) sweep() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case now := <-ticker.C:
			s.mu.Lock()
			for id, p := range s.pairs {
				if p.connected && !now.Before(p.expires) {
					p.close()
				}
				if !p.connected && p.ticket.Expires <= now.UnixMilli() {
					p.close()
					delete(s.pairs, id)
					s.Catalog.Release(p.ticket, now)
				}
			}
			s.mu.Unlock()
			s.Catalog.Sweep(now)
		}
	}
}

// ConstantTimeSecret can be used by a trusted enrollment host. Enrollment is
// intentionally not an anonymous public endpoint in this protocol package.
func ConstantTimeSecret(got, want string) bool {
	return len(want) >= 32 && subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(got, "Bearer ")), []byte(want)) == 1
}
