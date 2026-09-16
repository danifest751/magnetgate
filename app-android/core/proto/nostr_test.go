package proto

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
)

// The values are what src/nostr.mjs produces for this PSK (nostrKeys/nostrTagOf). A subscriber asks
// relays for the author and the `d` tag below, so a drift here means the second rendezvous channel
// silently stops finding anything.
func TestNostrDerivationMatchesTheNodeImplementation(t *testing.T) {
	sk, pkHex, err := NostrKeys("nostr-test-psk")
	if err != nil {
		t.Fatalf("keys: %v", err)
	}
	if got := hex.EncodeToString(sk); got != "919d9fb1a4e5f9e668e07f51fa2cbfcb56250c480cabd5a00a9f3c66d928d868" {
		t.Errorf("secret: got %s", got)
	}
	if pkHex != "8df2c439b2f586cdcc085e3bf06cdff4866097b9e6281d5b466057a74cc5ca08" {
		t.Errorf("public key: got %s", pkHex)
	}

	tag0, err := NostrTagOf("nostr-test-psk", 0)
	if err != nil {
		t.Fatalf("tag 0: %v", err)
	}
	if tag0 != "ebd1c9283e2ecde0d1d6424cd48be32a" {
		t.Errorf("slot 0 tag: got %s", tag0)
	}
	tag1, err := NostrTagOf("nostr-test-psk", 1)
	if err != nil {
		t.Fatalf("tag 1: %v", err)
	}
	if tag1 != "36c352343c47c0318a367b7a0dfdbccb" {
		t.Errorf("slot 1 tag: got %s", tag1)
	}
}

// Two nodes on one PSK publish to the same relays, and a relay keeps one event per (author, kind, d):
// if the tags matched, the later publisher would erase the earlier node.
func TestNostrTagsArePerSlot(t *testing.T) {
	seen := map[string]int{}
	for slot := 0; slot < MaxSlots; slot++ {
		tag, err := NostrTagOf("shared-psk", slot)
		if err != nil {
			t.Fatalf("slot %d: %v", slot, err)
		}
		if len(tag) != 32 {
			t.Fatalf("slot %d: tag %q is not 32 hex characters", slot, tag)
		}
		if previous, ok := seen[tag]; ok {
			t.Fatalf("slots %d and %d share the tag %q", previous, slot, tag)
		}
		seen[tag] = slot
		if slot == 0 {
			legacy, _ := NostrTagOf("shared-psk", 0)
			if tag != legacy {
				t.Fatalf("slot 0 must keep the legacy derivation")
			}
		}
	}
	if _, err := NostrTagOf("x", MaxSlots); err == nil {
		t.Fatal("a slot out of range must be refused")
	}
}

// NostrVerify is the relay-side check: the id must be the hash of the signed data and the signature
// must be BIP-340, not the custom scheme the decred package implements.
func TestNostrVerifyAcceptsBIP340Only(t *testing.T) {
	sk, pkHex, err := NostrKeys("nostr-test-psk")
	if err != nil {
		t.Fatalf("keys: %v", err)
	}
	private, _ := btcec.PrivKeyFromBytes(sk)
	signedData := []byte(`[0,"` + pkHex + `",1789000000,30078,[["d","abc"],["mgt-seq","n7"]],"AAAA"]`)
	id := sha256.Sum256(signedData)
	signature, err := schnorr.Sign(private, id[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	if !NostrVerify(pkHex, id[:], signature.Serialize(), signedData) {
		t.Fatal("a genuine event must verify")
	}
	tampered := []byte(strings.Replace(string(signedData), `"n7"`, `"n8"`, 1))
	if NostrVerify(pkHex, id[:], signature.Serialize(), tampered) {
		t.Error("a changed payload must not verify")
	}
	wrongID := sha256.Sum256([]byte("something else"))
	if NostrVerify(pkHex, wrongID[:], signature.Serialize(), signedData) {
		t.Error("a mismatched id must not verify")
	}
	otherSk, otherPk, _ := NostrKeys("another-psk")
	otherPrivate, _ := btcec.PrivKeyFromBytes(otherSk)
	if NostrVerify(otherPk, id[:], signature.Serialize(), signedData) {
		t.Error("a signature must not verify under another key")
	}
	otherSignature, _ := schnorr.Sign(otherPrivate, id[:])
	if NostrVerify(pkHex, id[:], otherSignature.Serialize(), signedData) {
		t.Error("another key's signature must not verify")
	}
	if NostrVerify(pkHex, id[:], []byte("short"), signedData) {
		t.Error("a malformed signature must be refused")
	}
}
