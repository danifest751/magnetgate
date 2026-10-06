package peer

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGuestPreparesColdLinkBeforeShortReservation(t *testing.T) {
	root, _ := NewIdentity()
	service := NewService(root.Key, func(net.IP) (string, error) { return "DE", nil })
	defer service.Close()
	server := httptest.NewTLSServer(service.Handler())
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	network := &testNetwork{}
	network.ready.Store(true)
	var guestDials atomic.Int32
	newClient := func(exit bool) *Client {
		store, id, err := OpenStore(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		c := &Client{Identity: id, Store: store, Network: network,
			URL:        strings.Replace(server.URL, "https:", "wss:", 1),
			OuterTLS:   &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13},
			Authority:  root.Key.Public().(ed25519.PublicKey),
			Credential: IssueCredential(root.Key, Claims{Device: id.Public(), Principal: randomID(), Guest: true, Exit: exit, Expires: time.Now().Add(time.Hour).Unix()})}
		if !exit {
			c.LinkDial = func(ctx context.Context, network, address string) (net.Conn, error) {
				if guestDials.Add(1) == 2 {
					// A cold connection takes longer than the unchanged reservation TTL.
					timer := time.NewTimer(ReservationTTL + 200*time.Millisecond)
					defer timer.Stop()
					select {
					case <-timer.C:
					case <-ctx.Done():
						return nil, ctx.Err()
					}
				}
				return (&net.Dialer{}).DialContext(ctx, network, address)
			}
		}
		if err := c.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Stop() })
		return c
	}
	exit, guest := newClient(true), newClient(false)
	await(t, func() bool { return exit.Status().Connected && guest.Status().Connected })
	p := DefaultPolicy()
	p.Enabled = true
	if err := exit.SetPolicy(p); err != nil {
		t.Fatal(err)
	}
	await(t, func() bool { return len(guest.Status().Countries) == 1 })
	host := &Host{Client: guest, Store: guest.Store, Identity: guest.Identity, ctx: context.Background()}
	host.ActivateGuest("first")
	endpoint, err := host.Connect("DE", 0, "first")
	if err != nil {
		t.Fatal("cold service setup consumed the reservation:", err)
	}
	defer host.Disconnect()
	if endpoint.Country != "DE" || guestDials.Load() != 2 {
		t.Fatal("wrong country or unexpected fallback")
	}
	first := host.guest
	first.traffic.sent.Add(11)
	host.ActivateGuest("second")
	if _, err = host.Connect("DE", 0, "second"); err != nil {
		t.Fatal(err)
	}
	if host.guest == first {
		t.Fatal("new session reused a guest with old counters")
	}
	host.guest.traffic.received.Add(23)
	first.traffic.sent.Add(99)
	status := host.Status()
	if status.Sent != 0 || status.Received != 23 {
		t.Fatal("traffic charged to the wrong session", status.Sent, status.Received)
	}
}

func TestHostTrafficSurvivesRecoveryButResetsForNewSession(t *testing.T) {
	h := &Host{}
	h.ActivateGuest("first")
	first := h.traffic.Load()
	first.sent.Add(11)
	first.received.Add(23)
	h.ActivateGuest("first")
	if h.traffic.Load() != first {
		t.Fatal("same-session recovery reset traffic")
	}
	h.ActivateGuest("second")
	second := h.traffic.Load()
	first.received.Add(99) // a closing old flow must not charge the new session
	if second == first || second.sent.Load() != 0 || second.received.Load() != 0 {
		t.Fatal("old session leaked into new counters")
	}
	h.cancelConnect()
	if h.traffic.Load() == second {
		t.Fatal("Disconnect retained the old session")
	}
}

type delayedReadyNetwork struct {
	testNetwork
	readyAfter atomic.Int64
	waiting    atomic.Bool
}

func (n *delayedReadyNetwork) Ready() bool {
	if until := time.Unix(0, n.readyAfter.Load()); time.Now().Before(until) {
		n.waiting.Store(true)
		time.Sleep(time.Until(until))
	}
	return n.testNetwork.Ready()
}

