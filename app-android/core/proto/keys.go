// Package proto is the Android core's port of src/common.mjs. It must be byte-compatible with the
// Node client and the exits: the same PSK has to produce the same keys, the same rendezvous target and
// envelopes the other side can open. tests/dev vectors (scripts/dev/gen-vectors.mjs +
// scripts/dev/verify-vectors.mjs) check that in both directions.
package proto

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
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

// NostrKeys mirrors nostrKeys() in src/nostr.mjs: the second rendezvous channel has its own identity,
// a secp256k1 keypair whose secret is SHA-256("mgt-nostr:" + secret). It serves both as the author an
// exit signs events with and as the author filter a subscriber asks relays for, so the two sides must
// derive the same x-only public key.
func NostrKeys(secret string) (sk []byte, publicKeyHex string, err error) {
	sum := sha256.Sum256([]byte("mgt-nostr:" + secret))
	_, public := btcec.PrivKeyFromBytes(sum[:])
	return sum[:], hex.EncodeToString(schnorr.SerializePubKey(public)), nil
}

// NostrTagOf mirrors nostrTagOf(): the `d` tag of the replaceable event a node publishes under.
//
// It MUST differ per slot — a relay keeps one event per (author, kind, d), so two nodes sharing a PSK
// would otherwise overwrite each other and only the last writer would survive — while slot 0 keeps the
// original derivation so an existing deployment does not have to migrate.
func NostrTagOf(secret string, slot int) (string, error) {
	if err := ValidSlot(slot); err != nil {
		return "", err
	}
	domain := "mgt-nostr-d:" + secret
	if slot != 0 {
		domain = fmt.Sprintf("mgt-nostr-d:%d:%s", slot, secret)
	}
	sum := sha256.Sum256([]byte(domain))
	return hex.EncodeToString(sum[:])[:32], nil
}

// NostrVerify checks an event the way a relay does: the id is SHA-256 over the compact JSON of
// [0, pubkey, created_at, kind, tags, content] and the signature is BIP-340 over that id. The envelope
// MAC is what actually authenticates an offer; this only settles that the event is not relay garbage.
func NostrVerify(publicKeyHex string, id, sig, signedData []byte) bool {
	sum := sha256.Sum256(signedData)
	if !bytes.Equal(sum[:], id) {
		return false
	}
	public, err := hex.DecodeString(publicKeyHex)
	if err != nil {
		return false
	}
	point, err := schnorr.ParsePubKey(public)
	if err != nil {
		return false
	}
	signature, err := schnorr.ParseSignature(sig)
	if err != nil {
		return false
	}
	return signature.Verify(sum[:], point)
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
