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
