package mgbox

import (
	"context"
	"encoding/json"
	"errors"
	"magnetgate/core/peer"
	"net"
	"net/netip"
	"sync"
	"syscall"
	"time"
)

// PeerPlatform binds only the trusted service link to Android's physical
// Network. It never provides a process-wide bypass or an Android exit adapter.
type PeerPlatform interface {
	Resolve(host string) (string, error)
	Bind(fd int64, generation string) error
}
type mobilePeerNetwork struct{ platform PeerPlatform }

func (*mobilePeerNetwork) Ready() bool             { return false }
func (*mobilePeerNetwork) CanShare() bool          { return false }
func (*mobilePeerNetwork) Blocked(netip.Addr) bool { return true }
func (*mobilePeerNetwork) Resolve(context.Context, string) ([]netip.Addr, error) {
	return nil, errors.New("Android exit is not enabled")
}
func (*mobilePeerNetwork) Dial(context.Context, string) (net.Conn, error) {
	return nil, errors.New("Android exit is not enabled")
}
func (n *mobilePeerNetwork) link(ctx context.Context, network, address string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	select {
	case physicalLookups <- struct{}{}:
	default:
		return nil, errors.New("physical resolver capacity")
	}
	type lookup struct {
		value string
		err   error
	}
	answer := make(chan lookup, 1)
	go func() {
		defer func() { <-physicalLookups }()
		value, err := n.platform.Resolve(host)
		answer <- lookup{value, err}
	}()
	var resolved lookup
	select {
	case resolved = <-answer:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	value, err := resolved.value, resolved.err
	if err != nil {
		return nil, err
	}
	var result struct {
		Generation string   `json:"generation"`
		Addresses  []string `json:"addresses"`
	}
	if json.Unmarshal([]byte(value), &result) != nil || result.Generation == "" || len(result.Addresses) == 0 || len(result.Addresses) > 16 {
		return nil, errors.New("invalid physical DNS result")
	}
	ip, err := netip.ParseAddr(result.Addresses[0])
	if err != nil || ip.Zone() != "" {
		return nil, errors.New("invalid physical service address")
	}
	d := net.Dialer{Timeout: 5 * time.Second, Control: func(_, _ string, raw syscall.RawConn) error {
		var bindErr error
		err := raw.Control(func(fd uintptr) { bindErr = n.platform.Bind(int64(fd), result.Generation) })
		if err != nil {
			return err
		}
		return bindErr
	}}
	return d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
}

// Platform DNS is synchronous. Abandoned callbacks are bounded process-wide,
// while Go connection/shutdown deadlines remain cancellable.
var physicalLookups = make(chan struct{}, 4)

var peerState struct {
	sync.Mutex
	host   *peer.Host
	cancel context.CancelFunc
}

func StartPeer(profile string, platform PeerPlatform) (string, error) {
	peerState.Lock()
	defer peerState.Unlock()
	if peerState.host != nil {
		return peerState.host.JSON(), nil
	}
	if platform == nil {
		return "", errors.New("physical network adapter is required")
	}
	ctx, cancel := context.WithCancel(context.Background())
	n := &mobilePeerNetwork{platform}
	host, err := peer.OpenHost(ctx, profile, n, n.link)
	if err != nil {
		cancel()
		return "", err
	}
	peerState.host, peerState.cancel = host, cancel
	return host.JSON(), nil
}
func PeerStatus() string {
	peerState.Lock()
	defer peerState.Unlock()
	if peerState.host == nil {
		return `{"configured":false,"connected":false,"countries":[]}`
	}
	return peerState.host.JSON()
}
func BeginPeer(token string) error {
	peerState.Lock()
	host := peerState.host
	peerState.Unlock()
	if host == nil || token == "" {
		return errors.New("peer guest is not initialized")
	}
	host.ActivateGuest(token)
	return nil
}
func ConnectPeer(country string, token string) (string, error) {
	peerState.Lock()
	host := peerState.host
	peerState.Unlock()
	if host == nil {
		return "", errors.New("peer service is not configured")
	}
	endpoint, err := host.Connect(country, 0, token)
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(endpoint)
	return string(b), err
}
func DisconnectPeer() {
	peerState.Lock()
	host := peerState.host
	peerState.Unlock()
	if host != nil {
		host.Disconnect()
	}
}
func StopPeer() {
	peerState.Lock()
	host := peerState.host
	if host != nil {
		peerState.cancel()
		peerState.host = nil
	}
	peerState.Unlock()
	if host != nil {
		host.Close()
	}
}
