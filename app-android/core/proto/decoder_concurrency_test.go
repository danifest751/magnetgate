package proto

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestDecoderKillDuringFrameCallback(t *testing.T) {
	key := testKey(t)
	encoder := NewFrameEncoder(key)
	first, err := encoder.Encode(FrameData, 1, []byte("first"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := encoder.Encode(FrameData, 1, []byte("must be discarded"))
	if err != nil {
		t.Fatal(err)
	}
	entered, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var frames, kills atomic.Int32
	var dec *Decoder
	dec = NewDecoder(key, func(Frame) {
		frames.Add(1)
		close(entered)
		<-release
	}, func() { kills.Add(1); dec.Kill() }) // teardown is re-entrant
	go func() { dec.Push(append(first, second...)); close(finished) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("decoder did not deliver first frame")
	}
	killed := make(chan struct{})
	go func() { dec.Kill(); close(killed) }()
	select {
	case <-killed:
	case <-time.After(time.Second):
		close(release)
		t.Fatal("Kill waited for a frame callback")
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("Push did not stop after Kill")
	}
	dec.Push(second)
	if !dec.Killed() || frames.Load() != 1 || kills.Load() != 1 || dec.buffer != nil {
		t.Fatal("teardown must discard pending frames, clear memory and notify once")
	}
}

func TestDecoderFrameCallbackCanKill(t *testing.T) {
	key := testKey(t)
	wire, err := EncodeFrame(key, FrameOpen, 1, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var dec *Decoder
	dec = NewDecoder(key, func(Frame) { dec.Kill() }, func() { dec.Kill() })
	done := make(chan struct{})
	go func() { dec.Push(wire); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("synchronous callback teardown deadlocked")
	}
	if !dec.Killed() {
		t.Fatal("callback did not kill decoder")
	}
}
