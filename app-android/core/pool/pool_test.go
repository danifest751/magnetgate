package pool

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"magnetgate/core/health"
	"magnetgate/core/offer"
	"magnetgate/core/socks"
)

// A pool.Conn must be usable by the SOCKS entry point without an adapter: this fails to compile if the
// two shapes ever drift apart.
var _ socks.Conn = Conn(nil)

type fakeConn struct{ plane string }

func (c *fakeConn) Read([]byte) (int, error)    { return 0, errors.New("not used") }
func (c *fakeConn) Write(p []byte) (int, error) { return len(p), nil }
func (c *fakeConn) CloseWrite() error           { return nil }
func (c *fakeConn) Close() error                { return nil }

// fakePlane is a connector that fails or succeeds on demand and remembers what it was asked for. With
// failUntil it fails only the first N calls, which is how a node that is down and a node that recovers
// are told apart.
type fakePlane struct {
	mu        sync.Mutex
	plane     string
	err       error
	failUntil int
	calls     int
	nodes     []int
	// How long this plane takes to answer. With a clock it moves that clock, so a test of the slow-plane
	// policy stays instant and deterministic; without one it really waits, which is how the bound on a
	// single attempt is checked.
	delay time.Duration
	clock *time.Time
}

func (f *fakePlane) Open(ctx context.Context, node Node, _ json.RawMessage, _ Target) (Conn, error) {
	f.mu.Lock()
	f.calls++
	f.nodes = append(f.nodes, node.Slot)
	failing := f.err != nil && (f.failUntil == 0 || f.calls <= f.failUntil)
	delay, clock, plane := f.delay, f.clock, f.plane
	f.mu.Unlock()

	if delay > 0 {
		if clock != nil {
			*clock = clock.Add(delay)
		} else {
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	}
	if failing {
		return nil, f.err
	}
	return &fakeConn{plane: plane}, nil
}

func (f *fakePlane) ok() {
	f.mu.Lock()
	f.err = nil
	f.mu.Unlock()
}

func (f *fakePlane) fail(err error) {
	f.mu.Lock()
	f.err = err
	f.mu.Unlock()
}

func (f *fakePlane) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *fakePlane) served() []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int(nil), f.nodes...)
}

// node builds a record whose offer carries the planes named, as an exit publishes them.
func node(t *testing.T, slot int, planes ...string) Node {
	t.Helper()
	dp := make([]json.RawMessage, 0, len(planes))
	for _, plane := range planes {
		switch plane {
		case "mgt":
			dp = append(dp, json.RawMessage(`{"t":"mgt","protocol":4,"host":"127.0.0.1","port":29601}`))
		case "reality":
			dp = append(dp, json.RawMessage(`{"t":"reality","host":"127.0.0.1","port":1}`))
		default:
			dp = append(dp, json.RawMessage(`{"t":"`+plane+`","host":"127.0.0.1","port":1}`))
		}
	}
	slotValue := slot
	return Node{
		Slot: slot,
		Name: "exit",
		Offer: &offer.Offer{
			V:    3,
			TS:   time.Now().UnixMilli(),
			Slot: &slotValue,
			Node: "lab",
			DP:   dp,
		},
		Seen: time.Now(),
	}
}

func newTestPool(t *testing.T, connectors map[string]Connector, preference ...string) *Pool {
	t.Helper()
	return New(Config{
		Preference: preference,
		Connectors: connectors,
		Health:     health.New(nil),
	})
}

// Reality first, native as the fallback: the plane order is a client policy, not a property of a node.
func TestPreferenceOrderPicksTheFirstWorkingPlane(t *testing.T) {
	reality, mgt := &fakePlane{plane: "reality"}, &fakePlane{plane: "mgt"}
	p := newTestPool(t, map[string]Connector{"reality": reality, "mgt": mgt}, "reality", "mgt")
	p.Update(node(t, 0, "reality", "mgt"))

	if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
		t.Fatalf("dial: %v", err)
	}
	if reality.count() != 1 || mgt.count() != 0 {
		t.Fatalf("expected the first working plane, got reality=%d mgt=%d", reality.count(), mgt.count())
	}
}

