package health

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The timeline in the vectors is produced by the Node implementation (scripts/dev/gen-vectors.mjs):
// same failures at the same times must produce the same pauses, escalation and usability on both sides.

type vectorFile struct {
	Health struct {
		Steps []struct {
			Op     string  `json:"op"`
			Exit   string  `json:"exit"`
			Plane  string  `json:"plane"`
			AtMs   int64   `json:"atMs"`
			Record *Record `json:"record"`
			Usable bool    `json:"usable"`
		} `json:"steps"`
		Cooling      []Cooling `json:"cooling"`
		CoolingOther []Cooling `json:"coolingOther"`
	} `json:"health"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "v1.json"))
	if err != nil {
		t.Fatalf("read vectors (run `node scripts/dev/gen-vectors.mjs`): %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(v.Health.Steps) == 0 {
		t.Fatal("the vectors carry no health timeline (regenerate them)")
	}
	return v
}

func TestTimelineMatchesNodePolicy(t *testing.T) {
	v := loadVectors(t)
	clock := v.Health.Steps[0].AtMs
	h := New(func() time.Time { return time.UnixMilli(clock) })

	for i, step := range v.Health.Steps {
		clock = step.AtMs
		switch step.Op {
		case "fail":
			got := h.Fail(step.Exit, step.Plane)
			if step.Record == nil {
				t.Fatalf("step %d: the vectors expect no record", i)
			}
			if got != *step.Record {
				t.Errorf("step %d (%s %s/%s): got %+v, want %+v", i, step.Op, step.Exit, step.Plane, got, *step.Record)
			}
		case "ok":
			h.Ok(step.Exit, step.Plane)
		default:
			t.Fatalf("step %d: unknown op %q", i, step.Op)
		}
		if got := h.Usable(step.Exit, step.Plane); got != step.Usable {
			t.Errorf("step %d (%s %s/%s): usable=%v, want %v", i, step.Op, step.Exit, step.Plane, got, step.Usable)
		}
	}

	if got := h.Cooling("nl-1"); !sameCooling(got, v.Health.Cooling) {
		t.Errorf("cooling(nl-1): got %+v, want %+v", got, v.Health.Cooling)
	}
	if got := h.Cooling("fi-1"); !sameCooling(got, v.Health.CoolingOther) {
		t.Errorf("cooling(fi-1): got %+v, want %+v", got, v.Health.CoolingOther)
	}
}

func sameCooling(got, want []Cooling) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func TestBackoffEscalatesAndStopsGrowing(t *testing.T) {
	cases := map[int]int64{0: 30_000, 1: 30_000, 2: 120_000, 3: 600_000, 9: 600_000}
	for fails, want := range cases {
		if got := NextBackoff(fails); got != want {
			t.Errorf("NextBackoff(%d)=%d, want %d", fails, got, want)
		}
	}
	if len(BackoffMs) != 3 {
		t.Errorf("the vector file and the policy assume three steps, got %d", len(BackoffMs))
	}
}

func TestPlanesAndNodesAreIndependent(t *testing.T) {
	clock := int64(1_000_000)
	h := New(func() time.Time { return time.UnixMilli(clock) })

	h.Fail("nl-1", "reality")
	h.Fail("nl-1", "reality")
	if h.Usable("nl-1", "reality") {
		t.Error("a failed plane must be paused")
	}
	if !h.Usable("nl-1", "hy2") {
		t.Error("another plane of the same node must stay usable")
	}
	if !h.Usable("fi-1", "reality") {
		t.Error("another node must stay usable")
	}

	clock += BackoffMs[1] + 1
	if !h.Usable("nl-1", "reality") {
		t.Error("after the pause the plane must be tried again")
	}
	if len(h.Cooling("nl-1")) != 0 {
		t.Error("an expired pause must not be reported as cooling")
	}

	h.Ok("nl-1", "reality")
	if !h.Usable("nl-1", "reality") {
		t.Error("a success must leave the plane usable")
	}
	if got := h.Fail("nl-1", "reality"); got.Fails != 1 {
		t.Errorf("a success must reset the escalation, got fails=%d", got.Fails)
	}
}
