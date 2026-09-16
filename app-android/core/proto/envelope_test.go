package proto

import (
	"bytes"
	"testing"
)

// Round-trip and rejection behaviour of the envelope. The cross-implementation half (Node opens what
// Go sealed and vice versa) lives in scripts/dev/verify-vectors.mjs, because a nonce is random.

func TestSealUnsealRoundTrip(t *testing.T) {
	keys, err := DeriveKeys("envelope-test-psk")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	for _, domain := range []string{"12345", "n12345", "0:12345", ""} {
		plain := []byte(`{"v":3,"ts":1789000000000,"slot":0,"node":"nl-1","dp":[]}`)
		env, err := Seal(&keys.BoxKey, plain, domain)
		if err != nil {
			t.Fatalf("seal(%q): %v", domain, err)
		}
		if env[0] != EnvelopeVersion {
			t.Errorf("envelope version byte is %d", env[0])
		}
		got := Unseal(&keys.BoxKey, env, domain)
		if !bytes.Equal(got, plain) {
			t.Errorf("domain %q: round trip mismatch\n got %q\nwant %q", domain, got, plain)
		}
	}
}

func TestUnsealRejectsWhatItMust(t *testing.T) {
	keys, err := DeriveKeys("envelope-test-psk")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	other, err := DeriveKeys("a-different-psk")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	plain := []byte("payload")
	env, err := Seal(&keys.BoxKey, plain, "7")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	if Unseal(&other.BoxKey, env, "7") != nil {
		t.Error("another PSK's key must not open the envelope")
	}
	if Unseal(&keys.BoxKey, env, "8") != nil {
		t.Error("a different domain must be rejected (the domain is authenticated)")
	}
	tampered := append([]byte(nil), env...)
	tampered[len(tampered)-1] ^= 0x01
	if Unseal(&keys.BoxKey, tampered, "7") != nil {
		t.Error("a tampered envelope must be rejected")
	}
	for _, cut := range [][]byte{nil, []byte{EnvelopeVersion}, env[:MinEnvelope-1], env[:1+24]} {
		if Unseal(&keys.BoxKey, cut, "7") != nil {
			t.Errorf("truncated envelope of %d bytes must be rejected", len(cut))
		}
	}
	badVersion := append([]byte(nil), env...)
	badVersion[0] = 3
	if Unseal(&keys.BoxKey, badVersion, "7") != nil {
		t.Error("a foreign envelope version must be rejected")
	}
	oversized := make([]byte, MaxEnvelope+1)
	copy(oversized, env)
	if Unseal(&keys.BoxKey, oversized, "7") != nil {
		t.Error("an oversized envelope must be rejected")
	}
}

func TestSealRejectsAnOverlongDomain(t *testing.T) {
	keys, err := DeriveKeys("envelope-test-psk")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	long := make([]byte, MaxSealDomain+1)
	for i := range long {
		long[i] = 'x'
	}
	if _, err := Seal(&keys.BoxKey, []byte("x"), string(long)); err == nil {
		t.Error("a domain longer than MaxSealDomain must be refused")
	}
	exact := make([]byte, MaxSealDomain)
	for i := range exact {
		exact[i] = 'x'
	}
	if _, err := Seal(&keys.BoxKey, []byte("x"), string(exact)); err != nil {
		t.Errorf("a domain of exactly MaxSealDomain must be accepted: %v", err)
	}
}

// A record sealed for one slot must not be readable with another slot's key: that is what makes a
// compromised node unable to forge a neighbour's offer.
func TestSlotKeysDoNotOpenEachOther(t *testing.T) {
	psk := "slot-binding-test-psk"
	box0, err := SlotBoxKey(psk, 0)
	if err != nil {
		t.Fatalf("slot 0: %v", err)
	}
	box1, err := SlotBoxKey(psk, 1)
	if err != nil {
		t.Fatalf("slot 1: %v", err)
	}
	env, err := Seal(&box0, []byte("slot 0 offer"), "0:42")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if Unseal(&box1, env, "0:42") != nil {
		t.Error("slot 1's key must not open slot 0's record")
	}
	if got := Unseal(&box0, env, "0:42"); string(got) != "slot 0 offer" {
		t.Errorf("slot 0's own key must open it, got %q", got)
	}
}