// The acceptance property of per-plane health: a broken plane on a live node pauses that plane only,
// and the very same node stays usable through its other plane.
func TestBrokenPlanePausesOnlyThatPlane(t *testing.T) {
	reality := &fakePlane{plane: "reality", err: errors.New("connection refused")}
	mgt := &fakePlane{plane: "mgt"}
	p := newTestPool(t, map[string]Connector{"reality": reality, "mgt": mgt}, "reality", "mgt")
	p.Update(node(t, 1, "reality", "mgt"))

	if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
		t.Fatalf("the node must stay usable through its other plane, got %v", err)
	}
	if reality.count() != 1 || mgt.count() != 1 {
		t.Fatalf("expected one attempt per plane, got reality=%d mgt=%d", reality.count(), mgt.count())
	}
	cooling := p.Cooling(1)
	if len(cooling) != 1 || cooling[0].Plane != "reality" || cooling[0].Fails != 1 {
		t.Fatalf("cooling: %+v", cooling)
	}

	// the paused plane is skipped, the healthy one is used again
	if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
		t.Fatalf("dial: %v", err)
	}
	if reality.count() != 1 {
		t.Fatalf("a paused plane must be skipped, got %d attempt(s)", reality.count())
	}
	if mgt.count() != 2 {
		t.Fatalf("expected the healthy plane to keep working, got %d", mgt.count())
	}

	// when the plane recovers, one success clears it
	reality.ok()
	p.cfg.Health.Ok(idOf(1), "reality")
	if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
		t.Fatalf("dial after recovery: %v", err)
	}
	if len(p.Cooling(1)) != 0 {
		t.Fatalf("a recovered plane must not stay paused: %+v", p.Cooling(1))
	}
}

func TestFailoverToTheNextNode(t *testing.T) {
	// the first node is down, the second one answers
	mgt := &fakePlane{plane: "mgt", err: errors.New("connection refused"), failUntil: 1}
	p := newTestPool(t, map[string]Connector{"mgt": mgt}, "mgt")
	p.Update(node(t, 0, "mgt"))
	p.Update(node(t, 1, "mgt"))

	if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
		t.Fatalf("dial: %v", err)
	}
	served := mgt.served()
	if len(served) != 2 || served[0] != 0 || served[1] != 1 {
		t.Fatalf("expected an attempt on the dead node then the live one, got %v", served)
	}
	if len(p.Cooling(0)) != 1 {
		t.Fatalf("the node that failed must be cooling on that plane: %+v", p.Cooling(0))
	}
	if len(p.Cooling(1)) != 0 {
		t.Fatalf("the node that answered must stay healthy: %+v", p.Cooling(1))
	}
	// and the next stream skips the dead node entirely
	if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
		t.Fatalf("dial: %v", err)
	}
	if served := mgt.served(); len(served) != 3 || served[2] != 1 {
		t.Fatalf("a cooling node must be skipped, got %v", served)
	}
}

func TestEveryPlaneCoolingIsItsOwnError(t *testing.T) {
	mgt := &fakePlane{plane: "mgt", err: errors.New("connection refused")}
	p := newTestPool(t, map[string]Connector{"mgt": mgt}, "mgt")
	p.Update(node(t, 0, "mgt"))

	if _, err := p.Dial(context.Background(), "target.test", 80); err == nil {
		t.Fatal("the first attempt must fail")
	}
	_, err := p.Dial(context.Background(), "target.test", 80)
	if !errors.Is(err, ErrAllCooling) {
		t.Fatalf("expected ErrAllCooling, got %v", err)
	}
	if mgt.count() != 1 {
		t.Fatalf("a cooling plane must not be retried, got %d attempt(s)", mgt.count())
	}
}

// A plane this build cannot speak is not a failure: nothing was tried, so nothing is paused.
func TestPlaneWithoutConnectorIsNotAFailure(t *testing.T) {
	mgt := &fakePlane{plane: "mgt"}
	p := newTestPool(t, map[string]Connector{"mgt": mgt}, "reality", "mgt")
	p.Update(node(t, 0, "reality"))

	_, err := p.Dial(context.Background(), "target.test", 80)
	if !errors.Is(err, ErrNoPlane) {
		t.Fatalf("expected ErrNoPlane, got %v", err)
	}
	if cooling := p.Cooling(0); len(cooling) != 0 {
		t.Fatalf("an unspeakable plane must not be reported as cooling: %+v", cooling)
	}
}

