// agent-cli exercises the core end to end without the Android app: it opens a native session to one
// exit, serves SOCKS5 on loopback and, with -check, fetches a URL through its own listener. That is the
// same chain the app will use (SOCKS entry point → native mux → exit → target), so a green run here
// means the pieces are wired correctly before Compose and libbox enter the picture.
//
// Rendezvous is not implemented yet: the exit is given directly with -exit. Once core/dht and
// core/nostr exist, this tool grows the discovery loop and becomes the M2 acceptance harness.
//
// The PSK never comes from argv: pass MG_PSK or -psk-file.
//
//	MG_PSK=... agent-cli -exit 203.0.113.10:49001 -check http://checkip.amazonaws.com/
//	MG_PSK=... agent-cli -exit 203.0.113.10:49001 -hold 60s   (curl --socks5-hostname 127.0.0.1:<n>)
//
// Exit codes: 0 ok, 1 the check failed, 2 bad usage.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"magnetgate/core/proto"
	"magnetgate/core/session"
	"magnetgate/core/socks"
)

// direct is one native session to one exit, reopened on demand. It is the only data plane this tool
// has; the app will add libbox outbounds next to it and the rendezvous ahead of it.
type direct struct {
	host string
	port int
	key  *[32]byte

	mu      sync.Mutex
	current *session.Session
}

func (d *direct) dial(ctx context.Context, host string, port int) (socks.Conn, error) {
	stream, err := d.open(ctx, host, port)
	if err != nil && ctx.Err() == nil {
		// the session may have died between calls: one retry on a fresh one
		stream, err = d.open(ctx, host, port)
	}
	if err != nil {
		return nil, err
	}
	return stream, nil
}

func (d *direct) open(ctx context.Context, host string, port int) (*session.Stream, error) {
	s, err := d.session(ctx)
	if err != nil {
		return nil, err
	}
	stream, err := s.OpenStream(ctx, session.Target{Host: host, Port: port})
	if err != nil {
		d.drop(s)
		return nil, err
	}
	return stream, nil
}

func (d *direct) session(ctx context.Context) (*session.Session, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.current != nil {
		return d.current, nil
	}
	s, err := session.Connect(ctx, d.host, d.port, d.key)
	if err != nil {
		return nil, err
	}
	s.SetOnClose(func() { d.drop(s) })
	d.current = s
	return s, nil
}

func (d *direct) drop(s *session.Session) {
	d.mu.Lock()
	if d.current == s {
		d.current = nil
	}
	d.mu.Unlock()
}

func (d *direct) close() {
	d.mu.Lock()
	s := d.current
	d.current = nil
	d.mu.Unlock()
	if s != nil {
		s.Close()
	}
}

func main() {
	exitAddr := flag.String("exit", "", "native endpoint of the exit, host:port (required)")
	socksPort := flag.Int("socks-port", 0, "loopback SOCKS5 port, 0 picks a free one")
	var checks stringList
	flag.Var(&checks, "check", "fetch this URL through the tunnel and print the result (repeatable)")
	pskFile := flag.String("psk-file", "", "read the PSK from this file instead of MG_PSK")
	hold := flag.Duration("hold", 0, "keep serving for this long after the check")
	timeout := flag.Duration("timeout", 30*time.Second, "budget for each -check")
	flag.Parse()

	if *exitAddr == "" {
		fail(errors.New("usage: agent-cli -exit host:port [-check URL] [-hold 30s] (PSK from MG_PSK or -psk-file)"))
	}
	exitHost, exitPort, err := splitHostPort(*exitAddr)
	if err != nil {
		fail(err)
	}
	psk, err := readPSK(*pskFile)
	if err != nil {
		fail(err)
	}
	keys, err := proto.DeriveKeys(psk)
	if err != nil {
		fail(err)
	}

	plane := &direct{host: exitHost, port: exitPort, key: &keys.BoxKey}
	defer plane.close()

	server, err := socks.Listen(*socksPort, plane.dial)
	if err != nil {
		fail(err)
	}
	defer server.Close()
	fmt.Printf("socks 127.0.0.1:%d\n", portOf(server.Addr()))

	failed := false
	for _, url := range checks {
		ctx, cancel := context.WithTimeout(context.Background(), *timeout)
		if err := check(ctx, server.Addr().String(), url); err != nil {
			fmt.Fprintf(os.Stderr, "check failed: %v\n", err)
			failed = true
		}
		cancel()
	}

	if *hold > 0 {
		stopping := make(chan os.Signal, 1)
		signal.Notify(stopping, os.Interrupt, syscall.SIGTERM)
		select {
		case <-stopping:
		case <-time.After(*hold):
		}
	}
	if failed {
		os.Exit(1)
	}
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "agent-cli: %v\n", err)
	os.Exit(2)
}

