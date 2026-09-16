// Package mobile is the Android app's entry point into the core.
//
// gomobile binds only simple types, so everything crosses the boundary as JSON: the app hands over a
// configuration document and gets back the port its engine should point at, and it asks for a status
// document when it wants to draw something. That keeps the app free of protocol knowledge and keeps this
// package the only place where the core's parts are wired together.
//
// The core opens sockets of its own (the native session to an exit, the DHT socket, relay connections).
// The app makes sure those bypass the tunnel it creates by excluding its own package from the VPN, so
// nothing here has to protect sockets one by one.
package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"

	"magnetgate/core/agent"
	"magnetgate/core/dht"
	"magnetgate/core/nostr"
	"magnetgate/core/pool"
	"magnetgate/core/socks"
)

// Version is the core build the app is running; diagnostics shows it.
const Version = "0.1.0"

// Config is the JSON document Start expects:
//
//	{"psk":"...","slots":[0],"bootstrap":["host:port"],"relays":["wss://..."],"preference":["mgt"]}
//
// A channel (bootstrap and/or relays) is required: without one there is nothing to discover.
type Config struct {
	PSK        string   `json:"psk"`
	Slots      []int    `json:"slots"`
	Bootstrap  []string `json:"bootstrap"`
	Relays     []string `json:"relays"`
	Preference []string `json:"preference"`
	LogLines   int      `json:"logLines"`
}

// State is what the app renders: whether the core is up, where its SOCKS listener is, what it has
// discovered, and the last few log lines for the diagnostics screen.
type State struct {
	Running   bool          `json:"running"`
	SocksPort int           `json:"socksPort"`
	SocksAddr string        `json:"socksAddr"`
	StartedAt int64         `json:"startedAt"`
	Slots     []int         `json:"slots"`
	Snapshot  pool.Snapshot `json:"snapshot"`
	Logs      []string      `json:"logs"`
	Error     string        `json:"error,omitempty"`
	Version   string        `json:"version"`
}

// running is the process-wide core: gomobile bindings are plain functions, so the app talks to one core
// at a time and reconfiguring means starting again.
var (
	mu      sync.Mutex
	current *instance
)

type instance struct {
	cfg      Config
	started  time.Time
	native   *pool.Native
	planes   *pool.Pool
	server   *socks.Server
	rendez   *agent.Agent
	channel  *nostr.Channel
	dhtNode  *dht.Client
	cancel   context.CancelFunc
	logs     *logRing
	started_ bool
	startErr error
}

// Start brings the core up and returns the loopback SOCKS port the engine should dial through. Starting
// while the core runs replaces it, so the app reconfigures by starting again.
func Start(configJSON string) (int, error) {
	mu.Lock()
	defer mu.Unlock()

	cfg, err := parseConfig(configJSON)
	if err != nil {
		return 0, err
	}
	if current != nil {
		current.teardown()
		current = nil
	}

	inst := &instance{cfg: cfg, started: time.Now(), logs: newLogRing(cfg.LogLines)}
	logf := inst.logs.addf
	current = inst // visible even if a step below fails, so Status can explain why
	inst.logs.add(fmt.Sprintf("core %s starting (slots %v, bootstrap %v, relays %v)",
		Version, cfg.Slots, cfg.Bootstrap, cfg.Relays))

	if err := inst.bringUp(logf); err != nil {
		inst.startErr = err
		inst.teardown()
		return 0, err
	}
	inst.logs.add(fmt.Sprintf("socks listening on 127.0.0.1:%d", inst.port()))
	return inst.port(), nil
}

