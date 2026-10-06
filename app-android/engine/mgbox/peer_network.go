package mgbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"sync"
	"syscall"
	"time"
)

// PeerPlatform supplies a physical Android Network snapshot. Binding is socket
// scoped; it never changes the process default network.
type PeerPlatform interface {
	State() (string, error)
	Resolve(host string) (string, error)
	Bind(fd int64, generation string) error
}
type physicalState struct {
	Generation string   `json:"generation"`
	Allowed    bool     `json:"allowed"`
	Prefixes   []string `json:"prefixes"`
	Addresses  []string `json:"addresses"`
}
type physicalAnswer struct {
	Generation string   `json:"generation"`
	Addresses  []string `json:"addresses"`
}
type mobilePeerNetwork struct {
	platform    PeerPlatform
	mu          sync.Mutex
	allowed     bool
	epoch       uint64
	baseline    string
	observed    netip.Addr
	controls    map[netip.Addr]bool
	controlHost string
	links       map[*physicalConn]bool
	targets     map[*physicalConn]bool
	pending     map[uint64]context.CancelFunc
	next        uint64
	dials       sync.WaitGroup
}

func newMobilePeerNetwork(p PeerPlatform) *mobilePeerNetwork {
	return &mobilePeerNetwork{platform: p, controls: map[netip.Addr]bool{}, links: map[*physicalConn]bool{}, targets: map[*physicalConn]bool{}, pending: map[uint64]context.CancelFunc{}}
}

type physicalConn struct {
	net.Conn
	owner      *mobilePeerNetwork
	generation string
	target     bool
}

func (c *physicalConn) CloseWrite() error {
	if half, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return half.CloseWrite()
	}
	return c.Conn.Close()
}

func (c *physicalConn) Close() error {
	err := c.Conn.Close()
	c.owner.mu.Lock()
	if c.target {
		delete(c.owner.targets, c)
	} else {
		delete(c.owner.links, c)
	}
	c.owner.mu.Unlock()
	return err
}
func (n *mobilePeerNetwork) state() (physicalState, error) {
	var s physicalState
	value, err := n.platform.State()
	if err != nil {
		return s, err
	}
	if len(value) > 32768 || json.Unmarshal([]byte(value), &s) != nil || s.Generation == "" || len(s.Prefixes) > 128 || len(s.Addresses) > 128 {
		return s, errors.New("invalid physical network state")
	}
	return s, nil
}
func (*mobilePeerNetwork) CanShare() bool { return true }

func (n *mobilePeerNetwork) SetControl(_ context.Context, host string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.controlHost = strings.ToLower(strings.TrimSuffix(host, "."))
	return nil
}
func (n *mobilePeerNetwork) Ready() bool {
	s, err := n.state()
	n.mu.Lock()
	stale := err != nil || (n.baseline != "" && s.Generation != n.baseline)
	ready := !stale && s.Allowed && n.allowed && n.baseline != "" && n.observed.Is4()
	if stale {
		n.baseline = ""
		n.observed = netip.Addr{}
		n.epoch++
	}
	if !ready {
		n.epoch++
		n.closeTargetsLocked()
	}
	if stale {
		for c := range n.links {
			c.Conn.Close()
		}
	}
	n.mu.Unlock()
	return ready
}
func (n *mobilePeerNetwork) closeTargetsLocked() {
	for _, cancel := range n.pending {
		cancel()
	}
	for c := range n.targets {
		c.Conn.Close()
	}
}

