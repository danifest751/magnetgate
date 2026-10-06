package peer

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"magnetgate/core/socks"
)

type HostConfig struct {
	URL             string `json:"url"`
	Authority       string `json:"authority"`
	EnrollmentToken string `json:"enrollmentToken"`
	CA              string `json:"ca,omitempty"`
}
type HostStatus struct {
	Status
	Configured     bool   `json:"configured"`
	CanShare       bool   `json:"canShare"`
	Policy         Policy `json:"policy"`
	Device         string `json:"device"`
	GuestCountry   string `json:"guestCountry,omitempty"`
	GuestConnected bool   `json:"guestConnected"`
}
type GuestEndpoint struct {
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	Country  string `json:"country"`
}
type Host struct {
	mu           sync.Mutex
	Client       *Client
	Store        *Store
	Identity     Identity
	config       HostConfig
	outer        *tls.Config
	linkDial     func(context.Context, string, string) (net.Conn, error)
	ctx          context.Context
	guest        *Guest
	socks        *socks.Server
	endpoint     GuestEndpoint
	network      Network
	guestInfo    atomic.Pointer[guestInfo]
	opMu         sync.Mutex
	opCancel     context.CancelFunc
	opGeneration uint64
	guestToken   string
}
type guestInfo struct {
	country string
	session *Guest
}

func OpenHost(ctx context.Context, dir string, network Network, dial ...func(context.Context, string, string) (net.Conn, error)) (*Host, error) {
	store, id, err := OpenStore(dir)
	if err != nil {
		return nil, err
	}
	h := &Host{Store: store, Identity: id, ctx: ctx, network: network}
	if len(dial) > 0 {
		h.linkDial = dial[0]
	}
	if err = readJSON(filepath.Join(dir, "service.json"), &h.config); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return h, nil
		}
		return nil, err
	}
	if h.config.CA != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(h.config.CA)) {
			return nil, errors.New("invalid peer service CA")
		}
		h.outer = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS13}
	}
	if err = h.startClient(); err != nil {
		return nil, err
	}
	return h, nil
}
func (h *Host) startClient() error {
	authority, err := ParsePublic(h.config.Authority)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(h.ctx, 5*time.Second)
	defer cancel()
	credential, err := Enroll(ctx, h.config.URL, h.config.EnrollmentToken, h.Identity.Public(), h.outer, h.linkDial)
	if err != nil {
		return err
	}
	c := &Client{Identity: h.Identity, Store: h.Store, Credential: credential, Authority: authority, URL: h.config.URL, OuterTLS: h.outer, Network: h.network, LinkDial: h.linkDial}
	c.RefreshCredential = func(ctx context.Context) (Credential, error) {
		return Enroll(ctx, h.config.URL, h.config.EnrollmentToken, h.Identity.Public(), h.outer, h.linkDial)
	}
	if err = c.Start(h.ctx); err != nil {
		return err
	}
	h.Client = c
	return nil
}
func (h *Host) Status() HostStatus {
	s := HostStatus{Status: Status{State: "OFFLINE", Countries: []Country{}}, Configured: h.Client != nil, Policy: h.Store.Policy(), Device: h.Identity.Public()}
	if h.Client != nil {
		s.Status = h.Client.Status()
		s.CanShare = h.Client.CanShare()
	}
	if info := h.guestInfo.Load(); info != nil {
		s.GuestCountry = info.country
		s.GuestConnected = !info.session.session.IsClosed()
	}
	return s
}
func (h *Host) SetPolicy(p Policy) error {
	if h.Client == nil {
		return errors.New("peer service is not configured")
	}
	return h.Client.SetPolicy(p)
}
func (h *Host) disconnect() {
	h.guestInfo.Store(nil)
	if h.socks != nil {
		h.socks.Close()
		h.socks = nil
	}
	if h.guest != nil {
		h.guest.Close()
		h.guest = nil
	}
	h.endpoint = GuestEndpoint{}
}
func (h *Host) cancelConnect() {
	h.opMu.Lock()
	defer h.opMu.Unlock()
	h.opGeneration++
	h.guestToken = ""
	if h.opCancel != nil {
		h.opCancel()
		h.opCancel = nil
	}
}
func (h *Host) Disconnect() { h.cancelConnect(); h.mu.Lock(); defer h.mu.Unlock(); h.disconnect() }
func (h *Host) ActivateGuest(token string) {
	h.opMu.Lock()
	defer h.opMu.Unlock()
	if h.opCancel != nil {
		h.opCancel()
	}
	h.guestToken = token
}
func (h *Host) Connect(country string, port int, token ...string) (GuestEndpoint, error) {
	h.opMu.Lock()
	if len(token) > 0 && (token[0] == "" || h.guestToken != token[0]) {
		h.opMu.Unlock()
		return GuestEndpoint{}, context.Canceled
	}
	if h.opCancel != nil {
		h.opCancel()
	}
	ctx, cancel := context.WithCancel(h.ctx)
	h.opGeneration++
	generation := h.opGeneration
	h.opCancel = cancel
	h.opMu.Unlock()
	defer func() {
		cancel()
		h.opMu.Lock()
		defer h.opMu.Unlock()
		if h.opGeneration == generation {
			h.opCancel = nil
		}
	}()
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return GuestEndpoint{}, err
	}
	if h.Client == nil {
		return GuestEndpoint{}, errors.New("peer service is not configured")
	}
	if h.guest != nil && !h.guest.session.IsClosed() && (country == "" || h.endpoint.Country == country) && (port == 0 || h.endpoint.Port == port) {
		return h.endpoint, nil
	}
	h.disconnect()
	g, err := h.Client.OpenGuest(ctx, country)
	if err != nil {
		return GuestEndpoint{}, err
	}
	if err := ctx.Err(); err != nil {
		g.Close()
		return GuestEndpoint{}, err
	}
	username, password := randomID(), randomID()
	server, err := socks.ListenAuthenticated(port, username, password, g.Dial)
	if err != nil {
		g.Close()
		return GuestEndpoint{}, err
	}
	_, p, _ := net.SplitHostPort(server.Addr().String())
	number, _ := strconv.Atoi(p)
	h.guest = g
	h.socks = server
	h.endpoint = GuestEndpoint{number, username, password, g.Country()}
	h.guestInfo.Store(&guestInfo{g.Country(), g})
	return h.endpoint, nil
}
func (h *Host) Close() error {
	h.cancelConnect()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.disconnect()
	if h.Client != nil {
		return h.Client.Stop()
	}
	return nil
}
func (h *Host) JSON() string { b, _ := json.Marshal(h.Status()); return string(b) }