// stringList collects a flag given more than once.
type stringList []string

func (l *stringList) String() string { return strings.Join(*l, ",") }

func (l *stringList) Set(value string) error {
	*l = append(*l, value)
	return nil
}

// check fetches a URL through the listener, which is what makes the run a real end-to-end test: the
// bytes go SOCKS5 → native session → exit → target.
func check(ctx context.Context, proxyAddr, url string) error {
	client := &http.Client{
		Timeout:   0, // the context carries the budget
		Transport: &http.Transport{DialContext: socksDial(ctx, proxyAddr), DisableKeepAlives: true},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return err
	}
	fmt.Printf("check %s -> %s %s\n", url, resp.Status, strings.TrimSpace(string(body)))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %s", resp.Status)
	}
	return nil
}

// socksDial is a minimal RFC 1928 client: enough to prove the listener works from an independent
// implementation. The host is sent unresolved, so the exit does the DNS lookup.
func socksDial(ctx context.Context, proxyAddr string) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		if network != "tcp" && network != "tcp4" && network != "tcp6" {
			return nil, fmt.Errorf("unsupported network %q", network)
		}
		host, portText, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		port, err := strconv.Atoi(portText)
		if err != nil || port < 1 || port > 65535 {
			return nil, fmt.Errorf("invalid port %q", portText)
		}
		var dialer net.Dialer
		conn, err := dialer.DialContext(ctx, "tcp", proxyAddr)
		if err != nil {
			return nil, err
		}
		if deadline, ok := ctx.Deadline(); ok {
			conn.SetDeadline(deadline)
		}
		if err := socksConnect(conn, host, port); err != nil {
			conn.Close()
			return nil, err
		}
		conn.SetDeadline(time.Time{})
		return conn, nil
	}
}

func socksConnect(conn net.Conn, host string, port int) error {
	if _, err := conn.Write([]byte{5, 1, 0}); err != nil {
		return err
	}
	greeting := make([]byte, 2)
	if _, err := io.ReadFull(conn, greeting); err != nil {
		return err
	}
	if greeting[0] != 5 || greeting[1] != 0 {
		return fmt.Errorf("socks: greeting rejected (%v)", greeting)
	}

	request := []byte{5, 1, 0}
	if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
		request = append(request, 1)
		request = append(request, ip.To4()...)
	} else if ip != nil {
		request = append(request, 4)
		request = append(request, ip.To16()...)
	} else {
		if len(host) == 0 || len(host) > 255 {
			return fmt.Errorf("socks: invalid host %q", host)
		}
		request = append(request, 3, byte(len(host)))
		request = append(request, host...)
	}
	request = append(request, byte(port>>8), byte(port))
	if _, err := conn.Write(request); err != nil {
		return err
	}
	return readReply(conn)
}

// readReply parses the variable-length reply instead of assuming a 10-byte one.
func readReply(conn net.Conn) error {
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return err
	}
	if head[0] != 5 {
		return fmt.Errorf("socks: reply version %d", head[0])
	}
	if head[1] != 0 {
		return fmt.Errorf("socks: request failed with code %d", head[1])
	}
	switch head[3] {
	case 1:
		_, err := io.ReadFull(conn, make([]byte, 4+2))
		return err
	case 4:
		_, err := io.ReadFull(conn, make([]byte, 16+2))
		return err
	case 3:
		length, err := readByte(conn)
		if err != nil {
			return err
		}
		_, err = io.ReadFull(conn, make([]byte, int(length)+2))
		return err
	default:
		return fmt.Errorf("socks: reply address type %d", head[3])
	}
}

func readByte(conn net.Conn) (byte, error) {
	buf := make([]byte, 1)
	if _, err := io.ReadFull(conn, buf); err != nil {
		return 0, err
	}
	return buf[0], nil
}

func readPSK(file string) (string, error) {
	if file == "" {
		psk := os.Getenv("MG_PSK")
		if psk == "" {
			return "", errors.New("no PSK: set MG_PSK or pass -psk-file")
		}
		return strings.TrimSpace(psk), nil
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	psk := strings.TrimSpace(string(raw))
	if psk == "" {
		return "", fmt.Errorf("empty PSK in %s", file)
	}
	return psk, nil
}

func splitHostPort(addr string) (string, int, error) {
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		return "", 0, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 || host == "" {
		return "", 0, fmt.Errorf("invalid endpoint %q", addr)
	}
	return host, port, nil
}

func portOf(addr net.Addr) int {
	tcp, ok := addr.(*net.TCPAddr)
	if !ok {
		return 0
	}
	return tcp.Port
}
