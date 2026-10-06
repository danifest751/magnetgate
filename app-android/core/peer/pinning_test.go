package peer

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"testing"
	"time"
)

type pinnedTestNetwork struct {
	token     string
	dialed    bool
	addresses []netip.Addr
}

func (*pinnedTestNetwork) Ready() bool             { return true }
func (*pinnedTestNetwork) Blocked(netip.Addr) bool { return false }
func (*pinnedTestNetwork) Resolve(context.Context, string) ([]netip.Addr, error) {
	panic("unpinned resolution")
}
func (*pinnedTestNetwork) Dial(context.Context, string) (net.Conn, error) { panic("unpinned dial") }
func (n *pinnedTestNetwork) ResolvePinned(context.Context, string) ([]netip.Addr, string, error) {
	return n.addresses, n.token, nil
}
func (n *pinnedTestNetwork) DialPinned(_ context.Context, address, token string) (net.Conn, error) {
	if token != "original" {
		return nil, errors.New("stale generation")
	}
	if address != "1.1.1.1:443" {
		panic("DNS answer not pinned")
	}
	n.dialed = true
	a, b := net.Pipe()
	b.Close()
	return a, nil
}
func TestGuardCarriesGenerationAndValidatesAllAnswers(t *testing.T) {
	for _, tc := range []struct {
		name, token string
		addresses   []netip.Addr
		allowed     bool
	}{
		{"valid", "original", []netip.Addr{netip.MustParseAddr("1.1.1.1")}, true},
		{"handover", "stale", []netip.Addr{netip.MustParseAddr("1.1.1.1")}, false},
		{"missing pin", "", []netip.Addr{netip.MustParseAddr("1.1.1.1")}, false},
		{"mixed private answer", "original", []netip.Addr{netip.MustParseAddr("1.1.1.1"), netip.MustParseAddr("192.168.1.1")}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n := &pinnedTestNetwork{token: tc.token, addresses: tc.addresses}
			conn, err := guardedDial(context.Background(), n, "example.org", 443)
			if conn != nil {
				conn.Close()
			}
			if (err == nil) != tc.allowed || n.dialed != tc.allowed {
				t.Fatalf("allowed=%v dialed=%v error=%v", tc.allowed, n.dialed, err)
			}
		})
	}
}

func TestQuotaDoesNotResetWhenClockMovesBack(t *testing.T) {
	s, _, err := OpenStore(t.TempDir())
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
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	if err = s.charge(65536, now); err != nil {
		t.Fatal(err)
	}
	for _, previous := range []time.Time{now.Add(-24 * time.Hour), now.AddDate(0, -1, 0)} {
		if s.available(previous) {
			t.Fatal("backward clock restored exhausted quota")
		}
		if s.charge(1, previous) == nil {
			t.Fatal("backward clock erased used bytes")
		}
	}
	// Tomorrow restores only the daily quota; next month restores both.
	if s.available(now.AddDate(0, 0, 1)) {
		t.Fatal("monthly quota reset at midnight")
	}
	if err = s.charge(1, now.AddDate(0, 1, 0)); err != nil {
		t.Fatal(err)
	}
}
