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
	"encoding/json"
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
	"syscall"
	"time"

	"magnetgate/core/agent"
	"magnetgate/core/dht"
	"magnetgate/core/nostr"
	"magnetgate/core/offer"
	"magnetgate/core/pool"
	"magnetgate/core/proto"
	"magnetgate/core/socks"
	"magnetgate/core/socks5client"
)

// The data plane itself lives in core/pool: this tool only wires it, because the same wiring is what
// the app needs (a rendezvous feeding a pool of nodes, and a SOCKS listener on top of it).

func main() {
	exitAddr := flag.String("exit", "", "native endpoint of a known exit, host:port (skips the rendezvous)")
	slotsFlag := flag.String("slots", "0", "node slots to poll from the rendezvous, comma separated")
	bootstrap := flag.String("bootstrap", "", "DHT bootstrap nodes, host:port[,host:port...]")
	relays := flag.String("relays", "", "Nostr relays to subscribe to, comma separated (the second channel)")
	socksPort := flag.Int("socks-port", 0, "loopback SOCKS5 port, 0 picks a free one")
	var checks stringList
	flag.Var(&checks, "check", "fetch this URL through the tunnel and print the result (repeatable)")
	pskFile := flag.String("psk-file", "", "read the PSK from this file instead of MG_PSK")
	hold := flag.Duration("hold", 0, "keep serving for this long after the check")
	every := flag.Duration("every", 0, "with -hold, repeat the checks at this interval")
	timeout := flag.Duration("timeout", 30*time.Second, "budget for each -check")
	discover := flag.Duration("discover", 45*time.Second, "how long to wait for an offer before giving up")
	snapshotPath := flag.String("snapshot", "", "write the diagnostics snapshot here when it changes")
	flag.Parse()

	psk, err := readPSK(*pskFile)
	if err != nil {
		fail(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	logf := func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "[rv] "+format+"\n", args...)
	}
	// the data-plane log goes to stdout: which plane and node carried each stream is what the stand
	// asserts on, and it is the same line the desktop client prints
	planeLog := func(format string, args ...any) {
		fmt.Printf("[dp] "+format+"\n", args...)
	}

	native, err := pool.NewNative(psk)
	if err != nil {
		fail(err)
	}
	defer native.Close()
	plane := pool.New(pool.Config{
		Preference: splitList("mgt"), // libbox planes (reality, hy2) are added by the app
		Connectors: map[string]pool.Connector{"mgt": native},
		Logf:       planeLog,
	})

	if *exitAddr != "" {
		host, port, err := splitHostPort(*exitAddr)
		if err != nil {
			fail(err)
		}
		node := directNode(host, port, 0)
		plane.Update(node)
		go keepSeeding(ctx, plane, node)
		fmt.Printf("exit slot 0 at %s:%d\n", host, port)
	} else {
		if *bootstrap == "" && *relays == "" {
			fail(errors.New("either -exit, or -bootstrap and/or -relays is required"))
		}
		if err := startRendezvous(ctx, plane, psk, *slotsFlag, *bootstrap, *relays, *discover, logf); err != nil {
			fail(err)
		}
		for _, node := range plane.Nodes() {
			host, port, ok := nativeEndpoint(node)
			if !ok {
				continue
			}
			fmt.Printf("exit slot %d at %s:%d\n", node.Slot, host, port)
		}
	}

	server, err := socks.Listen(*socksPort, func(ctx context.Context, host string, port int) (socks.Conn, error) {
		return plane.Dial(ctx, host, port)
	})
	if err != nil {
		fail(err)
	}
	defer server.Close()
	fmt.Printf("socks 127.0.0.1:%d\n", portOf(server.Addr()))

	if *snapshotPath != "" {
		go writeSnapshots(ctx, plane, *snapshotPath)
	}

	failed := runChecks(ctx, server.Addr().String(), checks, *every, *hold, *timeout)

	// with -every the hold is the check window and has already been spent; without it, -hold means "keep
	// serving for a while after the checks"
	if *hold > 0 && *every <= 0 {
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

// runChecks fetches every URL once, or repeatedly until the hold expires when -every is set. In repeat
// mode the exit code reflects the last round: the point of running for a while is to survive a change
// in the middle (a node dying, a plane being blocked), not to be pristine at every instant.
func runChecks(ctx context.Context, proxyAddr string, urls []string, every, hold, timeout time.Duration) bool {
	if len(urls) == 0 {
		return false
	}
	deadline := time.Now().Add(hold)
	failed := false
	for {
		for _, url := range urls {
			attempt, cancel := context.WithTimeout(ctx, timeout)
			err := check(attempt, proxyAddr, url)
			cancel()
			failed = err != nil
			if err != nil {
				fmt.Fprintf(os.Stderr, "check failed: %v\n", err)
			}
		}
		if every <= 0 || hold <= 0 || time.Now().After(deadline) {
			return failed
		}
		select {
		case <-ctx.Done():
			return failed
		case <-time.After(every):
		}
	}
}

// startRendezvous wires every configured channel to an agent and runs the poll loop, then waits for the
// first usable node so a caller does not have to sit through an arbitrary sleep. The DHT channel answers
// requests; the Nostr channel pushes, so an offer published while we are already subscribed arrives
// without waiting for the next poll.
func startRendezvous(ctx context.Context, plane *pool.Pool, psk, slotsFlag, bootstrap, relays string, budget time.Duration, logf func(string, ...any)) error {
	slots, err := parseSlots(slotsFlag)
	if err != nil {
		return err
	}
	agentCfg := agent.Config{PSK: psk, Slots: slots, Logf: logf}

	if relays != "" {
		channel, err := nostr.New(nostr.Config{PSK: psk, Relays: splitList(relays), Logf: logf})
		if err != nil {
			return err
		}
		defer channel.Close()
		agentCfg.Push = channel
		logf("nostr: subscribing across %d relay(s)", channel.RelayCount())
	}
	if bootstrap != "" {
		channel, err := dht.New(dht.Config{Bootstrap: splitList(bootstrap), Passive: true, Logf: logf})
		if err != nil {
			return err
		}
		defer channel.Close()
		agentCfg.Getter = channel
	}

	rendezvous, err := agent.New(agentCfg)
	if err != nil {
		return err
	}

	// one line per generation, not one per poll: the loop runs every few seconds
	lastLogged := map[int]int64{}
	go rendezvous.Run(ctx, func(record *agent.Record) {
		plane.Update(pool.Node{Slot: record.Slot, Name: record.Node, Offer: record.Offer, Seen: record.Seen})
		if lastLogged[record.Slot] != record.Offer.TS {
			lastLogged[record.Slot] = record.Offer.TS
			logf("slot %d: offer from %q (country %q, planes %v, seq %s)",
				record.Slot, record.Node, record.Country, record.Offer.Types(), record.Seq)
		}
	})

	deadline := time.Now().Add(budget)
	for {
		if len(plane.Nodes()) > 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("no usable offer after %s (slots %v)", budget, rendezvous.Slots())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// directNode is the synthetic record for -exit: an endpoint from the command line is a node whose offer
// is made up here, so everything downstream can treat the two cases the same.
func directNode(host string, port, slot int) pool.Node {
	dp, _ := json.Marshal(map[string]any{"t": "mgt", "protocol": 4, "host": host, "port": port})
	slotValue := slot
	return pool.Node{
		Slot: slot,
		Name: "direct",
		Offer: &offer.Offer{
			V:    offer.Schema,
			TS:   time.Now().UnixMilli(),
			Slot: &slotValue,
			Node: "direct",
			DP:   []json.RawMessage{dp},
		},
		Seen: time.Now(),
	}
}

// keepSeeding refreshes a synthetic node: "seen now" is the truth for an endpoint that comes from the
// command line and cannot go stale the way a published offer does.
func keepSeeding(ctx context.Context, plane *pool.Pool, node pool.Node) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			fresh := directNode("", 0, node.Slot)
			if host, port, ok := nativeEndpoint(node); ok {
				fresh = directNode(host, port, node.Slot)
			}
			plane.Update(fresh)
		}
	}
}

// nativeEndpoint reads the mgt entry out of an offer.
func nativeEndpoint(node pool.Node) (string, int, bool) {
	raw := node.Offer.Pick([]string{"mgt"})
	if raw == nil {
		return "", 0, false
	}
	var entry struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	}
	if err := json.Unmarshal(raw, &entry); err != nil || entry.Host == "" || entry.Port == 0 {
		return "", 0, false
	}
	return entry.Host, entry.Port, true
}

