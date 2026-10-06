package mobile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"magnetgate/core/pool"
)

func TestHintStoreRestoresOnlyRecentHintsFromSameGroup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hint.json")
	s := newHintStore(path, "secret-group-key")
	h := pool.Hint{Slot: 1, Plane: "hy2", Fingerprint: strings.Repeat("a", 64), GoodAt: time.Now().UnixMilli()}
	s.save(h)
	got := newHintStore(path, "secret-group-key").load()
	if got == nil || *got != h {
		t.Fatalf("restored hint: %+v", got)
	}
	if newHintStore(path, "different-group").load() != nil {
		t.Fatal("hint crossed group boundary")
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "secret-group-key") {
		t.Fatal("plaintext group key saved")
	}
	h.GoodAt = time.Now().Add(-pool.HintTTL - time.Second).UnixMilli()
	newHintStore(path, "secret-group-key").save(h)
	if s.load() != nil {
		t.Fatal("expired hint restored")
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("x", 2048)), 0600); err != nil {
		t.Fatal(err)
	}
	if s.load() != nil {
		t.Fatal("oversized hint accepted")
	}
}
