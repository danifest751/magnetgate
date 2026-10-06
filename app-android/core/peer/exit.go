package peer

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"github.com/hashicorp/yamux"
	"golang.org/x/time/rate"
)

type exitLimits struct {
	mu       sync.Mutex
	up, down *rate.Limiter
	starts   *rate.Limiter
	mbps     float64
	stable   time.Time
}
type guestBudget struct {
	starts  *rate.Limiter
	flows   chan struct{}
	touched time.Time
}

func (c *Client) budget(device string) (*guestBudget, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if b := c.guestBudgets[device]; b != nil {
		b.touched = now
		return b, nil
	}
	for key, b := range c.guestBudgets {
		if len(b.flows) == 0 && now.Sub(b.touched) > time.Minute {
			delete(c.guestBudgets, key)
		}
	}
	if len(c.guestBudgets) >= 128 {
		return nil, errors.New("guest budget capacity")
	}
	b := &guestBudget{rate.NewLimiter(4, 4), make(chan struct{}, 32), now}
	c.guestBudgets[device] = b
	return b, nil
}

func newExitLimits() *exitLimits {
	return &exitLimits{up: rate.NewLimiter(125000, 16384), down: rate.NewLimiter(125000, 16384), starts: rate.NewLimiter(8, 8), mbps: 1, stable: time.Now()}
}

// The two directions share one owner budget each; more guests/streams cannot
// multiply it. Automatic mode starts at 1 Mbps and backs off on blocked writes.
func (l *exitLimits) observe(p Policy, blocked time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	limit := p.MaxMbps
	if p.Automatic {
		if blocked > 250*time.Millisecond {
			l.mbps /= 2
			if l.mbps < 0.1 {
				l.mbps = 0.1
			}
			l.stable = time.Now()
		} else if time.Since(l.stable) > 30*time.Second {
			l.mbps *= 1.2
			l.stable = time.Now()
		}
		if l.mbps < limit {
			limit = l.mbps
		}
	}
	l.up.SetLimit(rate.Limit(limit * 125000))
	l.down.SetLimit(rate.Limit(limit * 125000))
}
func (c *Client) acceptOffer(t Ticket) {
	if c.Store == nil {
		return
	}
	c.mu.Lock()
	ready := c.status.Sharing && t.Epoch == c.epoch && t.Exit == c.Identity.Public() && t.Expires > time.Now().UnixMilli()
	p := c.Store.Policy()
	c.mu.Unlock()
	if !ready || !p.Enabled || c.Network == nil || !c.Network.Ready() {
		return
	}
	if len(c.exitSlots) >= p.MaxGuests {
		return
	}
	select {
	case c.exitSlots <- struct{}{}:
	default:
		return
	}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer func() { <-c.exitSlots }()
		ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
		defer cancel()
		session, _, err := c.pairSession(ctx, t, "exit")
		if err != nil {
			return
		}
		c.mu.Lock()
		if !c.status.Sharing || t.Epoch != c.epoch || c.ctx.Err() != nil {
			c.mu.Unlock()
			session.Close()
			return
		}
		c.sessions[session] = true
		c.mu.Unlock()
		// An application lease is verified on this fresh TLS session. No ticket
		// is persisted or accepted again after an owner policy epoch changes.
		var flowWG sync.WaitGroup
		defer func() { session.Close(); flowWG.Wait(); c.mu.Lock(); delete(c.sessions, session); c.mu.Unlock() }()
		budget, err := c.budget(t.Guest)
		if err != nil {
			return
		}
		guestStarts, guestFlows := budget.starts, budget.flows
		for {
			stream, e := session.AcceptStream()
			if e != nil {
				return
			}
			if !guestStarts.Allow() || !c.limits.starts.Allow() {
				stream.Close()
				continue
			}
			select {
			case guestFlows <- struct{}{}:
			default:
				stream.Close()
				continue
			}
			select {
			case c.flows <- struct{}{}:
			default:
				<-guestFlows
				stream.Close()
				continue
			}
			flowWG.Add(1)
			go func() {
				defer flowWG.Done()
				defer func() { <-guestFlows; <-c.flows }()
				c.serveFlow(session, stream)
			}()
		}
	}()
}
func (c *Client) serveFlow(session *yamux.Session, stream *yamux.Stream) {
	defer stream.Close()
	stream.SetDeadline(time.Now().Add(5 * time.Second))
	var req openRequest
	if readObject(stream, &req) != nil {
		return
	}
	select {
	case c.dials <- struct{}{}:
	default:
		_ = writeObject(stream, openResponse{Error: "owner pending dial limit"})
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	target, err := guardedDial(ctx, c.Network, req.Host, req.Port)
	cancel()
	<-c.dials
	if err != nil {
		_ = writeObject(stream, openResponse{Error: err.Error()})
		return
	}
	defer target.Close()
	if !c.Store.Policy().Enabled || !c.Network.Ready() {
		return
	}
	if err = writeObject(stream, openResponse{}); err != nil {
		return
	}
	stream.SetDeadline(time.Time{})
	done := make(chan error, 2)
	ctx, cancel = context.WithCancel(c.ctx)
	defer cancel()
	// Target sockets are owned by this flow and closed when the session dies,
	// even if their remote peer remains silent forever.
	go func() {
		select {
		case <-session.CloseChan():
			target.Close()
			stream.Close()
		case <-ctx.Done():
		}
	}()
	go func() {
		err := c.copyExit(ctx, target, stream, c.limits.up)
		if tcp, ok := target.(*net.TCPConn); ok {
			tcp.CloseWrite()
		} else {
			target.Close()
		}
		done <- err
	}()
	go func() { err := c.copyExit(ctx, stream, target, c.limits.down); stream.Close(); done <- err }()
	if err := <-done; err != nil {
		cancel()
		target.Close()
		stream.Close()
	}
	// A clean EOF half-closes only its direction. The response may arrive later.
	<-done
}
func (c *Client) copyExit(ctx context.Context, dst io.Writer, src io.Reader, limiter *rate.Limiter) error {
	buf := make([]byte, 16*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if !c.Network.Ready() {
				return errors.New("physical network changed")
			}
			if e := c.Store.Charge(n); e != nil {
				c.pause(e)
				return e
			}
			if e := limiter.WaitN(ctx, n); e != nil {
				return e
			}
			start := time.Now()
			written, e := dst.Write(buf[:n])
			c.limits.observe(c.Store.Policy(), time.Since(start))
			if e != nil || written != n {
				if e != nil {
					return e
				}
				return io.ErrShortWrite
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}
func (c *Client) pause(err error) {
	c.mu.Lock()
	c.status.Sharing = false
	c.advertisedReady = false
	c.status.State = "PAUSED"
	c.status.Error = err.Error()
	c.pausedReason = err.Error()
	for session, exit := range c.sessions {
		if exit {
			session.Close()
		}
	}
	c.epoch = randomID()
	c.mu.Unlock()
	// The stored consent may remain checked after quota exhaustion, but readiness
	// stays withdrawn. It cannot be restored by a heartbeat.
	c.mu.Lock()
	c.sequence++
	m := message{Type: "presence", Epoch: c.epoch, Revision: c.sequence, Ready: false, Slots: 0}
	c.mu.Unlock()
	_ = c.send(m)
}