func TestNothingDiscoveredYet(t *testing.T) {
	p := newTestPool(t, map[string]Connector{"mgt": &fakePlane{plane: "mgt"}}, "mgt")
	if _, err := p.Dial(context.Background(), "target.test", 80); !errors.Is(err, ErrNoNode) {
		t.Fatalf("expected ErrNoNode, got %v", err)
	}
}

// A node whose offer stopped arriving must stop being a candidate, even if it never failed.
func TestStaleNodesAreNotCandidates(t *testing.T) {
	now := time.Now()
	p := New(Config{
		Preference: []string{"mgt"},
		Connectors: map[string]Connector{"mgt": &fakePlane{plane: "mgt"}},
		Health:     health.New(func() time.Time { return now }),
		Now:        func() time.Time { return now },
		Fresh:      time.Minute,
	})
	p.Update(node(t, 0, "mgt"))
	if !p.Fresh(0) || len(p.Nodes()) != 1 {
		t.Fatal("a just-seen node must be a candidate")
	}
	now = now.Add(2 * time.Minute)
	if p.Fresh(0) || len(p.Nodes()) != 0 {
		t.Fatal("a stale node must not be a candidate")
	}
	if _, err := p.Dial(context.Background(), "target.test", 80); !errors.Is(err, ErrNoNode) {
		t.Fatalf("expected ErrNoNode, got %v", err)
	}
}

// The two healthy nodes take turns, so a client with several exits uses them all.
func TestHealthyNodesTakeTurns(t *testing.T) {
	mgt := &fakePlane{plane: "mgt"}
	p := newTestPool(t, map[string]Connector{"mgt": mgt}, "mgt")
	p.Update(node(t, 0, "mgt"))
	p.Update(node(t, 1, "mgt"))

	for i := 0; i < 4; i++ {
		if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
	}
	served := mgt.served()
	want := []int{0, 1, 0, 1}
	for i := range want {
		if served[i] != want[i] {
			t.Fatalf("round robin order: got %v, want %v", served, want)
		}
	}
}

// The diagnostics view is what the app shows: every fresh node, the planes it advertises and the planes
// this client is sitting out.
func TestSnapshotCarriesPlanesAndCooling(t *testing.T) {
	reality := &fakePlane{plane: "reality", err: errors.New("blocked")}
	mgt := &fakePlane{plane: "mgt"}
	p := newTestPool(t, map[string]Connector{"reality": reality, "mgt": mgt}, "reality", "mgt")
	p.Update(node(t, 0, "reality", "mgt"))
	if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
		t.Fatalf("dial: %v", err)
	}

	snapshot := p.Snapshot()
	if snapshot.V != 4 || len(snapshot.Exits) != 1 {
		t.Fatalf("snapshot: %+v", snapshot)
	}
	row := snapshot.Exits[0]
	if row.ID != "0" || row.Slot != 0 || len(row.DP) != 2 {
		t.Fatalf("row: %+v", row)
	}
	if len(row.Cooling) != 1 || row.Cooling[0].Plane != "reality" {
		t.Fatalf("cooling in the snapshot: %+v", row.Cooling)
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// an empty cooling list must serialise as [] and not null: the diagnostics table reads it directly
	empty := New(Config{Connectors: map[string]Connector{}})
	encodedEmpty, err := json.Marshal(empty.Snapshot())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(encoded), `"cooling":[{"t":"reality"`) {
		t.Fatalf("snapshot json: %s", encoded)
	}
	if !strings.Contains(string(encodedEmpty), `"exits":[]`) {
		t.Fatalf("empty snapshot json: %s", encodedEmpty)
	}
}

// startEchoTarget is a TCP target that echoes what it receives.
func startEchoTarget(t *testing.T) (string, int) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				io.Copy(conn, conn)
			}()
		}
	}()
	t.Cleanup(func() { listener.Close() })
	host, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	return host, port
}

