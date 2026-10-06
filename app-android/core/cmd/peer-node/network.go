package main

import (
	"context"
	"errors"
	"fmt"
	"magnetgate/core/peer"
	"net"
	"net/netip"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Conservative pilot adapter: VPN coexistence is deliberately not enabled.
// Route and interface snapshots are checked before DNS and numeric TCP dial;
// a changed snapshot permanently pauses this generation until a fresh host.
type physicalNetwork struct {
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	baseline   string
	valid      atomic.Bool
	suspended  atomic.Bool
	done       chan struct{}
	observed   netip.Addr
	controlIPs []netip.Addr
}

func newPhysicalNetwork(parent context.Context) *physicalNetwork {
	ctx, cancel := context.WithCancel(parent)
	n := &physicalNetwork{ctx: ctx, cancel: cancel, done: make(chan struct{})}
	n.capture()
	go func() {
		defer close(n.done)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				n.check(ctx)
			}
		}
	}()
	return n
}
func (n *physicalNetwork) close() { n.cancel(); <-n.done }
func (n *physicalNetwork) suspend(v bool) {
	n.suspended.Store(v)
	if v {
		n.valid.Store(false)
	} else {
		n.capture()
	}
}
func (n *physicalNetwork) capture() {
	ctx, cancel := context.WithTimeout(n.ctx, 3*time.Second)
	defer cancel()
	s, err := networkSnapshot(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "peer physical route unavailable:", err)
	}
	n.mu.Lock()
	n.baseline = s
	n.mu.Unlock()
	n.valid.Store(err == nil && !n.suspended.Load())
}
func (n *physicalNetwork) check(ctx context.Context) bool {
	if n.suspended.Load() {
		n.valid.Store(false)
		return false
	}
	s, err := networkSnapshot(ctx)
	n.mu.Lock()
	same := s == n.baseline && n.baseline != ""
	n.mu.Unlock()
	if err != nil || !same {
		if n.valid.Load() {
			if err != nil {
				fmt.Fprintln(os.Stderr, "peer physical route paused:", err)
			} else {
				fmt.Fprintln(os.Stderr, "peer physical route or DNS changed; sharing paused")
			}
		}
		n.valid.Store(false)
	}
	return n.valid.Load()
}
func (n *physicalNetwork) Ready() bool {
	n.mu.Lock()
	observed := n.observed
	n.mu.Unlock()
	return peer.PublicTarget(observed) && n.valid.Load() && !n.suspended.Load() && n.ctx.Err() == nil
}

func (*physicalNetwork) CanShare() bool { return runtime.GOOS == "windows" || runtime.GOOS == "linux" }
func (n *physicalNetwork) SetObserved(value string) {
	a, _ := netip.ParseAddr(value)
	n.mu.Lock()
	n.observed = a.Unmap()
	n.mu.Unlock()
}
func (n *physicalNetwork) SetControl(ctx context.Context, host string) error {
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return err
	}
	n.mu.Lock()
	n.controlIPs = ips
	n.mu.Unlock()
	return nil
}
func (n *physicalNetwork) Resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if !n.check(ctx) {
		return nil, errors.New("physical route changed or is unverified")
	}
	return net.DefaultResolver.LookupNetIP(ctx, "ip4", host)
}
func (n *physicalNetwork) Dial(ctx context.Context, address string) (net.Conn, error) {
	if !n.check(ctx) {
		return nil, errors.New("physical route changed before dial")
	}
	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", address)
	if err == nil && !n.check(ctx) {
		conn.Close()
		return nil, errors.New("route changed while dialing")
	}
	return conn, err
}
func (n *physicalNetwork) Blocked(a netip.Addr) bool {
	n.mu.Lock()
	blocked := a.Unmap() == n.observed
	for _, ip := range n.controlIPs {
		if ip.Unmap() == a.Unmap() {
			blocked = true
		}
	}
	n.mu.Unlock()
	if blocked {
		return true
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		return true
	}
	for _, iface := range interfaces {
		addresses, e := iface.Addrs()
		if e != nil {
			return true
		}
		for _, s := range addresses {
			prefix, e := netip.ParsePrefix(s.String())
			if e == nil && prefix.Addr().Unmap() == a.Unmap() {
				return true
			}
		}
	}
	return false
}
func interfaceSnapshot() (string, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return "", err
	}
	var rows []string
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		lower := strings.ToLower(iface.Name)
		if iface.Flags&net.FlagPointToPoint != 0 {
			return "", errors.New("point-to-point adapter is active")
		}
		if strings.Contains(lower, "tun") || strings.Contains(lower, "tap") || strings.Contains(lower, "wireguard") || strings.Contains(lower, "vpn") || strings.HasPrefix(lower, "wg") || strings.HasPrefix(lower, "ppp") || strings.HasPrefix(lower, "ipsec") {
			return "", errors.New("tunnel adapter is active")
		}
		addresses, e := iface.Addrs()
		if e != nil {
			return "", e
		}
		for _, a := range addresses {
			rows = append(rows, iface.Name+":"+a.String())
		}
	}
	if len(rows) == 0 {
		return "", errors.New("no physical network")
	}
	sort.Strings(rows)
	return strings.Join(rows, "\n"), nil
}
