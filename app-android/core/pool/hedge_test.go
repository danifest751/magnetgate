package pool

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type observedConn struct {
	fakeConn
	closed  atomic.Bool
	written atomic.Int32
}

func (c *observedConn) Close() error                { c.closed.Store(true); return nil }
func (c *observedConn) Write(b []byte) (int, error) { c.written.Add(int32(len(b))); return len(b), nil }
func (c *observedConn) Read(b []byte) (int, error)  { b[0] = 42; return 1, nil }

func hedgedPool(t *testing.T, connector Connector) *Pool {
	t.Helper()
	p := New(Config{Preference: []string{"hy2"}, Connectors: map[string]Connector{"hy2": connector}, HedgeDelay: 15 * time.Millisecond, OpenTimeout: time.Second})
	p.Update(node(t, 0, "hy2"))
	p.Update(node(t, 1, "hy2"))
	return p
}

func TestHedgeBypassesStalledFirstNodeAndClosesLateLoser(t *testing.T) {
	loser, winner := &observedConn{}, &observedConn{}
	secondOpened := make(chan struct{})
	connector := ConnectorFunc(func(ctx context.Context, n Node, _ json.RawMessage, _ Target) (Conn, error) {
		if n.Slot == 0 {
			// Simulate a connector returning success even after cancellation.
			<-ctx.Done()
			return loser, nil
		}
		close(secondOpened)
		return winner, nil
	})
	p := hedgedPool(t, connector)
	started := time.Now()
	stream, err := p.Dial(context.Background(), "target.test", 443)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if time.Since(started) > 300*time.Millisecond {
		t.Fatal("waited for the first node's timeout")
	}
	<-secondOpened
	deadline := time.Now().Add(time.Second)
	for !loser.closed.Load() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !loser.closed.Load() {
		t.Fatal("losing connection leaked")
	}
	stream.Write([]byte("payload"))
	if loser.written.Load() != 0 || winner.written.Load() != 7 {
		t.Fatal("application payload was duplicated")
	}
	if len(p.Cooling(0)) != 0 {
		t.Fatal("a cancelled loser was punished as a failure")
	}
}

func TestFastFirstOpenDoesNotStartBackup(t *testing.T) {
	var calls atomic.Int32
	p := hedgedPool(t, ConnectorFunc(func(context.Context, Node, json.RawMessage, Target) (Conn, error) {
		calls.Add(1)
		return &observedConn{}, nil
	}))
	p.cfg.StartupRescueDelay = time.Millisecond
	stream, err := p.Dial(context.Background(), "target.test", 443)
	if err != nil {
		t.Fatal(err)
	}
	stream.Close()
	if calls.Load() != 1 {
		t.Fatalf("unnecessary backup: %d opens", calls.Load())
	}
}

func TestStartupNativeRescueBypassesTwoStalledEngineOpens(t *testing.T) {
	var active, maximum, nativeSlot atomic.Int32
	nativeSlot.Store(-1)
	stalled := ConnectorFunc(func(ctx context.Context, _ Node, _ json.RawMessage, _ Target) (Conn, error) {
		count := active.Add(1)
		defer active.Add(-1)
		for previous := maximum.Load(); count > previous; previous = maximum.Load() {
			if maximum.CompareAndSwap(previous, count) {
				break
			}
		}
		<-ctx.Done()
		return nil, ctx.Err()
	})
	native := ConnectorFunc(func(ctx context.Context, n Node, raw json.RawMessage, target Target) (Conn, error) {
		nativeSlot.Store(int32(n.Slot))
		count := active.Add(1)
		defer active.Add(-1)
		maximum.Store(count)
		return &observedConn{}, nil
	})
	p := New(Config{Preference: []string{"hy2", "reality", "mgt"}, Connectors: map[string]Connector{"hy2": stalled, "reality": stalled, "mgt": native}, HedgeDelay: 10 * time.Millisecond, StartupRescueDelay: 35 * time.Millisecond, OpenTimeout: time.Second})
	p.Update(node(t, 0, "hy2", "reality", "mgt"))
	p.Update(node(t, 1, "hy2", "reality", "mgt"))
	started := time.Now()
	stream, err := p.Dial(context.Background(), "target.test", 443)
	if err != nil {
		t.Fatal(err)
	}
	stream.Close()
	if time.Since(started) > 300*time.Millisecond || nativeSlot.Load() != 1 || maximum.Load() != 3 {
		t.Fatalf("rescue did not bypass pending handshakes: slot=%d maximum=%d", nativeSlot.Load(), maximum.Load())
	}
	if len(p.Cooling(0)) != 0 || len(p.Cooling(1)) != 0 {
		t.Fatal("cancelled engine opens were cooled")
	}
}