// bringUp wires the channels, the data plane and the entry point. On failure the caller tears the
// instance down, so every step may leave what it opened in place.
func (inst *instance) bringUp(logf func(string, ...any)) error {
	native, err := pool.NewNative(inst.cfg.PSK)
	if err != nil {
		return err
	}
	inst.native = native
	inst.planes = pool.New(pool.Config{
		Preference: inst.cfg.Preference,
		Connectors: map[string]pool.Connector{"mgt": native},
		Logf:       logf,
	})

	ctx, cancel := context.WithCancel(context.Background())
	inst.cancel = cancel

	agentCfg := agent.Config{PSK: inst.cfg.PSK, Slots: inst.cfg.Slots, Logf: logf}
	if len(inst.cfg.Relays) > 0 {
		channel, err := nostr.New(nostr.Config{PSK: inst.cfg.PSK, Relays: inst.cfg.Relays, Logf: logf})
		if err != nil {
			return err
		}
		inst.channel = channel
		agentCfg.Push = channel
	}
	if len(inst.cfg.Bootstrap) > 0 {
		node, err := dht.New(dht.Config{Bootstrap: inst.cfg.Bootstrap, Passive: true, Logf: logf})
		if err != nil {
			return err
		}
		inst.dhtNode = node
		agentCfg.Getter = node
	}
	if agentCfg.Getter == nil && agentCfg.Push == nil {
		return errors.New("no rendezvous channel configured")
	}

	rendez, err := agent.New(agentCfg)
	if err != nil {
		return err
	}
	inst.rendez = rendez

	seen := map[int]int64{}
	go rendez.Run(ctx, func(record *agent.Record) {
		inst.planes.Update(pool.Node{Slot: record.Slot, Name: record.Node, Offer: record.Offer, Seen: record.Seen})
		if seen[record.Slot] != record.Offer.TS {
			seen[record.Slot] = record.Offer.TS
			logf("slot %d: offer from %q (planes %v, seq %s)",
				record.Slot, record.Node, record.Offer.Types(), record.Seq)
		}
	})

	server, err := socks.Listen(0, func(ctx context.Context, host string, port int) (socks.Conn, error) {
		return inst.planes.Dial(ctx, host, port)
	})
	if err != nil {
		return err
	}
	inst.server = server
	return nil
}

// port is the SOCKS port, or 0 when the core is not listening.
func (inst *instance) port() int {
	if inst.server == nil {
		return 0
	}
	_, portText, err := net.SplitHostPort(inst.server.Addr().String())
	if err != nil {
		return 0
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		return 0
	}
	return port
}

// teardown releases everything this instance opened. It is safe to call more than once.
func (inst *instance) teardown() {
	if inst.cancel != nil {
		inst.cancel()
		inst.cancel = nil
	}
	if inst.server != nil {
		inst.server.Close()
		inst.server = nil
	}
	if inst.channel != nil {
		inst.channel.Close()
		inst.channel = nil
	}
	if inst.dhtNode != nil {
		inst.dhtNode.Close()
		inst.dhtNode = nil
	}
	if inst.native != nil {
		inst.native.Close()
		inst.native = nil
	}
}

// Stop tears the core down: listeners, sessions and channels.
func Stop() {
	mu.Lock()
	defer mu.Unlock()
	if current != nil {
		current.teardown()
		current = nil
	}
}

// Status is the document the UI renders.
func Status() (string, error) {
	mu.Lock()
	defer mu.Unlock()
	if current == nil {
		return marshal(State{Version: Version})
	}
	return marshal(current.status())
}

func (inst *instance) status() State {
	out := State{
		Version:   Version,
		StartedAt: inst.started.UnixMilli(),
		Logs:      inst.logs.lines(),
		Error:     errorText(inst.startErr),
	}
	if port := inst.port(); port != 0 {
		out.Running = true
		out.SocksPort = port
		out.SocksAddr = inst.server.Addr().String()
	}
	if inst.planes != nil {
		out.Snapshot = inst.planes.Snapshot()
	}
	if inst.rendez != nil {
		out.Slots = inst.rendez.Slots()
	}
	return out
}

func parseConfig(configJSON string) (Config, error) {
	var cfg Config
	if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil {
		return cfg, fmt.Errorf("config is not JSON: %w", err)
	}
	if cfg.PSK == "" {
		return cfg, errors.New("no PSK")
	}
	if len(cfg.Slots) == 0 {
		cfg.Slots = []int{0}
	}
	if cfg.LogLines <= 0 {
		cfg.LogLines = 200
	}
	if len(cfg.Preference) == 0 {
		cfg.Preference = []string{"mgt"}
	}
	return cfg, nil
}

func marshal(state State) (string, error) {
	encoded, err := json.Marshal(state)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// logRing keeps the last N lines for the diagnostics screen without letting the core grow memory.
type logRing struct {
	mu    sync.Mutex
	max   int
	items []string
}

func newLogRing(max int) *logRing { return &logRing{max: max} }

func (r *logRing) add(line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items = append(r.items, time.Now().Format("15:04:05")+" "+line)
	if len(r.items) > r.max {
		r.items = r.items[len(r.items)-r.max:]
	}
}

// addf is the shape the other packages log with.
func (r *logRing) addf(format string, args ...any) { r.add(fmt.Sprintf(format, args...)) }

func (r *logRing) lines() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.items))
	copy(out, r.items)
	return out
}
