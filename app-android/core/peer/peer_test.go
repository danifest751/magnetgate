package peer

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCredentialBoundary(t *testing.T) {
	root, _ := NewIdentity()
	device, _ := NewIdentity()
	now := time.Now()
	c := IssueCredential(root.Key, Claims{Device: device.Public(), Principal: "test", Guest: true, Expires: now.Add(time.Hour).Unix()})
	if err := c.Verify(root.Key.Public().(ed25519.PublicKey), now); err != nil {
		t.Fatal(err)
	}
	c.Claims.Exit = true
	if c.Verify(root.Key.Public().(ed25519.PublicKey), now) == nil {
		t.Fatal("modified role accepted")
	}
	if verifyProof(device.Public(), "fresh", "control", proof(device.Key, "old", "control")) {
		t.Fatal("replayed challenge accepted")
	}
	if verifyProof(device.Public(), "fresh", "pair", proof(device.Key, "fresh", "control")) {
		t.Fatal("cross-channel proof accepted")
	}
}
func TestCatalogReservationAndExpiry(t *testing.T) {
	c := NewCatalog()
	now := time.Now()
	if err := c.Update("exit", "path", "epoch", "DE", 1, 2, true, now); err != nil {
		t.Fatal(err)
	}
	initial, ch, stop := c.Subscribe(now)
	defer stop()
	if len(initial.Countries) != 1 {
		t.Fatal(initial)
	}
	id := randomID()
	a, err := c.Reserve("guest", "DE", id, now)
	if err != nil {
		t.Fatal(err)
	}
	b, err := c.Reserve("guest", "DE", id, now)
	if err != nil || a != b {
		t.Fatal("not idempotent", err)
	}
	if _, err = c.Reserve("guest", "US", randomID(), now); err == nil {
		t.Fatal("country fallback")
	}
	if _, err = c.Reserve("guest2", "DE", randomID(), now); err != nil {
		t.Fatal(err)
	}
	if _, err = c.Reserve("guest3", "DE", randomID(), now); err == nil {
		t.Fatal("overbooked")
	}
	if err = c.Update("exit", "newpath", "newEpoch", "DE", 1, 2, true, now); err != nil {
		t.Fatal(err)
	}
	c.Remove("exit", "path", now)
	snapshot, _, cancel := c.Subscribe(now)
	cancel()
	if len(snapshot.Countries) != 1 {
		t.Fatal("old callback removed new registration")
	}
	if c.Hold(a, now) {
		t.Fatal("old epoch reservation accepted")
	}
	c.Sweep(now.Add(PresenceTTL + time.Millisecond))
	snapshot, _, cancel = c.Subscribe(now.Add(PresenceTTL + time.Millisecond))
	cancel()
	if len(snapshot.Countries) != 0 {
		t.Fatal("expired lease listed")
	}
	select {
	case <-ch:
	default:
		t.Fatal("no pushed change")
	}
}
func TestCatalogAtomicReservation(t *testing.T) {
	c := NewCatalog()
	now := time.Now()
	_ = c.Update("exit", "path", "epoch", "FR", 1, 2, true, now)
	var accepted atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := c.Reserve(randomID(), "FR", randomID(), now); e == nil {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 2 {
		t.Fatalf("admitted %d, expected 2", accepted.Load())
	}
}
func TestStoreCrashAndQuota(t *testing.T) {
	dir := t.TempDir()
	s, i, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	p := DefaultPolicy()
	p.Enabled = true
	p.DailyBytes = 65536
	p.MonthlyBytes = 65536
	if err = s.Save(p); err != nil {
		t.Fatal(err)
	}
	if err = s.Begin(); err != nil {
		t.Fatal(err)
	}
	if err = s.Charge(65536); err != nil {
		t.Fatal(err)
	}
	if s.Charge(1) == nil {
		t.Fatal("quota exceeded")
	}
	recovered, key, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if key.Public() != i.Public() || recovered.Policy().Enabled {
		t.Fatal("unclean startup enabled sharing")
	}
	if err = recovered.Save(p); err != nil {
		t.Fatal(err)
	}
	if err = recovered.Begin(); err != nil {
		t.Fatal(err)
	}
	if recovered.Charge(1) == nil {
		t.Fatal("quota lost after restart")
	}
	// A failed policy write cannot clear the crash interlock.
	if err = os.Mkdir(filepath.Join(dir, "policy.json.block"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(dir, "policy.json")); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(dir, "policy.json"), 0700); err != nil {
		t.Fatal(err)
	}
	p.Enabled = false
	if recovered.Save(p) == nil {
		t.Fatal("unwritable policy was reported saved")
	}
	if _, err = os.Stat(filepath.Join(dir, "unclean.json")); err != nil {
		t.Fatal("crash marker cleared on error")
	}
}

type testNetwork struct {
	ready  atomic.Bool
	target string
	dns    []netip.Addr
}

func (n *testNetwork) Ready() bool                                           { return n.ready.Load() }
func (n *testNetwork) Resolve(context.Context, string) ([]netip.Addr, error) { return n.dns, nil }
func (n *testNetwork) Dial(ctx context.Context, address string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "tcp", n.target)
}
func (n *testNetwork) Blocked(netip.Addr) bool { return false }
func TestPublicGuard(t *testing.T) {
	for _, a := range []string{"127.0.0.1", "10.0.0.1", "100.64.0.1", "192.0.2.1", "::1", "::ffff:192.168.1.1", "64:ff9b::808:808", "2001:db8::1", "2002:0808:0808::1", "fe80::1%eth0"} {
		if PublicTarget(netip.MustParseAddr(a)) {
			t.Error("allowed", a)
		}
	}
	for _, a := range []string{"8.8.8.8", "2606:4700:4700::1111"} {
		if !PublicTarget(netip.MustParseAddr(a)) {
			t.Error("denied", a)
		}
	}
	n := &testNetwork{dns: []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")}}
	n.ready.Store(true)
	if _, e := guardedDial(context.Background(), n, "rebinding.test", 443); e == nil {
		t.Fatal("mixed public/private DNS accepted")
	}
}
func await(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for !fn() {
		if time.Now().After(deadline) {
			t.Fatal("condition did not become true")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRelayEndToEndAndConsentRevocation(t *testing.T) {
	root, _ := NewIdentity()
	s := NewService(root.Key, func(net.IP) (string, error) { return "DE", nil })
	defer s.Close()
	server := httptest.NewTLSServer(s.Handler())
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	outer := &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}
	ln, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer ln.Close()
	go func() {
		for {
			conn, e := ln.Accept()
			if e != nil {
				return
			}
			go func() { defer conn.Close(); io.Copy(conn, conn) }()
		}
	}()
	network := &testNetwork{target: ln.Addr().String(), dns: []netip.Addr{netip.MustParseAddr("8.8.8.8")}}
	network.ready.Store(true)
	newClient := func(exit bool) *Client {
		store, id, e := OpenStore(t.TempDir())
		if e != nil {
			t.Fatal(e)
		}
		cred := IssueCredential(root.Key, Claims{Device: id.Public(), Principal: randomID(), Guest: true, Exit: exit, Expires: time.Now().Add(time.Hour).Unix()})
		c := &Client{Identity: id, Store: store, Credential: cred, Authority: root.Key.Public().(ed25519.PublicKey), URL: strings.Replace(server.URL, "https:", "wss:", 1), OuterTLS: outer, Network: network}
		if e = c.Start(context.Background()); e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() {
			if e := c.Stop(); e != nil {
				t.Error(e)
			}
		})
		return c
	}
	exit, guest := newClient(true), newClient(false)
	await(t, func() bool { return exit.Status().Connected && guest.Status().Connected })
	p := DefaultPolicy()
	p.Enabled = true
	if e = exit.SetPolicy(p); e != nil {
		t.Fatal(e)
	}
	await(t, func() bool { return len(guest.Status().Countries) == 1 })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, e = guest.OpenGuest(ctx, "US"); e == nil {
		t.Fatal("explicit country silently changed")
	}
	g, e := guest.OpenGuest(ctx, "DE")
	if e != nil {
		t.Fatal("pair", e)
	}
	defer g.Close()
	stream, e := g.Dial(ctx, "public.test", 443)
	if e != nil {
		t.Fatal("dial", e)
	}
	defer stream.Close()
	if _, e = stream.Write([]byte("secret peer payload")); e != nil {
		t.Fatal(e)
	}
	b := make([]byte, len("secret peer payload"))
	if _, e = io.ReadFull(stream, b); e != nil {
		t.Fatal(e)
	}
	if string(b) != "secret peer payload" {
		t.Fatal(string(b))
	}
	// Use every data slot with real encrypted TCP streams. The management channel
	// must still renew without replacing the existing flow or connection.
	for i := 1; i < 32; i++ {
		time.Sleep(300 * time.Millisecond)
		flow, err := g.Dial(context.Background(), "public.test", 443)
		if err != nil {
			t.Fatal("saturation", i, err)
		}
		defer flow.Close()
	}
	if !g.renewOnce() {
		t.Fatal("renewal blocked by 32 live data flows")
	}
	if _, e = stream.Write([]byte("still connected")); e != nil {
		t.Fatal(e)
	}
	b = make([]byte, len("still connected"))
	if _, e = io.ReadFull(stream, b); e != nil || string(b) != "still connected" {
		t.Fatal("renewal replaced a live flow", e)
	}
	p.Enabled = false
	if e = exit.SetPolicy(p); e != nil {
		t.Fatal(e)
	}
	await(t, func() bool { return len(guest.Status().Countries) == 0 })
	if g.renewOnce() {
		t.Fatal("withdrawn exit still renews leases")
	}
	if _, e = g.Dial(ctx, "public.test", 443); e == nil {
		t.Fatal("revoked exit still dialing")
	}
	if _, e = guest.OpenGuest(ctx, "DE"); e == nil {
		t.Fatal("withdrawn consent still discoverable")
	}
}
