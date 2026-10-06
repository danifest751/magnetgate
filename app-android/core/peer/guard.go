package peer

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
)

var deniedPrefixes = func() []netip.Prefix {
	var result []netip.Prefix
	for _, s := range []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3", "192.88.99.0/24", "2001::/23", "2001:db8::/32", "2002::/16"} {
		result = append(result, netip.MustParsePrefix(s))
	}
	return result
}()

func PublicTarget(a netip.Addr) bool {
	if !a.IsValid() || a.Zone() != "" {
		return false
	}
	a = a.Unmap()
	if !a.IsGlobalUnicast() || a.IsPrivate() {
		return false
	}
	if a.Is6() && !netip.MustParsePrefix("2000::/3").Contains(a) {
		return false
	} // includes no NAT64/ULA/link-local
	for _, p := range deniedPrefixes {
		if p.Contains(a) {
			return false
		}
	}
	return true
}

// Network is provided by the host. Ready must become false on ANY route or
// physical-network uncertainty, including another VPN. Resolve and Dial must
// use that same physical network generation. No guest-supplied dial callbacks.
type Network interface {
	Ready() bool
	Resolve(context.Context, string) ([]netip.Addr, error)
	Dial(context.Context, string) (net.Conn, error)
	Blocked(netip.Addr) bool
}

// PinnedNetwork carries an immutable physical-network generation from DNS to
// numeric dial. Adapters must reject a token invalidated by a handover or pause.
type PinnedNetwork interface {
	ResolvePinned(context.Context, string) ([]netip.Addr, string, error)
	DialPinned(context.Context, string, string) (net.Conn, error)
}

func guardedDial(ctx context.Context, network Network, host string, port int) (net.Conn, error) {
	if !network.Ready() {
		return nil, errors.New("physical network is not ready")
	}
	if len(host) == 0 || len(host) > 253 || strings.ContainsAny(host, "\x00 /\\%\r\n\t") || port < 1 || port > 65535 {
		return nil, errors.New("invalid target")
	}
	// Deny privileged/abuse-heavy services in the first opt-in pilot.
	if port != 80 && port != 443 {
		return nil, errors.New("target port not allowed")
	}
	var addresses []netip.Addr
	var generation string
	var err error
	pinned, usesPin := network.(PinnedNetwork)
	if usesPin {
		addresses, generation, err = pinned.ResolvePinned(ctx, host)
	} else {
		addresses, err = network.Resolve(ctx, host)
	}
	if err != nil {
		return nil, err
	}
	if len(addresses) == 0 || len(addresses) > 16 {
		return nil, errors.New("invalid DNS answer")
	}
	for _, a := range addresses {
		if !PublicTarget(a) || network.Blocked(a.Unmap()) {
			return nil, errors.New("target is not public")
		}
	}
	if !network.Ready() {
		return nil, errors.New("network changed during DNS")
	}
	// Numeric dial pins the checked DNS answer, preventing a second resolution.
	address := net.JoinHostPort(addresses[0].Unmap().String(), strconv.Itoa(port))
	if usesPin {
		if generation == "" {
			return nil, errors.New("missing physical network generation")
		}
		return pinned.DialPinned(ctx, address, generation)
	}
	return network.Dial(ctx, address)
}
