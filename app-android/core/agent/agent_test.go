package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"magnetgate/core/proto"
)

// fakeChannel answers polls from a table keyed by salt, so the loop can be driven without a network.
type fakeChannel struct {
	mu      sync.Mutex
	answers map[string]fakeAnswer
}

type fakeAnswer struct {
	value []byte
	seq   int64
	err   error
}

func newFakeChannel() *fakeChannel { return &fakeChannel{answers: map[string]fakeAnswer{}} }

func (f *fakeChannel) put(t *testing.T, psk string, slot int, seq int64, doc map[string]any) {
	t.Helper()
	salt, err := proto.SlotSalt(psk, slot)
	if err != nil {
		t.Fatalf("salt: %v", err)
	}
	key, err := proto.SlotBoxKey(psk, slot)
	if err != nil {
		t.Fatalf("box key: %v", err)
	}
	plain, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	sealed, err := proto.Seal(&key, plain, strconv.FormatInt(seq, 10))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers[string(salt)] = fakeAnswer{value: sealed, seq: seq}
}

func (f *fakeChannel) fail(psk string, slot int, err error) {
	salt, _ := proto.SlotSalt(psk, slot)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers[string(salt)] = fakeAnswer{err: err}
}

func (f *fakeChannel) Get(_ context.Context, _ [32]byte, salt []byte) ([]byte, int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	answer, ok := f.answers[string(salt)]
	if !ok {
		return nil, 0, errors.New("nothing published")
	}
	return answer.value, answer.seq, answer.err
}

const testPSK = "agent-test-psk-0123456789abcdef"

func offerDoc(slot int, node string, peers []map[string]any, port int) map[string]any {
	doc := map[string]any{
		"v":    3,
		"ts":   time.Now().UnixMilli(),
		"slot": slot,
		"node": node,
		"dp":   []map[string]any{{"t": "mgt", "protocol": 4, "host": "127.0.0.1", "port": port}},
	}
	if peers != nil {
		doc["peers"] = peers
	}
	return doc
}

// offerDocAt is offerDoc with a chosen generation timestamp.
func offerDocAt(ts int64, slot int, node string, port int) map[string]any {
	doc := offerDoc(slot, node, nil, port)
	doc["ts"] = ts
	return doc
}

func newTestAgent(t *testing.T, channel Getter, slots ...int) *Agent {
	t.Helper()
	a, err := New(Config{PSK: testPSK, Slots: slots, Getter: channel})
	if err != nil {
		t.Fatalf("agent: %v", err)
	}
	return a
}

func TestPollRecordsTheOfferAndItsEndpoint(t *testing.T) {
	channel := newFakeChannel()
	channel.put(t, testPSK, 0, 1, offerDoc(0, "lab-a", nil, 29601))
	a := newTestAgent(t, channel, 0)

	record, err := a.Poll(context.Background(), 0)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if record.Node != "lab-a" || record.Seq != 1 {
		t.Fatalf("record: %+v", record)
	}
	endpoints := a.Endpoints()
	if len(endpoints) != 1 || endpoints[0].Host != "127.0.0.1" || endpoints[0].Port != 29601 || endpoints[0].Slot != 0 {
		t.Fatalf("endpoints: %+v", endpoints)
	}
}

// A node that knows the PSK can tell us about the other slots; that is how one configured slot becomes
// a whole set of nodes.
func TestPeerSlotsAreLearnedAndThenPolled(t *testing.T) {
	channel := newFakeChannel()
	channel.put(t, testPSK, 0, 5, offerDoc(0, "lab-a", []map[string]any{{"slot": 1, "ts": 1}}, 29601))
	channel.put(t, testPSK, 1, 7, offerDoc(1, "lab-b", nil, 29602))
	a := newTestAgent(t, channel, 0)

	if _, err := a.Poll(context.Background(), 0); err != nil {
		t.Fatalf("poll 0: %v", err)
	}
	if got := a.Slots(); len(got) != 2 || got[0] != 0 || got[1] != 1 {
		t.Fatalf("slots after learning: %v", got)
	}
	a.PollOnce(context.Background(), nil)
	endpoints := a.Endpoints()
	if len(endpoints) != 2 || endpoints[1].Port != 29602 {
		t.Fatalf("endpoints: %+v", endpoints)
	}
}