// A plane the engine speaks (reality, hysteria2) reaches the network through a loopback SOCKS listener the
// engine exposes for that node; the core has to use it exactly like any other plane.
func TestPlanesThroughTheEngine(t *testing.T) {
	echoHost, echoPort := startEchoTarget(t)
	proxy, err := socks.Listen(0, func(ctx context.Context, host string, port int) (socks.Conn, error) {
		conn, err := net.Dial("tcp", net.JoinHostPort(echoHost, strconv.Itoa(echoPort)))
		if err != nil {
			return nil, err
		}
		return socks.WrapConn(conn), nil
	})
	if err != nil {
		t.Fatalf("listen proxy: %v", err)
	}
	defer proxy.Close()
	_, proxyPortText, _ := net.SplitHostPort(proxy.Addr().String())
	proxyPort, _ := strconv.Atoi(proxyPortText)

	planes := NewSocksPlanes()
	planes.Set(0, "reality", proxyPort)
	native := &fakePlane{plane: "mgt"}
	p := New(Config{
		Preference: []string{"reality", "mgt"},
		Connectors: map[string]Connector{"reality": planes, "mgt": native},
	})
	p.Update(node(t, 0, "reality", "mgt"))

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := p.Dial(ctx, echoHost, echoPort)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	payload := []byte("via the engine")
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make([]byte, len(payload))
	// the relay only promises Read/Write/Close/CloseWrite; a deadline is a bonus of the concrete stream
	if deadlines, ok := conn.(interface{ SetReadDeadline(time.Time) error }); ok {
		deadlines.SetReadDeadline(time.Now().Add(5 * time.Second))
	}
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("echo mismatch: %q", got)
	}
	if native.count() != 0 {
		t.Fatalf("the native plane must not have been used, got %d attempt(s)", native.count())
	}
}

// While the engine has not told us a port for a node's plane, that plane is simply not available and the
// next one is used.
func TestEnginePlaneWithoutAPortFallsThrough(t *testing.T) {
	planes := NewSocksPlanes()
	native := &fakePlane{plane: "mgt"}
	p := New(Config{
		Preference: []string{"reality", "mgt"},
		Connectors: map[string]Connector{"reality": planes, "mgt": native},
	})
	p.Update(node(t, 0, "reality", "mgt"))

	if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
		t.Fatalf("dial: %v", err)
	}
	if native.count() != 1 {
		t.Fatalf("expected the fallback to carry the stream, got %d attempt(s)", native.count())
	}
	// and it must not be held against the node: the engine is ours, not theirs
	if cooling := p.Cooling(0); len(cooling) != 0 {
		t.Fatalf("a plane the engine has not been told about must not be cooled: %+v", cooling)
	}
}

// The engine rebuilds its listeners on every reload, so for an instant the core knows no port for any
// plane. Counting that as the node failing cooled every engine plane at once and pushed the pool onto
// the one plane the engine does not carry - which on a network that blocks it left the tunnel with
// nowhere to go, for ten minutes. Measured on a phone on 17.09.
func TestAReloadDoesNotCoolTheEnginePlanes(t *testing.T) {
	planes := NewSocksPlanes()
	planes.Set(0, "reality", 1)
	native := &fakePlane{plane: "mgt"}
	p := New(Config{
		Preference: []string{"reality", "mgt"},
		Connectors: map[string]Connector{"reality": planes, "mgt": native},
	})
	p.Update(node(t, 0, "reality", "mgt"))

	planes.Forget(0) // the reload starts: the port map is empty until the new listeners are announced
	for i := 0; i < 3; i++ {
		if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
			t.Fatalf("dial %d during the reload: %v", i, err)
		}
	}
	if cooling := p.Cooling(0); len(cooling) != 0 {
		t.Fatalf("the reload must not pause anything: %+v", cooling)
	}

	// once the new port is announced the plane is used again immediately, with no pause to sit out
	echoHost, echoPort := startEchoTarget(t)
	proxy, err := socks.Listen(0, func(ctx context.Context, host string, port int) (socks.Conn, error) {
		conn, err := net.Dial("tcp", net.JoinHostPort(echoHost, strconv.Itoa(echoPort)))
		if err != nil {
			return nil, err
		}
		return socks.WrapConn(conn), nil
	})
	if err != nil {
		t.Fatalf("listen proxy: %v", err)
	}
	defer proxy.Close()
	_, proxyPortText, _ := net.SplitHostPort(proxy.Addr().String())
	proxyPort, _ := strconv.Atoi(proxyPortText)
	planes.Set(0, "reality", proxyPort)

	before := native.count()
	conn, err := p.Dial(context.Background(), echoHost, echoPort)
	if err != nil {
		t.Fatalf("dial after the reload: %v", err)
	}
	defer conn.Close()
	if native.count() != before {
		t.Fatal("the engine plane was available again and should have carried the stream")
	}
}

