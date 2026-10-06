package pool

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"magnetgate/core/health"
)

const HintTTL = 10 * time.Minute

// Hint contains no credentials. It only ranks a matching, freshly discovered offer.
type Hint struct {
	Slot        int    `json:"slot"`
	Plane       string `json:"plane"`
	Fingerprint string `json:"fingerprint"`
	GoodAt      int64  `json:"goodAt"`
}

func fingerprint(node Node, plane string) string {
	raw := node.Offer.Pick([]string{plane})
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	canonical, _ := json.Marshal(value)
	digest := sha256.Sum256(append([]byte(node.Offer.Node+"\x00"), canonical...))
	return hex.EncodeToString(digest[:])
}

func (p *Pool) rememberGood(node Node, plane string) {
	now := p.now()
	hint := Hint{Slot: node.Slot, Plane: plane, Fingerprint: fingerprint(node, plane), GoodAt: now.UnixMilli()}
	p.mu.Lock()
	previous := p.hint
	p.hint = &hint
	// Persist once per thirty seconds for the same pair, rather than on every stream.
	changed := previous == nil || previous.Slot != hint.Slot || previous.Plane != hint.Plane || previous.Fingerprint != hint.Fingerprint
	if !changed && hint.GoodAt-previous.GoodAt < 30_000 {
		p.hint.GoodAt = previous.GoodAt
	}
	save := changed || hint.GoodAt-previous.GoodAt >= 30_000
	p.mu.Unlock()
	if save && p.cfg.OnGood != nil {
		p.cfg.OnGood(hint)
	}
}

type dialCandidate struct {
	node      Node
	plane     string
	raw       json.RawMessage
	connector Connector
}

// candidates spreads the preferred transport across nodes before trying lower
// preferences. Country, freshness, cooldown and slow-path ordering still apply.
func (p *Pool) dialCandidates(nodes []Node) ([]dialCandidate, int) {
	p.mu.Lock()
	start := p.rr % len(nodes)
	hint := p.hint
	useHint := hint != nil && p.now().Before(p.bootUntil) &&
		hint.GoodAt <= p.now().UnixMilli() && p.now().UnixMilli()-hint.GoodAt < HintTTL.Milliseconds()
	p.mu.Unlock()
	var out []dialCandidate
	cooling := 0
	for round := 0; round < 2; round++ {
		begin := len(out)
		for _, plane := range p.cfg.Preference {
			connector := p.cfg.Connectors[plane]
			if connector == nil {
				continue
			}
			for i := range nodes {
				node := nodes[(start+i)%len(nodes)]
				if node.Offer == nil {
					continue
				}
				raw := node.Offer.Pick([]string{plane})
				if raw == nil {
					continue
				}
				if !p.cfg.Health.Usable(idOf(node.Slot), plane) {
					if round == 0 {
						cooling++
					}
					continue
				}
				if p.cfg.Health.Degraded(idOf(node.Slot), plane) != (round == 1) {
					continue
				}
				out = append(out, dialCandidate{node, plane, raw, connector})
			}
		}
		if useHint {
			for i := begin; i < len(out); i++ {
				candidate := out[i]
				if candidate.node.Slot == hint.Slot && candidate.plane == hint.Plane && fingerprint(candidate.node, candidate.plane) == hint.Fingerprint {
					copy(out[begin+1:i+1], out[begin:i])
					out[begin] = candidate
					break
				}
			}
		}
		// A cached lower-preference plane can put two transports of the same
		// server first. Keep the best attempt, but hedge on another server so
		// a host failure cannot occupy both opens until their deadlines.
		// Stay within this health round: slow paths still follow healthy ones.
		if len(out)-begin > 1 {
			for i := begin + 1; i < len(out); i++ {
				if out[i].node.Slot == out[begin].node.Slot {
					continue
				}
				backup := out[i]
				copy(out[begin+2:i+1], out[begin+1:i])
				out[begin+1] = backup
				break
			}
		}
	}
	return out, cooling
}

