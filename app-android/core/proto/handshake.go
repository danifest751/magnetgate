package proto

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"time"

	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/nacl/secretbox"
)

// Forward-secret session handshake, protocol v4 (mirrors hsClientInit / hsExitRespond /
// hsClientFinish in src/common.mjs):
//
//	msg1: nonce(24) || secretbox(cePk(32) || tsMillis(8 BE) || version(1))
//	msg2: nonce(24) || secretbox(eePk(32) || cePk(32) || version(1))
//	keys: BLAKE2b-512("magnetgate-session-v4" || dh || cePk || eePk || boxKey) → c2e | e2c
//
// Both messages are authenticated and encrypted under the PSK-derived box key, so only a peer that
// holds the PSK can complete a handshake, and the timestamp plus a caller-side cache of `cePk` (the
// exit does that; a client does not need to) rejects replays. The ephemeral secrets are dropped after
// the handshake, so a later PSK compromise does not reveal past session keys.
const (
	HandshakeVersion = 4
	// HSTimestampSkew is how far the two clocks may differ.
	HSTimestampSkew = 60 * time.Second
	// HSMsg1Len and HSMsg2Len are exact: the peer rejects anything else.
	HSMsg1Len = 24 + 41 + 16
	HSMsg2Len = 24 + 65 + 16
)

var ErrHandshake = errors.New("handshake rejected")

// SessionKeys are the two directional secretbox keys of a session.
type SessionKeys struct {
	C2E [32]byte // client → exit
	E2C [32]byte // exit → client
}

// Ephemeral is one side's X25519 keypair. The secret must be dropped once the handshake completes.
type Ephemeral struct {
	Sk [32]byte
	Pk [32]byte
}

func newEphemeral() (Ephemeral, error) {
	var eph Ephemeral
	if _, err := rand.Read(eph.Sk[:]); err != nil {
		return eph, err
	}
	// Go and libsodium clamp the scalar identically, so the shared secret matches the Node side.
	pk, err := curve25519.X25519(eph.Sk[:], curve25519.Basepoint)
	if err != nil {
		return eph, err
	}
	copy(eph.Pk[:], pk)
	return eph, nil
}

func sessionKeys(dh []byte, cePk, eePk [32]byte, boxKey *[32]byte) (SessionKeys, error) {
	var keys SessionKeys
	h, err := blake2b.New512(nil)
	if err != nil {
		return keys, err
	}
	for _, part := range [][]byte{[]byte("magnetgate-session-v4"), dh, cePk[:], eePk[:], boxKey[:]} {
		if _, err := h.Write(part); err != nil {
			return keys, err
		}
	}
	sum := h.Sum(nil)
	copy(keys.C2E[:], sum[0:32])
	copy(keys.E2C[:], sum[32:64])
	return keys, nil
}

func sealHS(boxKey *[32]byte, plain []byte) ([]byte, error) {
	var nonce [24]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	out := make([]byte, 0, 24+len(plain)+secretbox.Overhead)
	out = append(out, nonce[:]...)
	return secretbox.Seal(out, plain, &nonce, boxKey), nil
}

func openHS(boxKey *[32]byte, msg []byte, wantLen int) ([]byte, error) {
	if len(msg) != wantLen {
		return nil, ErrHandshake
	}
	var nonce [24]byte
	copy(nonce[:], msg[0:24])
	plain, ok := secretbox.Open(nil, msg[24:], &nonce, boxKey)
	if !ok {
		return nil, ErrHandshake
	}
	return plain, nil
}

// ClientInit builds msg1 and returns the ephemeral secret the caller must keep for ClientFinish.
func ClientInit(boxKey *[32]byte, now time.Time) (msg1 []byte, eph Ephemeral, err error) {
	eph, err = newEphemeral()
	if err != nil {
		return nil, eph, err
	}
	plain := make([]byte, 41)
	copy(plain[0:32], eph.Pk[:])
	binary.BigEndian.PutUint64(plain[32:40], uint64(now.UnixMilli()))
	plain[40] = HandshakeVersion
	msg1, err = sealHS(boxKey, plain)
	return msg1, eph, err
}

// ExitRespond is the exit side: it authenticates msg1, checks the clock, derives the session keys and
// builds the reply. The reply binds the client's ephemeral public key, so it cannot be replayed into a
// different handshake.
func ExitRespond(boxKey *[32]byte, msg1 []byte, now time.Time) (msg2 []byte, keys SessionKeys, cePk [32]byte, err error) {
	plain, err := openHS(boxKey, msg1, HSMsg1Len)
	if err != nil {
		return nil, keys, cePk, err
	}
	if plain[40] != HandshakeVersion {
		return nil, keys, cePk, ErrHandshake
	}
	copy(cePk[:], plain[0:32])
	ts := binary.BigEndian.Uint64(plain[32:40])
	skew := now.UnixMilli() - int64(ts)
	if skew < 0 {
		skew = -skew
	}
	if skew > HSTimestampSkew.Milliseconds() {
		return nil, keys, cePk, ErrHandshake
	}
	ee, err := newEphemeral()
	if err != nil {
		return nil, keys, cePk, err
	}
	dh, err := curve25519.X25519(ee.Sk[:], cePk[:])
	if err != nil {
		// a low-order point: the client is lying or broken
		return nil, keys, cePk, ErrHandshake
	}
	keys, err = sessionKeys(dh, cePk, ee.Pk, boxKey)
	if err != nil {
		return nil, keys, cePk, err
	}
	reply := make([]byte, 65)
	copy(reply[0:32], ee.Pk[:])
	copy(reply[32:64], cePk[:])
	reply[64] = HandshakeVersion
	msg2, err = sealHS(boxKey, reply)
	return msg2, keys, cePk, err
}

// ClientFinish verifies the exit's reply and derives the same session keys.
func ClientFinish(boxKey *[32]byte, msg2 []byte, eph Ephemeral) (SessionKeys, error) {
	var keys SessionKeys
	reply, err := openHS(boxKey, msg2, HSMsg2Len)
	if err != nil {
		return keys, err
	}
	if reply[64] != HandshakeVersion {
		return keys, ErrHandshake
	}
	// the reply must name the key we actually sent, otherwise it belongs to another handshake
	var echoed [32]byte
	copy(echoed[:], reply[32:64])
	if echoed != eph.Pk {
		return keys, ErrHandshake
	}
	var eePk [32]byte
	copy(eePk[:], reply[0:32])
	dh, err := curve25519.X25519(eph.Sk[:], eePk[:])
	if err != nil {
		return keys, ErrHandshake
	}
	return sessionKeys(dh, eph.Pk, eePk, boxKey)
}
