package mgbox

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"magnetgate/core/peer"
)

type testPhysicalPlatform struct {
	mu       sync.Mutex
	snapshot physicalState
	answer   physicalAnswer
	lookups  atomic.Int32
	binds    atomic.Int32
}

func (p *testPhysicalPlatform) State() (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	b, _ := json.Marshal(p.snapshot)
	return string(b), nil
}
func (p *testPhysicalPlatform) Resolve(string) (string, error) {
	p.lookups.Add(1)
	p.mu.Lock()
	defer p.mu.Unlock()
	b, _ := json.Marshal(p.answer)
	return string(b), nil
}
func (p *testPhysicalPlatform) Bind(int64, string) error { p.binds.Add(1); return nil }
func readyPhysical() (*mobilePeerNetwork, *testPhysicalPlatform) {
	p := &testPhysicalPlatform{snapshot: physicalState{Generation: "wifi/address1", Allowed: true, Prefixes: []string{"192.168.1.0/24", "2001:4860:abcd::/64"}, Addresses: []string{"8.8.8.8"}}, answer: physicalAnswer{Generation: "wifi/address1", Addresses: []string{"1.1.1.1"}}}
	n := newMobilePeerNetwork(p)
	n.baseline = p.snapshot.Generation
	n.observed = netip.MustParseAddr("9.9.9.9")
	n.allowed = true
	return n, p
}
func TestPhysicalGuardDeniesOnLinkAndOwnAddresses(t *testing.T) {
	n, _ := readyPhysical()
	n.controls[netip.MustParseAddr("8.8.4.4")] = true
	for _, v := range []string{"192.168.1.23", "2001:4860:abcd::123", "8.8.8.8", "8.8.4.4", "9.9.9.9"} {
		if !n.Blocked(netip.MustParseAddr(v)) {
			t.Fatalf("allowed local/control/self target %s", v)
		}
	}
	if n.Blocked(netip.MustParseAddr("1.1.1.1")) {
		t.Fatal("ordinary public target denied")
	}
}
func TestPhysicalHandoverInvalidatesDnsToken(t *testing.T) {
	n, p := readyPhysical()
	_, token, err := n.ResolvePinned(context.Background(), "example.org")
	if err != nil {
		t.Fatal(err)
	}
	// The Android handle remains the same but link properties change.
	p.mu.Lock()
	p.snapshot.Generation = "wifi/address2"
	p.mu.Unlock()
	if n.Ready() {
		t.Fatal("handover did not withdraw readiness")
	}
	n.mu.Lock()
	n.baseline = "wifi/address2"
	n.observed = netip.MustParseAddr("8.8.4.4")
	n.mu.Unlock()
	if _, err = n.DialPinned(context.Background(), "1.1.1.1:443", token); err == nil {
		t.Fatal("old DNS token accepted after reauthentication")
	}
	if p.binds.Load() != 0 {
		t.Fatal("stale token opened physical socket")
	}
}
func TestPhysicalSuspendClosesSocketsAndCancelsPendingDial(t *testing.T) {
	n, _ := readyPhysical()
	_, token, err := n.ResolvePinned(context.Background(), "example.org")
	if err != nil {
		t.Fatal(err)
	}
	a, b := net.Pipe()
	defer b.Close()
	target := &physicalConn{Conn: a, owner: n, target: true}
	n.targets[target] = true
	pending, cancel := context.WithCancel(context.Background())
	n.pending[1] = cancel
	n.dials.Add(1)
	finished := make(chan struct{})
	go func() { <-pending.Done(); n.dials.Done(); close(finished) }()
	n.suspend()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("suspend returned before pending cancellation")
	}
	b.SetReadDeadline(time.Now().Add(time.Second))
	if _, err = b.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("target survived suspend: %v", err)
	}
	target.Close()
	n.resume()
	if _, err = n.DialPinned(context.Background(), "1.1.1.1:443", token); err == nil {
		t.Fatal("pre-pause DNS token accepted after resume")
	}
}
func TestPhysicalServiceHostnameCannotBecomeGuestTarget(t *testing.T) {
	n, p := readyPhysical()
	n.SetControl(context.Background(), "service.example")
	p.answer.Addresses = []string{"8.8.4.4"} // Rotated DNS unseen by the live control socket.
	for _, host := range []string{"service.example", "SERVICE.EXAMPLE."} {
		if _, _, err := n.ResolvePinned(context.Background(), host); err == nil {
			t.Fatal("control service accepted as guest target")
		}
	}
	if p.lookups.Load() != 0 {
		t.Fatal("blocked hostname reached resolver")
	}
}
func TestPhysicalObservedAddressBelongsToAuthenticatedLink(t *testing.T) {
	n, p := readyPhysical()
	a, b := net.Pipe()
	defer b.Close()
	old := &physicalConn{Conn: a, owner: n, generation: "wifi/old"}
	n.links[old] = true
	n.ControlAuthenticated(old, "9.9.9.9")
	if n.Ready() {
		t.Fatal("old link authenticated new physical source")
	}
	p.mu.Lock()
	p.snapshot.Generation = "wifi/address1"
	p.mu.Unlock()
}
func TestPhysicalConnPreservesReplyAfterCloseWrite(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		c, e := listener.Accept()
		if e != nil {
			done <- e
			return
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(3 * time.Second))
		_, e = io.ReadAll(c)
		if e == nil {
			_, e = c.Write([]byte("reply"))
		}
		done <- e
	}()
	raw, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	n := newMobilePeerNetwork(&testPhysicalPlatform{})
	conn := &physicalConn{Conn: raw, owner: n, target: true}
	n.targets[conn] = true
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	conn.Write([]byte("request"))
	if err = conn.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	answer, err := io.ReadAll(conn)
	if err != nil || string(answer) != "reply" {
		t.Fatalf("half-close lost response: %q, %v", answer, err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
}
func TestFreshAndroidHostNeverRestoresSharingConsent(t *testing.T) {
	StopPeer()
	t.Cleanup(StopPeer)
	dir := t.TempDir()
	s, _, err := peer.OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	policy := peer.DefaultPolicy()
	policy.Enabled = true
	policy.MaxMbps = 1
	if err = s.Save(policy); err != nil {
		t.Fatal(err)
	}
	if _, err = StartPeer(dir, &testPhysicalPlatform{}); err != nil {
		t.Fatal(err)
	}
	SuspendPeerExit() // A profile without service.json has no Client.
	data, err := os.ReadFile(filepath.Join(dir, "policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &policy); err != nil {
		t.Fatal(err)
	}
	if policy.Enabled || policy.MaxMbps != 1 {
		t.Fatal("fresh process restored consent or lost saved limits")
	}
}

func TestPhysicalControlCapacityAllowsRepeatedAnswers(t *testing.T) {
	n, _ := readyPhysical()
	for i := 0; i < 128; i++ {
		n.controls[netip.AddrFrom4([4]byte{8, 8, byte(i), 1})] = true
	}
	existing := make([]netip.Addr, 0, 2)
	for ip := range n.controls {
		existing = append(existing, ip)
		if len(existing) == 2 {
			break
		}
	}
	if err := n.rememberControl(existing); err != nil {
		t.Fatal("repeat DNS exhausted cache", err)
	}
	if err := n.rememberControl([]netip.Addr{netip.MustParseAddr("1.1.1.1")}); err == nil {
		t.Fatal("control address cache grew beyond its bound")
	}
}

func TestStopAndSuspendDrainOldHostBeforeReturning(t *testing.T) {
	StopPeer()
	t.Cleanup(StopPeer)
	n, _ := readyPhysical()
	a, b := net.Pipe()
	defer b.Close()
	n.targets[&physicalConn{Conn: a, owner: n, target: true}] = true
	pending, cancel := context.WithCancel(context.Background())
	n.pending[1] = cancel
	n.dials.Add(1)
	host, err := peer.OpenHost(context.Background(), t.TempDir(), n)
	if err != nil {
		t.Fatal(err)
	}
	_, hostCancel := context.WithCancel(context.Background())
	peerState.Lock()
	peerState.host = host
	peerState.network = n
	peerState.cancel = hostCancel
	peerState.Unlock()
	stopped := make(chan struct{})
	go func() { StopPeer(); close(stopped) }()
	select {
	case <-pending.Done():
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel pending dial")
	}
	suspended := make(chan struct{})
	go func() { SuspendPeerExit(); close(suspended) }()
	// Stop is waiting for the dial to finish; Suspend must not mistake this old host for nil.
	select {
	case <-suspended:
		t.Fatal("Suspend returned before old dial drained")
	case <-time.After(20 * time.Millisecond):
	}
	n.dials.Done()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("Stop did not complete")
	}
	select {
	case <-suspended:
	case <-time.After(time.Second):
		t.Fatal("Suspend did not complete")
	}
	b.SetReadDeadline(time.Now().Add(time.Second))
	if _, err = b.Read(make([]byte, 1)); err != io.EOF {
		t.Fatal("old target survived Stop/Suspend", err)
	}
}
