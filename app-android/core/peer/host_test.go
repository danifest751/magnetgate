package peer

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestMobileGuestTokenRejectsStoppedAndSupersededWorkers(t *testing.T) {
	h := &Host{ctx: context.Background()}
	h.ActivateGuest("old")
	h.Disconnect()
	if _, err := h.Connect("FI", 0, "old"); !errors.Is(err, context.Canceled) {
		t.Fatal("stopped worker admitted", err)
	}
	h.ActivateGuest("new")
	if _, err := h.Connect("FI", 0, "old"); !errors.Is(err, context.Canceled) {
		t.Fatal("superseded worker admitted", err)
	}
	if _, err := h.Connect("FI", 0, ""); !errors.Is(err, context.Canceled) {
		t.Fatal("empty token admitted", err)
	}
	if _, err := h.Connect("FI", 0, "new"); err == nil || errors.Is(err, context.Canceled) {
		t.Fatal("current token did not reach configuration check", err)
	}
}

func TestDisconnectCancelsPendingConnectBeforeTakingGuestLock(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	h := &Host{ctx: context.Background(), opCancel: cancel}
	h.mu.Lock()
	done := make(chan struct{})
	go func() { h.Disconnect(); close(done) }()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		h.mu.Unlock()
		t.Fatal("Disconnect waited for Connect without cancelling it")
	}
	h.mu.Unlock()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Disconnect did not finish")
	}
}
