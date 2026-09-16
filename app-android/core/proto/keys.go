// Package proto is the Android core's port of src/common.mjs. It must be byte-compatible with the
// Node client and the exits: the same PSK has to produce the same keys, the same rendezvous target and
// envelopes the other side can open. tests/dev vectors (scripts/dev/gen-vectors.mjs +
// scripts/dev/verify-vectors.mjs) check that in both directions.
package proto

import (
	"crypto/ed25519"
	"crypto/sha1"
	"crypto/sha512"
	"errors"
	"fmt"

	"golang.org/x/crypto/blake2b"
)

// MaxSlots mirrors MAX_SLOTS in src/common.mjs (a drift test keeps them equal on the JS side).
const MaxSlots = 16

// Keys is what deriveKeys returns: the BEP44 signing pair and the secretbox key for offers/sessions.
type Keys struct {
	Pk     [32]byte
	Sk     ed25519.PrivateKey
	BoxKey [32]byte
}

// DeriveKeys mirrors deriveKeys() in src/common.mjs: the ed25519 seed is the first half of
// SHA-512("mgt-sig:" + secret), and the box key is BLAKE2b-256("mgt-box:" + secret).
func DeriveKeys(secret string) (Keys, error) {
	var k Keys
	sum := sha512.Sum512([]byte("mgt-sig:" + secret))
	k.Sk = ed25519.NewKeyFromSeed(sum[:32])
	copy(k.Pk[:], k.Sk.Public().(ed25519.PublicKey))

	box, err := blake2b.New256(nil)
	if err != nil {
		return Keys{}, fmt.Errorf("blake2b: %w", err)
	}
	if _, err := box.Write([]byte("mgt-box:" + secret)); err != nil {
		return Keys{}, fmt.Errorf("blake2b: %w", err)
	}
	copy(k.BoxKey[:], box.Sum(nil))
	return k, nil
}

// SaltOf mirrors saltOf(): SHA1("mgt-salt:" + secret).
func SaltOf(secret string) []byte {
	sum := sha1.Sum([]byte("mgt-salt:" + secret))
	return sum[:]
}

// ValidSlot mirrors asSlot(): an integer in [0, MaxSlots).
func ValidSlot(slot int) error {
	if slot < 0 || slot >= MaxSlots {
		return fmt.Errorf("invalid node slot: %d", slot)
	}
	return nil
}

// SlotSalt mirrors slotSalt(): slot 0 is exactly the single-node salt, higher slots add the number to
// the domain. That rule is what keeps an existing deployment working without migration.
func SlotSalt(secret string, slot int) ([]byte, error) {
	if err := ValidSlot(slot); err != nil {
		return nil, err
	}
	if slot == 0 {
		return SaltOf(secret), nil
	}
	sum := sha1.Sum([]byte(fmt.Sprintf("mgt-salt:%d:%s", slot, secret)))
	return sum[:], nil
}

// SlotBoxKey mirrors slotBoxKey(): one content key per slot, so a node cannot forge another node's
// offer (a compromised slot cannot even be read by a different slot's key).
func SlotBoxKey(secret string, slot int) ([32]byte, error) {
	var out [32]byte
	if err := ValidSlot(slot); err != nil {
		return out, err
	}
	domain := "mgt-box:" + secret
	if slot != 0 {
		domain = fmt.Sprintf("mgt-box:%d:%s", slot, secret)
	}
	h, err := blake2b.New256(nil)
	if err != nil {
		return out, fmt.Errorf("blake2b: %w", err)
	}
	if _, err := h.Write([]byte(domain)); err != nil {
		return out, fmt.Errorf("blake2b: %w", err)
	}
	copy(out[:], h.Sum(nil))
	return out, nil
}

// TargetOf mirrors targetOf(): SHA1(pk ‖ salt) — the DHT item a node publishes under.
func TargetOf(pk [32]byte, salt []byte) []byte {
	h := sha1.New()
	h.Write(pk[:])
	h.Write(salt)
	return h.Sum(nil)
}

// VerifyDetached mirrors bep44Verify(): standard ed25519 with libsodium-compatible layout, so records
// signed by the Node exit verify here and vice versa.
func VerifyDetached(sig, value []byte, pk [32]byte) bool {
	if len(sig) != ed25519.SignatureSize || len(pk) != ed25519.PublicKeySize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(pk[:]), value, sig)
}

// SignDetached is the mirror of signer(): a detached ed25519 signature.
func SignDetached(value []byte, sk ed25519.PrivateKey) ([]byte, error) {
	if len(sk) != ed25519.PrivateKeySize {
		return nil, errors.New("invalid signing key")
	}
	return ed25519.Sign(sk, value), nil
}