// Suspend is a completed socket barrier, including dials already inside Bind.
// No new target can register while allowed is false.
func (n *mobilePeerNetwork) suspend() {
	n.mu.Lock()
	n.allowed = false
	n.epoch++
	n.closeTargetsLocked()
	n.mu.Unlock()
	n.dials.Wait()
}
func (n *mobilePeerNetwork) resume() { n.mu.Lock(); n.allowed = true; n.mu.Unlock() }
func (n *mobilePeerNetwork) ControlAuthenticated(conn net.Conn, observed string) {
	for {
		wrapped, ok := conn.(interface{ NetConn() net.Conn })
		if !ok {
			break
		}
		conn = wrapped.NetConn()
	}
	bound, ok := conn.(*physicalConn)
	ip, err := netip.ParseAddr(observed)
	state, stateErr := n.state()
	n.mu.Lock()
	if ok && err == nil && ip.Unmap().Is4() && stateErr == nil && bound.generation == state.Generation {
		n.baseline = bound.generation
		n.observed = ip.Unmap()
	} else {
		n.baseline = ""
		n.observed = netip.Addr{}
	}
	n.mu.Unlock()
	if !ok || err != nil || !ip.Unmap().Is4() || stateErr != nil || bound.generation != state.Generation {
		conn.Close()
	}
}
func (n *mobilePeerNetwork) Blocked(ip netip.Addr) bool {
	s, err := n.state()
	if err != nil {
		return true
	}
	ip = ip.Unmap()
	n.mu.Lock()
	blocked := n.controls[ip] || ip == n.observed || s.Generation != n.baseline
	n.mu.Unlock()
	if blocked {
		return true
	}
	for _, v := range s.Addresses {
		a, e := netip.ParseAddr(v)
		if e != nil {
			return true
		}
		if a.Unmap() == ip {
			return true
		}
	}
	for _, v := range s.Prefixes {
		p, e := netip.ParsePrefix(v)
		if e != nil || p.Bits() == 0 {
			return true
		}
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// Synchronous platform DNS may finish after cancellation; only four callbacks
// can exist process-wide and none can open a socket after its caller cancels.
var physicalLookups = make(chan struct{}, 4)

func (n *mobilePeerNetwork) lookup(ctx context.Context, host string) (physicalAnswer, error) {
	var result physicalAnswer
	select {
	case physicalLookups <- struct{}{}:
	default:
		return result, errors.New("physical resolver capacity")
	}
	type answer struct {
		value string
		err   error
	}
	ch := make(chan answer, 1)
	go func() {
		defer func() { <-physicalLookups }()
		value, err := n.platform.Resolve(host)
		ch <- answer{value, err}
	}()
	var a answer
	select {
	case a = <-ch:
	case <-ctx.Done():
		return result, ctx.Err()
	}
	if a.err != nil {
		return result, a.err
	}
	if len(a.value) > 8192 || json.Unmarshal([]byte(a.value), &result) != nil || result.Generation == "" || len(result.Addresses) == 0 || len(result.Addresses) > 16 {
		return result, errors.New("invalid physical DNS result")
	}
	return result, nil
}
func parsePhysicalAnswer(answer physicalAnswer) ([]netip.Addr, error) {
	var addresses []netip.Addr
	for _, v := range answer.Addresses {
		a, err := netip.ParseAddr(v)
		if err != nil || a.Zone() != "" {
			return nil, errors.New("invalid physical DNS address")
		}
		addresses = append(addresses, a.Unmap())
	}
	// Pilot exits use IPv4 so the observed source covers every forwarded socket.
	// Keep AAAA answers for the common guard's all-answer validation.
	for i, a := range addresses {
		if a.Is4() {
			addresses[0], addresses[i] = addresses[i], addresses[0]
			return addresses, nil
		}
	}
	return nil, errors.New("physical IPv4 connection is required")
}
func (n *mobilePeerNetwork) ResolvePinned(ctx context.Context, host string) ([]netip.Addr, string, error) {
	n.mu.Lock()
	isControl := strings.ToLower(strings.TrimSuffix(host, ".")) == n.controlHost
	n.mu.Unlock()
	if isControl {
		return nil, "", errors.New("service target is blocked")
	}
	if !n.Ready() {
		return nil, "", errors.New("sharing is paused")
	}
	n.mu.Lock()
	baseline, epoch := n.baseline, n.epoch
	n.mu.Unlock()
	answer, err := n.lookup(ctx, host)
	if err != nil {
		return nil, "", err
	}
	if answer.Generation != baseline {
		return nil, "", errors.New("physical network changed during DNS")
	}
	addresses, err := parsePhysicalAnswer(answer)
	return addresses, fmt.Sprintf("%s/%d", baseline, epoch), err
}
func (*mobilePeerNetwork) Resolve(context.Context, string) ([]netip.Addr, error) {
	return nil, errors.New("generation token required")
}
func (*mobilePeerNetwork) Dial(context.Context, string) (net.Conn, error) {
	return nil, errors.New("generation token required")
}
func (n *mobilePeerNetwork) DialPinned(parent context.Context, address, token string) (net.Conn, error) {
	if !n.Ready() {
		return nil, errors.New("sharing is paused")
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || !ip.Is4() || n.Blocked(ip) {
		return nil, errors.New("target is blocked")
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	n.mu.Lock()
	generation := n.baseline
	if !n.allowed || token != fmt.Sprintf("%s/%d", generation, n.epoch) {
		n.mu.Unlock()
		return nil, errors.New("stale physical network generation")
	}
	n.next++
	id := n.next
	n.pending[id] = cancel
	n.dials.Add(1)
	n.mu.Unlock()
	defer func() { n.mu.Lock(); delete(n.pending, id); n.mu.Unlock(); n.dials.Done() }()
	conn, err := n.dial(ctx, address, generation)
	if err != nil {
		return nil, err
	}
	// Registration and revocation share this lock, so no socket escapes Suspend.
	s, stateErr := n.state()
	n.mu.Lock()
	if ctx.Err() != nil || stateErr != nil || !s.Allowed || s.Generation != generation || !n.allowed || token != fmt.Sprintf("%s/%d", n.baseline, n.epoch) {
		n.mu.Unlock()
		conn.Close()
		return nil, errors.New("physical network changed during dial")
	}
	tracked := &physicalConn{Conn: conn, owner: n, generation: generation, target: true}
	n.targets[tracked] = true
	n.mu.Unlock()
	return tracked, nil
}
func (n *mobilePeerNetwork) dial(ctx context.Context, address, generation string) (net.Conn, error) {
	d := net.Dialer{Timeout: 5 * time.Second, Control: func(_, _ string, raw syscall.RawConn) error {
		var bindErr error
		err := raw.Control(func(fd uintptr) { bindErr = n.platform.Bind(int64(fd), generation) })
		if err != nil {
			return err
		}
		return bindErr
	}}
	return d.DialContext(ctx, "tcp4", address)
}
func (n *mobilePeerNetwork) link(ctx context.Context, _, address string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	answer, err := n.lookup(ctx, host)
	if err != nil {
		return nil, err
	}
	ips, err := parsePhysicalAnswer(answer)
	if err != nil {
		return nil, err
	}
	if err = n.rememberControl(ips); err != nil {
		return nil, err
	}
	conn, err := n.dial(ctx, net.JoinHostPort(ips[0].String(), port), answer.Generation)
	if err != nil {
		return nil, err
	}
	s, err := n.state()
	if err != nil || s.Generation != answer.Generation {
		conn.Close()
		return nil, errors.New("physical service network changed")
	}
	tracked := &physicalConn{Conn: conn, owner: n, generation: answer.Generation}
	n.mu.Lock()
	n.links[tracked] = true
	n.mu.Unlock()
	return tracked, nil
}

func (n *mobilePeerNetwork) rememberControl(ips []netip.Addr) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	newIPs := map[netip.Addr]bool{}
	for _, ip := range ips {
		if !n.controls[ip] {
			newIPs[ip] = true
		}
	}
	if len(n.controls)+len(newIPs) > 128 {
		return errors.New("service address capacity")
	}
	for ip := range newIPs {
		n.controls[ip] = true
	}
	return nil
}