// A plane that answers slowly never fails, so it was never paused - and it kept winning against a
// healthy alternative while the applications on top gave up on their own timeouts. Measured on a phone
// on 17.09: hy2 was offered by both nodes for two hours and never once used.
func TestASlowPlaneLosesItsTurnToAHealthyOne(t *testing.T) {
	clock := time.Unix(0, 0)
	slow := &fakePlane{plane: "reality", delay: time.Duration(health.SlowMs+100) * time.Millisecond, clock: &clock}
	fast := &fakePlane{plane: "hy2"}
	p := New(Config{
		Preference: []string{"reality", "hy2"},
		Connectors: map[string]Connector{"reality": slow, "hy2": fast},
		Now:        func() time.Time { return clock },
	})
	p.Update(node(t, 0, "reality", "hy2"))

	// the first stream still goes through reality - it is preferred, and nothing is known against it
	if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
		t.Fatalf("first dial: %v", err)
	}
	if slow.count() != 1 || fast.count() != 0 {
		t.Fatalf("expected reality to carry the first stream, got reality=%d hy2=%d", slow.count(), fast.count())
	}
	cooling := p.Cooling(0)
	if len(cooling) != 1 || cooling[0].Plane != "reality" || !cooling[0].Slow {
		t.Fatalf("a slow success must be reported as demoted, not paused: %+v", cooling)
	}

	// the next one does not: reality answered, so it is not paused, but it waits its turn
	if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
		t.Fatalf("second dial: %v", err)
	}
	if fast.count() != 1 {
		t.Fatalf("expected hy2 to carry the second stream, got reality=%d hy2=%d", slow.count(), fast.count())
	}

	// and once the demotion expires the preferred plane is offered again
	clock = clock.Add(time.Duration(health.DemoteMs+1) * time.Millisecond)
	if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
		t.Fatalf("third dial: %v", err)
	}
	if slow.count() != 2 {
		t.Fatalf("expected reality to be tried again, got reality=%d", slow.count())
	}
}

// Demotion must never mean "unusable": on a network where the alternative does not work at all, the
// slow plane is the tunnel.
func TestADemotedPlaneStillCarriesTrafficWhenItIsTheOnlyOne(t *testing.T) {
	clock := time.Unix(0, 0)
	slow := &fakePlane{plane: "reality", delay: time.Duration(health.SlowMs+100) * time.Millisecond, clock: &clock}
	p := New(Config{
		Preference: []string{"reality"},
		Connectors: map[string]Connector{"reality": slow},
		Now:        func() time.Time { return clock },
	})
	p.Update(node(t, 0, "reality"))

	for i := 0; i < 3; i++ {
		if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
	}
	if slow.count() != 3 {
		t.Fatalf("a demoted plane must still be used when nothing else is: got %d", slow.count())
	}
}

// Without a bound on one attempt, a path that has degraded but not died holds the caller for as long as
// it likes - 15 to 18 seconds in the log of 17.09 - while the browser above gives up after three.
func TestOneAttemptIsBounded(t *testing.T) {
	hang := &fakePlane{plane: "reality", delay: time.Hour}
	fast := &fakePlane{plane: "hy2"}
	p := New(Config{
		Preference:  []string{"reality", "hy2"},
		Connectors:  map[string]Connector{"reality": hang, "hy2": fast},
		OpenTimeout: 50 * time.Millisecond,
	})
	p.Update(node(t, 0, "reality", "hy2"))

	started := time.Now()
	if _, err := p.Dial(context.Background(), "target.test", 80); err != nil {
		t.Fatalf("dial: %v", err)
	}
	if took := time.Since(started); took > 5*time.Second {
		t.Fatalf("the hanging plane was not cut short: %s", took)
	}
	if fast.count() != 1 {
		t.Fatal("the alternative should have carried the stream")
	}
	if cooling := p.Cooling(0); len(cooling) != 1 || cooling[0].Plane != "reality" || cooling[0].Slow {
		t.Fatalf("a plane that could not answer in time is paused, not demoted: %+v", cooling)
	}
}
