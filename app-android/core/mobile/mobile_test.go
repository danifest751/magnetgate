package mobile

import (
	"encoding/json"
	"strings"
	"testing"
)

// The app builds its configuration as JSON and reads the status back as JSON, so both ends of that
// contract are pinned here: a field renamed in Go without the app noticing would be a silent failure.
func TestConfigAndStatusAreJSON(t *testing.T) {
	cfg := Config{PSK: "x", Slots: []int{0, 1}, Bootstrap: []string{"127.0.0.1:20001"}, Relays: []string{"wss://relay"}, Preference: []string{"mgt"}}
	encoded, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	for _, field := range []string{`"psk"`, `"slots"`, `"bootstrap"`, `"relays"`, `"preference"`} {
		if !strings.Contains(string(encoded), field) {
			t.Errorf("config JSON is missing %s: %s", field, encoded)
		}
	}

	status := State{Running: true, SocksPort: 1234, SocksAddr: "127.0.0.1:1234", Version: Version}
	encoded, err = json.Marshal(status)
	if err != nil {
		t.Fatalf("marshal status: %v", err)
	}
	for _, field := range []string{`"running"`, `"socksPort"`, `"socksAddr"`, `"snapshot"`, `"logs"`, `"version"`} {
		if !strings.Contains(string(encoded), field) {
			t.Errorf("status JSON is missing %s: %s", field, encoded)
		}
	}
}

func TestParseConfigFillsDefaults(t *testing.T) {
	cfg, err := parseConfig(`{"psk":"secret"}`)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(cfg.Slots) != 1 || cfg.Slots[0] != 0 {
		t.Errorf("slots: %v", cfg.Slots)
	}
	if len(cfg.Preference) != 1 || cfg.Preference[0] != "mgt" {
		t.Errorf("preference: %v", cfg.Preference)
	}
	if cfg.LogLines <= 0 {
		t.Errorf("log lines: %d", cfg.LogLines)
	}

	for name, document := range map[string]string{
		"not JSON":     `not json`,
		"no PSK":       `{"slots":[0]}`,
		"empty string": ``,
	} {
		if _, err := parseConfig(document); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
}

// A configuration without a channel cannot discover anything, and the app must be told so instead of
// getting a core that silently never finds a node.
func TestStartWithoutAChannelFails(t *testing.T) {
	Stop()
	if _, err := Start(`{"psk":"mobile-test-psk"}`); err == nil {
		t.Fatal("a core with no channel must not start")
	}
	status, err := Status()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	var parsed State
	if err := json.Unmarshal([]byte(status), &parsed); err != nil {
		t.Fatalf("status is not JSON: %v", err)
	}
	if parsed.Running {
		t.Error("a core that failed to start must not report as running")
	}
	if parsed.Error == "" {
		t.Error("the failure must be reported to the app")
	}
}

// The lifecycle the app depends on: start returns the port the engine should dial through, status says
// it is up, and stop leaves nothing running. Discovery is deliberately pointed at a dead address - this
// is about the core coming up, not about finding a node.
func TestStartStatusStop(t *testing.T) {
	Stop()
	defer Stop()

	port, err := Start(`{"psk":"mobile-test-psk","bootstrap":["127.0.0.1:1"],"logLines":10}`)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if port < 1 || port > 65535 {
		t.Fatalf("port: %d", port)
	}

	status, err := Status()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	var parsed State
	if err := json.Unmarshal([]byte(status), &parsed); err != nil {
		t.Fatalf("status is not JSON: %v", err)
	}
	if !parsed.Running || parsed.SocksPort != port {
		t.Fatalf("status: %+v", parsed)
	}
	if parsed.Version != Version {
		t.Errorf("version: %q", parsed.Version)
	}
	if len(parsed.Logs) == 0 {
		t.Error("the app has nothing to show in diagnostics")
	}

	Stop()
	status, err = Status()
	if err != nil {
		t.Fatalf("status after stop: %v", err)
	}
	if err := json.Unmarshal([]byte(status), &parsed); err != nil {
		t.Fatalf("status is not JSON: %v", err)
	}
	if parsed.Running {
		t.Error("the core must not report as running after Stop")
	}
}

// Starting again is how the app reconfigures, so it must not leak the previous instance: the second
// start has to come up on its own listener.
func TestStartReplacesARunningCore(t *testing.T) {
	Stop()
	defer Stop()

	first, err := Start(`{"psk":"mobile-test-psk","bootstrap":["127.0.0.1:1"]}`)
	if err != nil {
		t.Fatalf("first start: %v", err)
	}
	second, err := Start(`{"psk":"mobile-test-psk","bootstrap":["127.0.0.1:1"]}`)
	if err != nil {
		t.Fatalf("second start: %v", err)
	}
	if second == 0 {
		t.Fatal("the second start has no listener")
	}
	status, _ := Status()
	var parsed State
	if err := json.Unmarshal([]byte(status), &parsed); err != nil {
		t.Fatalf("status is not JSON: %v", err)
	}
	if parsed.SocksPort != second {
		t.Fatalf("status reports port %d but the core returned %d (first was %d)", parsed.SocksPort, second, first)
	}
}