func coldOwnerClients(t *testing.T) (*Client, *Client, *delayedReadyNetwork, *atomic.Int32, *Service) {
	t.Helper()
	root, _ := NewIdentity()
	service := NewService(root.Key, func(net.IP) (string, error) { return "DE", nil })
	t.Cleanup(service.Close)
	server := httptest.NewTLSServer(service.Handler())
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	network := &delayedReadyNetwork{}
	network.ready.Store(true)
	var ownerDials atomic.Int32
	newClient := func(owner bool) *Client {
		store, id, err := OpenStore(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		c := &Client{Identity: id, Store: store, Network: network,
			URL:        strings.Replace(server.URL, "https:", "wss:", 1),
			OuterTLS:   &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13},
			Authority:  root.Key.Public().(ed25519.PublicKey),
			Credential: IssueCredential(root.Key, Claims{Device: id.Public(), Principal: randomID(), Guest: true, Exit: owner, Expires: time.Now().Add(time.Hour).Unix()})}
		if owner {
			c.LinkDial = func(ctx context.Context, kind, address string) (net.Conn, error) {
				if ownerDials.Add(1) == 2 {
					// The relay join still fits its three-second reservation. Slow
					// physical-network callbacks then delay the inner authorization.
					timer := time.NewTimer(2 * time.Second)
					defer timer.Stop()
					select {
					case <-timer.C:
					case <-ctx.Done():
						return nil, ctx.Err()
					}
					network.readyAfter.Store(time.Now().Add(3300 * time.Millisecond).UnixNano())
				}
				return (&net.Dialer{}).DialContext(ctx, kind, address)
			}
		}
		if err := c.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Stop() })
		return c
	}
	owner, guest := newClient(true), newClient(false)
	await(t, func() bool { return owner.Status().Connected && guest.Status().Connected })
	policy := DefaultPolicy()
	policy.Enabled = true
	if err := owner.SetPolicy(policy); err != nil {
		t.Fatal(err)
	}
	await(t, func() bool { return len(guest.Status().Countries) == 1 })
	return owner, guest, network, &ownerDials, service
}

func TestOwnerColdLinkLeavesTimeForPinnedSessionAuthorization(t *testing.T) {
	owner, guest, _, ownerDials, _ := coldOwnerClients(t)
	g, err := guest.OpenGuest(context.Background(), "DE")
	if err != nil {
		t.Fatal("owner dropped an admitted pair before authorization completed:", err)
	}
	defer g.Close()
	if g.Country() != "DE" || ownerDials.Load() != 2 {
		t.Fatal("unexpected fallback or extra dial")
	}
	if !g.renewOnce() {
		t.Fatal("new session cannot renew its pinned authorization")
	}
	policy := owner.Store.Policy()
	policy.Enabled = false
	if err := owner.SetPolicy(policy); err != nil {
		t.Fatal(err)
	}
	await(t, func() bool { return len(guest.Status().Countries) == 0 })
	if g.renewOnce() {
		t.Fatal("slow setup survived consent withdrawal")
	}
}

func TestOwnerColdSetupCannotFinishAfterConsentWithdrawal(t *testing.T) {
	owner, guest, network, _, service := coldOwnerClients(t)
	result := make(chan error, 1)
	go func() {
		g, err := guest.OpenGuest(context.Background(), "DE")
		if g != nil {
			g.Close()
		}
		result <- err
	}()
	admitted := func() bool {
		service.mu.Lock()
		defer service.mu.Unlock()
		for _, pair := range service.pairs {
			if pair.ticket.Exit == owner.Identity.Public() && pair.connected {
				return true
			}
		}
		return false
	}
	// Require relay admission and a slow callback while authorization is pending.
	until := time.Now().Add(4 * time.Second)
	for !(network.waiting.Load() && admitted()) && time.Now().Before(until) {
		time.Sleep(10 * time.Millisecond)
	}
	if !network.waiting.Load() || !admitted() {
		t.Fatal("admitted setup did not reach the slow network callback")
	}
	policy := owner.Store.Policy()
	policy.Enabled = false
	if err := owner.SetPolicy(policy); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("pending setup completed after consent withdrawal")
		}
	case <-time.After(8 * time.Second):
		t.Fatal("cancelled setup did not finish within its bound")
	}
	await(t, func() bool { return len(guest.Status().Countries) == 0 })
}
