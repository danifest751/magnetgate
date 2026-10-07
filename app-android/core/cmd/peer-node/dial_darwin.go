package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func dialPhysical(ctx context.Context, address, baseline string) (net.Conn, error) {
	device := strings.TrimPrefix(strings.SplitN(baseline, "\n", 2)[0], "mac-interface=")
	if !macPhysicalInterface(device) {
		return nil, errors.New("unverified macOS exit interface")
	}
	ip, err := netip.ParseAddrPort(address)
	if err != nil || !ip.Addr().Is4() {
		return nil, errors.New("macOS sharing requires a numeric IPv4 target")
	}
	iface, err := net.InterfaceByName(device)
	if err != nil || iface.Index <= 0 || iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagPointToPoint != 0 {
		return nil, errors.New("macOS exit interface changed")
	}
	d := net.Dialer{Timeout: 5 * time.Second, Control: func(_, _ string, raw syscall.RawConn) error {
		var bindErr error
		err := raw.Control(func(fd uintptr) {
			bindErr = unix.SetsockoptInt(int(fd), unix.IPPROTO_IP, unix.IP_BOUND_IF, iface.Index)
		})
		if err != nil {
			return err
		}
		return bindErr
	}}
	// Binding is mandatory: a route change between inspection and connect must
	// not move a guest socket onto utun. No privileged helper or direct fallback.
	return d.DialContext(ctx, "tcp4", address)
}