func TestStartupRescueRespectsCountryHealthAndWindow(t *testing.T) {
	for _, restriction := range []string{"country", "cooldown", "slow", "expired"} {
		t.Run(restriction, func(t *testing.T) {
			var nativeCalls atomic.Int32
			stalled := ConnectorFunc(func(ctx context.Context, _ Node, _ json.RawMessage, _ Target) (Conn, error) {
				<-ctx.Done()
				return nil, ctx.Err()
			})
			native := ConnectorFunc(func(context.Context, Node, json.RawMessage, Target) (Conn, error) {
				nativeCalls.Add(1)
				return &observedConn{}, nil
			})
			p := New(Config{Preference: []string{"hy2", "mgt"}, Connectors: map[string]Connector{"hy2": stalled, "mgt": native}, HedgeDelay: 5 * time.Millisecond, StartupRescueDelay: 15 * time.Millisecond, OpenTimeout: time.Second})
			n0, n1 := node(t, 0, "hy2"), node(t, 1, "hy2", "mgt")
			n0.Offer.Country, n1.Offer.Country = "NL", "FI"
			p.Update(n0)
			p.Update(n1)
			switch restriction {
			case "country":
				p.SetCountry("NL")
			case "cooldown":
				p.cfg.Health.Fail("1", "mgt")
			case "slow":
				p.cfg.Health.Slow("1", "mgt")
			case "expired":
				p.bootUntil = time.Now().Add(-time.Second)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
			defer cancel()
			if _, err := p.Dial(ctx, "target.test", 443); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("unexpected result: %v", err)
			}
			if nativeCalls.Load() != 0 {
				t.Fatal("rescue bypassed a restriction")
			}
		})
	}
}