// writeSnapshots keeps a diagnostics file current, the same way the desktop publishes what sing-box
// needs: rewritten only when something actually changed, and replaced atomically so a reader never sees
// a half-written file.
func writeSnapshots(ctx context.Context, plane *pool.Pool, path string) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var last string
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			encoded, err := json.Marshal(plane.Snapshot())
			if err != nil || string(encoded) == last {
				continue
			}
			last = string(encoded)
			tmp := path + ".tmp"
			if err := os.WriteFile(tmp, encoded, 0o600); err != nil {
				fmt.Fprintf(os.Stderr, "snapshot: %v\n", err)
				continue
			}
			if err := os.Rename(tmp, path); err != nil {
				fmt.Fprintf(os.Stderr, "snapshot: %v\n", err)
			}
		}
	}
}

func parseSlots(list string) ([]int, error) {
	out := make([]int, 0, 4)
	for _, field := range splitList(list) {
		slot, err := strconv.Atoi(field)
		if err != nil {
			return nil, fmt.Errorf("invalid slot %q", field)
		}
		if err := proto.ValidSlot(slot); err != nil {
			return nil, err
		}
		out = append(out, slot)
	}
	if len(out) == 0 {
		return nil, errors.New("no slots given")
	}
	return out, nil
}

func splitList(list string) []string {
	fields := strings.FieldsFunc(list, func(r rune) bool { return r == ',' || r == ' ' })
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		if field != "" {
			out = append(out, field)
		}
	}
	return out
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
		Transport: &http.Transport{DialContext: socks5client.DialContext(proxyAddr), DisableKeepAlives: true},
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
