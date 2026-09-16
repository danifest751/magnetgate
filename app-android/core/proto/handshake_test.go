package proto

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"testing"
	"time"
)

// The handshake is checked against a recorded Node transcript (see gen-vectors.mjs): the random parts
// are baked into the bytes, the derived session keys are not. So both roles are pinned to the exact
// message layout and KDF without depending on a clock or on luck.

func handshakeFromVectors(t *testing.T) (vectors, *[32]byte, []byte, []byte, [32]byte, [32]byte, SessionKeys) {
	t.Helper()
	v := loadVectors(t)
	keys, err := DeriveKeys(v.Psk)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	msg1, err := hex.DecodeString(v.Handshake.Msg1)
	if err != nil {
		t.Fatalf("msg1 hex: %v", err)
	}
	msg2, err := hex.DecodeString(v.Handshake.Msg2)
	if err != nil {
		t.Fatalf("msg2 hex: %v", err)
	}
	var cePk, ceSk [32]byte
	var want SessionKeys
	sk, err := hex.DecodeString(v.Handshake.CeSk)
	if err != nil {
		t.Fatalf("ceSk hex: %v", err)
	}
	copy(ceSk[:], sk)
	pk, err := hex.DecodeString(v.Handshake.CePk)
	if err != nil {
		t.Fatalf("cePk hex: %v", err)
	}
	copy(cePk[:], pk)
	c2e, _ := hex.DecodeString(v.Handshake.C2E)
	e2c, _ := hex.DecodeString(v.Handshake.E2C)
	copy(want.C2E[:], c2e)
	copy(want.E2C[:], e2c)
	return v, &keys.BoxKey, msg1, msg2, cePk, ceSk, want
}

func TestHandshakeConstantsMatchTheVectors(t *testing.T) {
	v, _, msg1, msg2, _, _, _ := handshakeFromVectors(t)
	if HSMsg1Len != v.Constants.HsMsg1Len || HSMsg2Len != v.Constants.HsMsg2Len {
		t.Errorf("message lengths drift: code %d/%d, vectors %d/%d",
			HSMsg1Len, HSMsg2Len, v.Constants.HsMsg1Len, v.Constants.HsMsg2Len)
	}
	if len(msg1) != HSMsg1Len || len(msg2) != HSMsg2Len {
		t.Errorf("recorded transcript has %d/%d bytes, want %d/%d", len(msg1), len(msg2), HSMsg1Len, HSMsg2Len)
	}
	if HSTimestampSkew.Milliseconds() != int64(v.Constants.HsTimestampSkewMs) {
		t.Errorf("skew drift: code %d ms, vectors %d ms",
			HSTimestampSkew.Milliseconds(), v.Constants.HsTimestampSkewMs)
	}
}

// Client role: derive the session keys from the recorded exit reply.
func TestHandshakeClientFinishMatchesNode(t *testing.T) {
	_, boxKey, _, msg2, cePk, ceSk, want := handshakeFromVectors(t)
	got, err := ClientFinish(boxKey, msg2, Ephemeral{Sk: ceSk, Pk: cePk})
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	if got != want {
		t.Errorf("session keys mismatch\n got c2e %x e2c %x\nwant c2e %x e2c %x",
			got.C2E, got.E2C, want.C2E, want.E2C)
	}
}

// Exit role: accept the recorded client message, and (since the exit picks a fresh ephemeral each
// time) prove the invariant that matters — both sides end up with the same session keys. Whether the
// Node client agrees with our reply is checked by scripts/dev/verify-vectors.mjs.
func TestHandshakeExitRespondIsSelfConsistent(t *testing.T) {
	_, boxKey, msg1, _, _, ceSk, transcriptKeys := handshakeFromVectors(t)

	plain, err := openHS(boxKey, msg1, HSMsg1Len)
	if err != nil {
		t.Fatalf("open msg1: %v", err)
	}
	// the timestamp lives inside msg1; drive the response with it so the vector never goes stale
	ts := time.UnixMilli(int64(binary.BigEndian.Uint64(plain[32:40])))

	reply, exitKeys, cePk, err := ExitRespond(boxKey, msg1, ts)
	if err != nil {
		t.Fatalf("respond: %v", err)
	}
	if len(reply) != HSMsg2Len {
		t.Fatalf("reply is %d bytes, want %d", len(reply), HSMsg2Len)
	}
	if !bytes.Equal(cePk[:], plain[0:32]) {
		t.Error("the reply must be built for the client key from msg1")
	}

	// the invariant that matters: the client that sent msg1 must reach exactly the exit's keys
	clientKeys, err := ClientFinish(boxKey, reply, Ephemeral{Sk: ceSk, Pk: cePk})
	if err != nil {
		t.Fatalf("client finish of our own reply: %v", err)
	}
	if clientKeys != exitKeys {
		t.Errorf("the two sides disagree\n exit   c2e %x e2c %x\n client c2e %x e2c %x",
			exitKeys.C2E, exitKeys.E2C, clientKeys.C2E, clientKeys.E2C)
	}

	// and the recorded transcript is a different handshake, so its keys must differ
	if exitKeys == transcriptKeys {
		t.Error("a fresh ephemeral must not reproduce the recorded session keys")
	}
}

