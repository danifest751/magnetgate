// Package socks5client is a minimal RFC 1928 client: it opens a stream to a target through a SOCKS5
// listener.
//
// The client needs it because of how the engine is wired: each non-native plane of a node (reality,
// hysteria2) is exposed as a local SOCKS listener by sing-box, and the core talks to those exactly the way
// it would talk to any other plane. The host is always sent unresolved, so the side behind the proxy does
// the DNS lookup - which is the whole point of a tunnel.
package socks5client

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
)

// Conn is a stream through the proxy. A plain net.Conn is not enough for a relay: it has to be able to
// close one direction and leave the other open.
type Conn struct {
	net.Conn
}

// CloseWrite half-closes the stream, so the target sees an end of input while the answer can still come.
func (c *Conn) CloseWrite() error {
	if half, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return half.CloseWrite()
	}
	// not a connection that can half-close: closing it is the best available answer
	return c.Conn.Close()
}

// Dial opens a stream to host:port through the SOCKS5 listener at proxyAddr.
func Dial(ctx context.Context, proxyAddr, host string, port int) (*Conn, error) {
	if host == "" || len(host) > 255 {
		return nil, fmt.Errorf("socks5client: invalid host %q", host)
	}
	if port < 1 || port > 65535 {
		return nil, fmt.Errorf("socks5client: invalid port %d", port)
	}
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", proxyAddr)
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		conn.SetDeadline(deadline)
	}
	if err := connect(conn, host, port); err != nil {
		conn.Close()
		return nil, err
	}
	conn.SetDeadline(time.Time{})
	return &Conn{Conn: conn}, nil
}

// DialContext is Dial in the shape net/http wants.
func DialContext(proxyAddr string) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		if network != "tcp" && network != "tcp4" && network != "tcp6" {
			return nil, fmt.Errorf("socks5client: unsupported network %q", network)
		}
		host, portText, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return nil, fmt.Errorf("socks5client: invalid port %q", portText)
		}
		return Dial(ctx, proxyAddr, host, port)
	}
}

// ErrRefused means the proxy answered, and the answer was no (RFC 1928 §6).
var ErrRefused = errors.New("socks5client: the request was refused")

// connect performs the greeting and the CONNECT request on an established connection.
func connect(conn net.Conn, host string, port int) error {
	if _, err := conn.Write([]byte{5, 1, 0}); err != nil {
		return err
	}
	greeting := make([]byte, 2)
	if _, err := io.ReadFull(conn, greeting); err != nil {
		return err
	}
	if greeting[0] != 5 {
		return fmt.Errorf("socks5client: version %d", greeting[0])
	}
	if greeting[1] != 0 {
		return fmt.Errorf("socks5client: the proxy wants method %d, not none", greeting[1])
	}

	request := []byte{5, 1, 0} // CONNECT, reserved
	if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
		request = append(request, 1)
		request = append(request, ip.To4()...)
	} else if ip != nil {
		request = append(request, 4)
		request = append(request, ip.To16()...)
	} else {
		request = append(request, 3, byte(len(host)))
		request = append(request, host...)
	}
	request = append(request, byte(port>>8), byte(port))
	if _, err := conn.Write(request); err != nil {
		return err
	}
	return readReply(conn)
}

// readReply parses the variable-length reply instead of assuming a ten-byte one.
func readReply(conn net.Conn) error {
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return err
	}
	if head[0] != 5 {
		return fmt.Errorf("socks5client: reply version %d", head[0])
	}
	if head[1] != 0 {
		return fmt.Errorf("%w (code %d)", ErrRefused, head[1])
	}
	switch head[3] {
	case 1:
		_, err := io.ReadFull(conn, make([]byte, net.IPv4len+2))
		return err
	case 4:
		_, err := io.ReadFull(conn, make([]byte, net.IPv6len+2))
		return err
	case 3:
		length, err := readByte(conn)
		if err != nil {
			return err
		}
		_, err = io.ReadFull(conn, make([]byte, int(length)+2))
		return err
	default:
		return fmt.Errorf("socks5client: reply address type %d", head[3])
	}
}

func readByte(conn net.Conn) (byte, error) {
	buf := make([]byte, 1)
	if _, err := io.ReadFull(conn, buf); err != nil {
		return 0, err
	}
	return buf[0], nil
}
