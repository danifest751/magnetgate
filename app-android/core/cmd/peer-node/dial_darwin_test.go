package main

import (
	"context"
	"net"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestMacNativePhysicalSnapshotAndSocketBinding(t *testing.T) {
	if os.Getenv("MAGNETGATE_MAC_PEER_SMOKE") != "1" {
		t.Skip("native macOS peer smoke requested by CI")
	}
	if os.Geteuid() == 0 {
		t.Fatal("sharing must run without root")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s, err := macNetworkSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	device := strings.TrimPrefix(strings.SplitN(s, "\n", 2)[0], "mac-interface=")
	iface, err := net.InterfaceByName(device)
	if err != nil {
		t.Fatal(err)
	}
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	if err := unix.SetsockoptInt(fd, unix.IPPROTO_IP, unix.IP_BOUND_IF, iface.Index); err != nil {
		t.Fatal(err)
	}
	bound, err := unix.GetsockoptInt(fd, unix.IPPROTO_IP, unix.IP_BOUND_IF)
	if err != nil || bound != iface.Index {
		t.Fatal("physical interface binding failed", bound, err)
	}
	if !(new(physicalNetwork)).CanShare() {
		t.Fatal("macOS sharing capability disabled")
	}
	for _, address := range []string{"example.com:443", "[::1]:443"} {
		if conn, err := dialPhysical(ctx, address, s); err == nil {
			conn.Close()
			t.Fatal("non-IPv4 dial accepted")
		}
	}
	// Exercise the production Dialer.Control path, including the unprivileged
	// socket option, rather than only testing setsockopt in isolation.
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer dialCancel()
	conn, err := dialPhysical(dialCtx, "1.1.1.1:443", s)
	if err != nil {
		t.Fatal("physical TCP dial", err)
	}
	defer conn.Close()
	raw, err := conn.(syscall.Conn).SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var optionErr error
	if err := raw.Control(func(fd uintptr) { bound, optionErr = unix.GetsockoptInt(int(fd), unix.IPPROTO_IP, unix.IP_BOUND_IF) }); err != nil {
		t.Fatal(err)
	}
	if optionErr != nil || bound != iface.Index {
		t.Fatal("guest socket is not physically bound", bound, optionErr)
	}
}

func TestMacNativeSnapshotRejectsActiveTunnel(t *testing.T) {
	if os.Getenv("MAGNETGATE_MAC_PEER_EXPECT_TUN") != "1" {
		t.Skip("requires the desktop CI's live utun")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := macNetworkSnapshot(ctx)
	if err == nil || !strings.Contains(err.Error(), "IPv4 route uses an unverified interface") {
		t.Fatal("active utun must prevent IPv4 sharing", err)
	}
}