// Run is how an app keeps its view current: it polls until the context ends, at the fast interval while
// something is missing and the slow one afterwards.
func TestRunKeepsPollingUntilTheContextEnds(t *testing.T) {
	channel := newFakeChannel()
	channel.put(t, testPSK, 0, 1, offerDoc(0, "lab-a", nil, 29601))
	a, err := New(Config{PSK: testPSK, Slots: []int{0}, Getter: channel, Fast: time.Millisecond, Slow: time.Millisecond})
	if err != nil {
		t.Fatalf("agent: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	var polls int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.Run(ctx, func(*Record) { atomic.AddInt32(&polls, 1) })
	}()

	deadline := time.Now().Add(3 * time.Second)
	for atomic.LoadInt32(&polls) < 3 {
		if time.Now().After(deadline) {
			t.Fatalf("Run stopped polling after %d poll(s)", atomic.LoadInt32(&polls))
		}
		time.Sleep(2 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop when the context ended")
	}
}

// A null or missing slot in `peers` is skipped, never read as slot 0: silently opting into slot 0 is
// exactly the default the strict parse exists to prevent.
func TestNullPeerSlotIsNotReadAsSlotZero(t *testing.T) {
	channel := newFakeChannel()
	channel.put(t, testPSK, 0, 1, offerDoc(0, "lab-a", []map[string]any{{"slot": nil, "ts": 1}, {"ts": 2}}, 29601))
	a := newTestAgent(t, channel, 0)

	if _, err := a.Poll(context.Background(), 0); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if got := a.Slots(); len(got) != 1 || got[0] != 0 {
		t.Fatalf("a null slot must not be learned, got %v", got)
	}
}

// The sequence is the envelope's domain: a record served under a different sequence must not unseal.
func TestRecordSealedForAnotherSequenceIsRefused(t *testing.T) {
	channel := newFakeChannel()
	channel.put(t, testPSK, 0, 1, offerDoc(0, "lab-a", nil, 29601))
	channel.mu.Lock()
	salt, _ := proto.SlotSalt(testPSK, 0)
	answer := channel.answers[string(salt)]
	answer.seq = 9
	channel.answers[string(salt)] = answer
	channel.mu.Unlock()
	a := newTestAgent(t, channel, 0)

	if _, err := a.Poll(context.Background(), 0); err == nil {
		t.Fatal("an envelope from another generation must not be accepted")
	}
}

func TestNotPublishedIsASpecificError(t *testing.T) {
	channel := newFakeChannel()
	channel.fail(testPSK, 0, errors.New("no offer"))
	a := newTestAgent(t, channel, 0)

	if _, err := a.Poll(context.Background(), 0); !errors.Is(err, ErrNotPublished) {
		t.Fatalf("expected ErrNotPublished, got %v", err)
	}
}

func TestGarbageAtTheTargetIsRefused(t *testing.T) {
	channel := newFakeChannel()
	salt, _ := proto.SlotSalt(testPSK, 0)
	channel.mu.Lock()
	channel.answers[string(salt)] = fakeAnswer{value: []byte("not an envelope"), seq: 1}
	channel.mu.Unlock()
	a := newTestAgent(t, channel, 0)

	if _, err := a.Poll(context.Background(), 0); err == nil {
		t.Fatal("garbage must not be accepted")
	}
}

// A node that stops publishing must stop being an endpoint once its record ages out.
func TestStaleRecordsAreNotEndpoints(t *testing.T) {
	channel := newFakeChannel()
	channel.put(t, testPSK, 0, 1, offerDoc(0, "lab-a", nil, 29601))
	now := time.Now()
	a, err := New(Config{PSK: testPSK, Slots: []int{0}, Getter: channel, Fresh: time.Minute, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("agent: %v", err)
	}
	if _, err := a.Poll(context.Background(), 0); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(a.Endpoints()) != 1 {
		t.Fatal("a fresh record must be an endpoint")
	}
	now = now.Add(2 * time.Minute)
	if got := a.Endpoints(); len(got) != 0 {
		t.Fatalf("a stale record must not be used, got %+v", got)
	}
	if len(a.Records()) != 1 {
		t.Fatal("the record itself is still known, only its use is refused")
	}
}

// A correctly signed record can still be a replay of a generation whose node is gone. Only the offer's
// own timestamp separates the two, and the Node client refuses the same window.
func TestReplayedStaleOffersAreRefused(t *testing.T) {
	channel := newFakeChannel()
	stale := time.Now().Add(-time.Hour).UnixMilli()
	channel.put(t, testPSK, 0, 9, offerDocAt(stale, 0, "lab-a", 29601))
	a := newTestAgent(t, channel, 0)

	if _, err := a.Poll(context.Background(), 0); err == nil {
		t.Fatal("an offer older than the freshness window must be refused")
	}
	if len(a.Endpoints()) != 0 {
		t.Fatal("a replayed offer must not become an endpoint")
	}
	if len(a.Records()) != 0 {
		t.Fatal("a replayed offer must not be recorded")
	}
}

// A node whose clock runs a little ahead is tolerated, one that is minutes ahead is not.
func TestOffersFromTheFutureAreRefusedBeyondTheSkew(t *testing.T) {
	channel := newFakeChannel()
	nearFuture := time.Now().Add(30 * time.Second).UnixMilli()
	channel.put(t, testPSK, 0, 1, offerDocAt(nearFuture, 0, "lab-a", 29601))
	a := newTestAgent(t, channel, 0)
	if _, err := a.Poll(context.Background(), 0); err != nil {
		t.Fatalf("a slightly ahead clock must be tolerated, got %v", err)
	}

	far := newFakeChannel()
	farFuture := time.Now().Add(10 * time.Minute).UnixMilli()
	far.put(t, testPSK, 0, 1, offerDocAt(farFuture, 0, "lab-a", 29601))
	b := newTestAgent(t, far, 0)
	if _, err := b.Poll(context.Background(), 0); err == nil {
		t.Fatal("an offer dated minutes in the future must be refused")
	}
}

func TestInvalidSlotIsRefused(t *testing.T) {
	a := newTestAgent(t, newFakeChannel(), 0)
	if _, err := a.Poll(context.Background(), proto.MaxSlots); err == nil {
		t.Fatal("a slot out of range must be refused")
	}
	if _, err := New(Config{PSK: testPSK, Slots: []int{-1}, Getter: newFakeChannel()}); err == nil {
		t.Fatal("a negative slot must be refused at construction")
	}
}

func TestNewNeedsAChannelAndAPSK(t *testing.T) {
	if _, err := New(Config{PSK: testPSK}); err == nil {
		t.Fatal("an agent without a channel must not start")
	}
	if _, err := New(Config{Getter: newFakeChannel()}); err == nil {
		t.Fatal("an agent without a PSK must not start")
	}
}