func TestHedgeNeverOpensMoreThanTwoAtOnce(t *testing.T) {
	var active, maximum atomic.Int32
	connector := ConnectorFunc(func(ctx context.Context, _ Node, _ json.RawMessage, _ Target) (Conn, error) {
		count := active.Add(1)
		defer active.Add(-1)
		for previous := maximum.Load(); count > previous; previous = maximum.Load() {
			if maximum.CompareAndSwap(previous, count) {
				break
			}
		}
		select {
		case <-time.After(35 * time.Millisecond):
			return nil, errors.New("down")
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	p := hedgedPool(t, connector)
	for slot := 2; slot < 5; slot++ {
		p.Update(node(t, slot, "hy2"))
	}
	if _, err := p.Dial(context.Background(), "target.test", 443); err == nil {
		t.Fatal("down nodes succeeded")
	}
	if maximum.Load() != 2 {
		t.Fatalf("concurrent opens: %d", maximum.Load())
	}
}

func TestHedgeRespectsCancellationAndCountry(t *testing.T) {
	started := make(chan int, 2)
	p := hedgedPool(t, ConnectorFunc(func(ctx context.Context, n Node, _ json.RawMessage, _ Target) (Conn, error) {
		started <- n.Slot
		<-ctx.Done()
		return nil, ctx.Err()
	}))
	n0, n1 := node(t, 0, "hy2"), node(t, 1, "hy2")
	n0.Offer.Country = "FI"
	n1.Offer.Country = "NL"
	p.Update(n0)
	p.Update(n1)
	p.SetCountry("NL")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := p.Dial(ctx, "target.test", 443); done <- err }()
	if slot := <-started; slot != 1 {
		t.Fatalf("country preference ignored: slot %d", slot)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if len(p.Cooling(1)) != 0 {
		t.Fatal("cancelled request cooled a healthy node")
	}
}

func TestHintOnlyRanksMatchingFreshHealthyPairDuringStartup(t *testing.T) {
	p := hedgedPool(t, &fakePlane{})
	nodes := p.Nodes()
	hint := &Hint{Slot: 1, Plane: "hy2", Fingerprint: fingerprint(nodes[1], "hy2"), GoodAt: time.Now().UnixMilli()}
	p.hint = hint
	choices, _ := p.dialCandidates(nodes)
	if choices[0].node.Slot != 1 {
		t.Fatal("last good pair not preferred")
	}
	nodes[1].Offer.DP[0] = json.RawMessage(`{"t":"hy2","host":"changed.test","port":443}`)
	choices, _ = p.dialCandidates(nodes)
	if choices[0].node.Slot != 0 {
		t.Fatal("hint survived changed transport credentials")
	}
	hint.Fingerprint = fingerprint(nodes[1], "hy2")
	p.cfg.Health.Fail("1", "hy2")
	choices, _ = p.dialCandidates(nodes)
	if len(choices) != 1 || choices[0].node.Slot != 0 {
		t.Fatal("hint bypassed cooldown")
	}
	p.cfg.Health.Ok("1", "hy2")
	hint.GoodAt = time.Now().Add(-HintTTL - time.Second).UnixMilli()
	choices, _ = p.dialCandidates(nodes)
	if choices[0].node.Slot != 0 {
		t.Fatal("expired hint preferred")
	}
	hint.GoodAt = time.Now().UnixMilli()
	p.bootUntil = time.Now().Add(-time.Second)
	choices, _ = p.dialCandidates(nodes)
	if choices[0].node.Slot != 0 {
		t.Fatal("startup hint overrides ongoing load balancing")
	}
}

func TestHintIsSavedOnlyAfterRemoteBytesAndThrottled(t *testing.T) {
	var saved atomic.Int32
	p := hedgedPool(t, ConnectorFunc(func(context.Context, Node, json.RawMessage, Target) (Conn, error) { return &observedConn{}, nil }))
	p.cfg.OnGood = func(Hint) { saved.Add(1) }
	stream, err := p.Dial(context.Background(), "target.test", 443)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if saved.Load() != 0 {
		t.Fatal("local open alone saved a hint")
	}
	stream.Read(make([]byte, 1))
	if saved.Load() != 1 {
		t.Fatal("remote byte did not save a hint")
	}
	p.rememberGood(p.Nodes()[0], "hy2")
	if saved.Load() != 1 {
		t.Fatal("hint written for every stream")
	}
}

func TestCachedPlaneHedgesOnAnotherNodeBeforeRetryingSameServer(t *testing.T) {
	var sameServerBackup atomic.Int32
	p := New(Config{
		Preference:  []string{"hy2", "reality"},
		HedgeDelay:  15 * time.Millisecond,
		OpenTimeout: time.Second,
		Connectors: map[string]Connector{
			"reality": ConnectorFunc(func(ctx context.Context, _ Node, _ json.RawMessage, _ Target) (Conn, error) {
				<-ctx.Done()
				return nil, ctx.Err()
			}),
			"hy2": ConnectorFunc(func(ctx context.Context, n Node, _ json.RawMessage, _ Target) (Conn, error) {
				if n.Slot == 0 {
					sameServerBackup.Add(1)
					<-ctx.Done()
					return nil, ctx.Err()
				}
				return &observedConn{}, nil
			}),
		},
	})
	p.Update(node(t, 0, "hy2", "reality"))
	p.Update(node(t, 1, "hy2", "reality"))
	n0 := p.Nodes()[0]
	p.hint = &Hint{Slot: 0, Plane: "reality", Fingerprint: fingerprint(n0, "reality"), GoodAt: time.Now().UnixMilli()}
	started := time.Now()
	stream, err := p.Dial(context.Background(), "target.test", 443)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if time.Since(started) > 300*time.Millisecond {
		t.Fatal("other server waited behind two dead transports")
	}
	if sameServerBackup.Load() != 0 {
		t.Fatal("both concurrent attempts used the dead server")
	}
}

func TestDiverseBackupKeepsHealthyPathsAheadOfSlowOnes(t *testing.T) {
	p := New(Config{Preference: []string{"hy2", "reality"}, Connectors: map[string]Connector{"hy2": &fakePlane{}, "reality": &fakePlane{}}})
	p.Update(node(t, 0, "hy2", "reality"))
	p.Update(node(t, 1, "hy2", "reality"))
	p.cfg.Health.Slow("1", "hy2")
	p.cfg.Health.Slow("1", "reality")
	choices, _ := p.dialCandidates(p.Nodes())
	if choices[0].node.Slot != 0 || choices[1].node.Slot != 0 {
		t.Fatal("slow backup moved ahead of healthy transport")
	}
	p.cfg.Health.Ok("1", "reality")
	choices, _ = p.dialCandidates(p.Nodes())
	if choices[1].node.Slot != 1 || choices[1].plane != "reality" {
		t.Fatal("healthy other server not preferred as backup")
	}
	if len(choices) != 4 {
		t.Fatal("diversifying dropped a fallback")
	}
}