func (p *Pool) dialHedged(ctx context.Context, host string, port int) (Conn, error) {
	nodes := p.Nodes()
	if len(nodes) == 0 {
		return nil, ErrNoNode
	}
	if selection := SelectCountry(nodes, p.Country()); selection.Country != "" {
		nodes = selection.Nodes
	}
	choices, cooling := p.dialCandidates(nodes)
	lastResort := false
	if len(choices) == 0 {
		if cooling == 0 {
			return nil, ErrNoPlane
		}
		node, plane, ok := p.leastCooling(nodes)
		if !ok {
			return nil, ErrAllCooling
		}
		choices = []dialCandidate{{node, plane, node.Offer.Pick([]string{plane}), p.cfg.Connectors[plane]}}
		lastResort = true
	}
	type result struct {
		candidate dialCandidate
		conn      Conn
		err       error
		took      time.Duration
	}
	raceCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan result)
	next, active := 0, 0
	launch := func() {
		candidate := choices[next]
		next++
		active++
		go func() {
			openCtx, done := context.WithTimeout(raceCtx, p.cfg.OpenTimeout)
			started := p.now()
			conn, err := candidate.connector.Open(openCtx, candidate.node, candidate.raw, Target{host, port})
			took := p.now().Sub(started)
			done()
			if err != nil && conn != nil {
				conn.Close()
				conn = nil
			}
			select {
			case results <- result{candidate, conn, err, took}:
			case <-raceCtx.Done():
				if conn != nil {
					conn.Close()
				}
			}
		}()
	}
	launch()
	var rescue <-chan time.Time
	if p.cfg.StartupRescueDelay > 0 && p.now().Before(p.bootUntil) && !lastResort {
		rescueTimer := time.NewTimer(p.cfg.StartupRescueDelay)
		defer rescueTimer.Stop()
		rescue = rescueTimer.C
	}
	timer := time.NewTimer(p.cfg.HedgeDelay)
	defer timer.Stop()
	var lastErr error
	for active > 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-rescue:
			rescue = nil // One extra open at most, never a retry timer.
			// Prefer a native path on the other server, within the already
			// filtered candidates. Never revive a cooled or degraded plane.
			chosen := -1
			for i := next; i < len(choices); i++ {
				candidate := choices[i]
				if candidate.plane != "mgt" || p.cfg.Health.Degraded(idOf(candidate.node.Slot), candidate.plane) || !p.cfg.Health.Usable(idOf(candidate.node.Slot), candidate.plane) {
					continue
				}
				if chosen < 0 {
					chosen = i
				}
				if candidate.node.Slot != choices[0].node.Slot {
					chosen = i
					break
				}
			}
			if chosen >= 0 {
				candidate := choices[chosen]
				copy(choices[next+1:chosen+1], choices[next:chosen])
				choices[next] = candidate
				launch()
			}
		case <-timer.C:
			if active < 2 && next < len(choices) {
				launch()
			}
		case opened := <-results:
			active--
			if err := ctx.Err(); err != nil {
				if opened.conn != nil {
					opened.conn.Close()
				}
				return nil, err
			}
			candidate := opened.candidate
			if opened.err == nil {
				p.mu.Lock()
				p.rr++
				p.mu.Unlock()
				return p.trackOpened(opened.conn, candidate, host, port, opened.took, lastResort), nil
			}
			lastErr = opened.err
			if errors.Is(lastErr, errUnknownPlane) {
				p.unwired(candidate.node.Slot, candidate.plane)
			} else if !lastResort {
				record := p.cfg.Health.Fail(idOf(candidate.node.Slot), candidate.plane)
				p.logf("transport failed: %s slot %d (paused %s): %v", candidate.plane, candidate.node.Slot, time.Duration(record.BackoffMs)*time.Millisecond, lastErr)
			}
			if next < len(choices) && active < 2 {
				launch()
			}
		}
		// Regular retries refill only two opens; the one startup rescue may
		// temporarily add a third. Keep a backup eligible when only one remains.
		if active == 1 && next < len(choices) {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(p.cfg.HedgeDelay)
		}
	}
	if lastResort {
		return nil, ErrAllCooling
	}
	return nil, lastErr
}

func (p *Pool) trackOpened(conn Conn, candidate dialCandidate, host string, port int, took time.Duration, lastResort bool) Conn {
	node, plane := candidate.node, candidate.plane
	id := idOf(node.Slot)
	if _, engine := candidate.connector.(*SocksPlanes); !engine && !lastResort {
		if took >= time.Duration(health.SlowMs)*time.Millisecond {
			p.cfg.Health.Slow(id, plane)
		} else {
			p.cfg.Health.Ok(id, plane)
		}
	}
	p.logf("stream to %s:%d via %s slot %d (staggered open)", host, port, plane, node.Slot)
	entry := &liveEntry{row: Live{Host: host, Port: port, Plane: plane, Slot: node.Slot, OpenedAt: p.now().UnixMilli()}}
	p.live.add(entry)
	return watchFirstByte(conn, p.cfg.FirstByteDeadline, func(verdict health.Verdict, after time.Duration) {
		switch verdict {
		case health.VerdictOk:
			p.cfg.Health.Ok(id, plane)
			p.rememberGood(node, plane)
		case health.VerdictSlow:
			p.cfg.Health.Slow(id, plane)
			p.logf("slow plane: %s slot %d first byte after %s", plane, node.Slot, after.Round(time.Millisecond))
		case health.VerdictFail:
			if !lastResort {
				p.cfg.Health.Fail(id, plane)
			}
		}
	}, func(sent, received int64) { entry.count(sent, received); p.countBytes(sent, received) }, func() { entry.close(p.now().UnixMilli()) })
}