func TestHandshakeRejections(t *testing.T) {
	v, boxKey, msg1, msg2, cePk, ceSk, _ := handshakeFromVectors(t)
	other, err := DeriveKeys("a-different-handshake-psk")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	plain, err := openHS(boxKey, msg1, HSMsg1Len)
	if err != nil {
		t.Fatalf("open msg1: %v", err)
	}
	ts := time.UnixMilli(int64(binary.BigEndian.Uint64(plain[32:40])))

	t.Run("stale timestamp", func(t *testing.T) {
		if _, _, _, err := ExitRespond(boxKey, msg1, ts.Add(2*HSTimestampSkew)); !errors.Is(err, ErrHandshake) {
			t.Errorf("a stale handshake must be refused, got %v", err)
		}
		if _, _, _, err := ExitRespond(boxKey, msg1, ts.Add(-2*HSTimestampSkew)); !errors.Is(err, ErrHandshake) {
			t.Errorf("a handshake from the future must be refused, got %v", err)
		}
		if _, _, _, err := ExitRespond(boxKey, msg1, ts.Add(HSTimestampSkew/2)); err != nil {
			t.Errorf("a handshake inside the window must be accepted, got %v", err)
		}
	})

	t.Run("foreign PSK", func(t *testing.T) {
		if _, _, _, err := ExitRespond(&other.BoxKey, msg1, ts); !errors.Is(err, ErrHandshake) {
			t.Error("another PSK must not complete a handshake")
		}
		if _, err := ClientFinish(&other.BoxKey, msg2, Ephemeral{Sk: ceSk, Pk: cePk}); !errors.Is(err, ErrHandshake) {
			t.Error("another PSK must not open the exit reply")
		}
	})

	t.Run("tampered messages", func(t *testing.T) {
		bad1 := append([]byte(nil), msg1...)
		bad1[len(bad1)-1] ^= 0x01
		if _, _, _, err := ExitRespond(boxKey, bad1, ts); !errors.Is(err, ErrHandshake) {
			t.Error("a tampered msg1 must be refused")
		}
		bad2 := append([]byte(nil), msg2...)
		bad2[30] ^= 0x01
		if _, err := ClientFinish(boxKey, bad2, Ephemeral{Sk: ceSk, Pk: cePk}); !errors.Is(err, ErrHandshake) {
			t.Error("a tampered msg2 must be refused")
		}
	})

	t.Run("wrong lengths", func(t *testing.T) {
		for _, cut := range [][]byte{nil, msg1[:HSMsg1Len-1], append(append([]byte(nil), msg1...), 0)} {
			if _, _, _, err := ExitRespond(boxKey, cut, ts); !errors.Is(err, ErrHandshake) {
				t.Errorf("msg1 of %d bytes must be refused", len(cut))
			}
		}
		if _, err := ClientFinish(boxKey, msg2[:HSMsg2Len-1], Ephemeral{Sk: ceSk, Pk: cePk}); !errors.Is(err, ErrHandshake) {
			t.Error("a truncated msg2 must be refused")
		}
	})

	t.Run("reply for another client key", func(t *testing.T) {
		// a correctly sealed reply that echoes somebody else's public key
		reply := make([]byte, 65)
		var someone [32]byte
		someone[0] = 9
		copy(reply[0:32], someone[:])
		copy(reply[32:64], someone[:])
		reply[64] = HandshakeVersion
		forged, err := sealHS(boxKey, reply)
		if err != nil {
			t.Fatalf("seal: %v", err)
		}
		if _, err := ClientFinish(boxKey, forged, Ephemeral{Sk: ceSk, Pk: cePk}); !errors.Is(err, ErrHandshake) {
			t.Error("a reply that does not echo our ephemeral key must be refused")
		}
	})

	t.Run("low order client key", func(t *testing.T) {
		body := make([]byte, 41)
		// an all-zero public key is a low-order point: the shared secret would be zero
		binary.BigEndian.PutUint64(body[32:40], uint64(ts.UnixMilli()))
		body[40] = HandshakeVersion
		msg, err := sealHS(boxKey, body)
		if err != nil {
			t.Fatalf("seal: %v", err)
		}
		if _, _, _, err := ExitRespond(boxKey, msg, ts); !errors.Is(err, ErrHandshake) {
			t.Error("a low-order client key must be refused instead of producing a zero shared secret")
		}
	})

	t.Run("foreign version inside msg1", func(t *testing.T) {
		body := append([]byte(nil), plain...)
		body[40] = 3
		msg, err := sealHS(boxKey, body)
		if err != nil {
			t.Fatalf("seal: %v", err)
		}
		if _, _, _, err := ExitRespond(boxKey, msg, ts); !errors.Is(err, ErrHandshake) {
			t.Error("a foreign handshake version must be refused")
		}
	})

	_ = v
}
