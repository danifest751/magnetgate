package proto

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// vectors is the tracked, deterministic half of the cross-implementation check: the Node client
// generates it (scripts/dev/gen-vectors.mjs) and both sides must agree byte for byte. Randomness-bound
// parts (sealing) are checked in both directions by scripts/dev/verify-vectors.mjs instead.
type vectors struct {
	Psk       string `json:"psk"`
	Constants struct {
		EnvelopeVersion   int `json:"envelopeVersion"`
		OfferSchema       int `json:"offerSchema"`
		MaxSlots          int `json:"maxSlots"`
		MaxSealDomain     int `json:"maxSealDomain"`
		FrameHeaderSize   int `json:"frameHeaderSize"`
		MaxFrameBytes     int `json:"maxFrameBytes"`
		MinFrameLength    int `json:"minFrameLength"`
		HsMsg1Len         int `json:"hsMsg1Len"`
		HsMsg2Len         int `json:"hsMsg2Len"`
		HsTimestampSkewMs int `json:"hsTimestampSkewMs"`
	} `json:"constants"`
	Handshake struct {
		Msg1 string `json:"msg1"`
		Msg2 string `json:"msg2"`
		CeSk string `json:"ceSk"`
		CePk string `json:"cePk"`
		C2E  string `json:"c2e"`
		E2C  string `json:"e2c"`
	} `json:"handshake"`
	FrameLengths []struct {
		PlainLen int `json:"plainLen"`
		Data     int `json:"data"`
		Open     int `json:"open"`
	} `json:"frameLengths"`
	Keys struct {
		Pk     string `json:"pk"`
		BoxKey string `json:"boxKey"`
		Salt0  string `json:"salt0"`
	} `json:"keys"`
	Slots []struct {
		Slot   int    `json:"slot"`
		Salt   string `json:"salt"`
		Target string `json:"target"`
		BoxKey string `json:"boxKey"`
	} `json:"slots"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "v1.json"))
	if err != nil {
		t.Fatalf("read vectors (run `node scripts/dev/gen-vectors.mjs`): %v", err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return v
}

func TestKeysMatchNodeImplementation(t *testing.T) {
	v := loadVectors(t)
	keys, err := DeriveKeys(v.Psk)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if got := hex.EncodeToString(keys.Pk[:]); got != v.Keys.Pk {
		t.Errorf("pk mismatch\n got %s\nwant %s", got, v.Keys.Pk)
	}
	if got := hex.EncodeToString(keys.BoxKey[:]); got != v.Keys.BoxKey {
		t.Errorf("boxKey mismatch\n got %s\nwant %s", got, v.Keys.BoxKey)
	}
	if got := hex.EncodeToString(SaltOf(v.Psk)); got != v.Keys.Salt0 {
		t.Errorf("salt0 mismatch\n got %s\nwant %s", got, v.Keys.Salt0)
	}
}

func TestSlotsMatchNodeImplementation(t *testing.T) {
	v := loadVectors(t)
	keys, err := DeriveKeys(v.Psk)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(v.Slots) < 2 {
		t.Fatalf("expected vectors for several slots, got %d", len(v.Slots))
	}
	for _, slot := range v.Slots {
		salt, err := SlotSalt(v.Psk, slot.Slot)
		if err != nil {
			t.Fatalf("slot %d salt: %v", slot.Slot, err)
		}
		if got := hex.EncodeToString(salt); got != slot.Salt {
			t.Errorf("slot %d salt mismatch\n got %s\nwant %s", slot.Slot, got, slot.Salt)
		}
		if got := hex.EncodeToString(TargetOf(keys.Pk, salt)); got != slot.Target {
			t.Errorf("slot %d target mismatch\n got %s\nwant %s", slot.Slot, got, slot.Target)
		}
		box, err := SlotBoxKey(v.Psk, slot.Slot)
		if err != nil {
			t.Fatalf("slot %d box key: %v", slot.Slot, err)
		}
		if got := hex.EncodeToString(box[:]); got != slot.BoxKey {
			t.Errorf("slot %d box key mismatch\n got %s\nwant %s", slot.Slot, got, slot.BoxKey)
		}
	}
}

// Slot 0 must stay byte-identical to the single-node derivation: that is the whole compatibility story
// of the multi-node design (an old client keeps working against a node on slot 0).
func TestSlotZeroIsTheSingleNodeValue(t *testing.T) {
	v := loadVectors(t)
	salt, err := SlotSalt(v.Psk, 0)
	if err != nil {
		t.Fatalf("slot 0: %v", err)
	}
	if hex.EncodeToString(salt) != hex.EncodeToString(SaltOf(v.Psk)) {
		t.Error("slot 0 salt must equal SaltOf")
	}
	box, err := SlotBoxKey(v.Psk, 0)
	if err != nil {
		t.Fatalf("slot 0 box: %v", err)
	}
	keys, err := DeriveKeys(v.Psk)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if box != keys.BoxKey {
		t.Error("slot 0 box key must equal DeriveKeys().BoxKey")
	}
	if len(v.Slots) > 1 && hex.EncodeToString(salt) == v.Slots[1].Salt {
		t.Error("slot 0 and slot 1 must not share a salt")
	}
}

func TestProtocolConstantsMatchTheVectors(t *testing.T) {
	v := loadVectors(t)
	if v.Constants.EnvelopeVersion != EnvelopeVersion {
		t.Errorf("envelope version drift: code %d, vectors %d", EnvelopeVersion, v.Constants.EnvelopeVersion)
	}
	if v.Constants.MaxSlots != MaxSlots {
		t.Errorf("slot range drift: code %d, vectors %d", MaxSlots, v.Constants.MaxSlots)
	}
	if v.Constants.MaxSealDomain != MaxSealDomain {
		t.Errorf("seal domain drift: code %d, vectors %d", MaxSealDomain, v.Constants.MaxSealDomain)
	}
	if v.Constants.FrameHeaderSize != FrameHeaderSize() {
		t.Errorf("frame header drift: code %d, vectors %d", FrameHeaderSize(), v.Constants.FrameHeaderSize)
	}
	if v.Constants.MaxFrameBytes != MaxFrameBytes {
		t.Errorf("frame limit drift: code %d, vectors %d", MaxFrameBytes, v.Constants.MaxFrameBytes)
	}
	if v.Constants.MinFrameLength != MinFrameLength {
		t.Errorf("minimum frame drift: code %d, vectors %d", MinFrameLength, v.Constants.MinFrameLength)
	}
}

// Frame sizes must quantise exactly as the Node implementation does, otherwise a peer sees a different
// wire shape (and the old 517-byte ClientHello bug class becomes possible again).
func TestFrameLengthsMatchNodeImplementation(t *testing.T) {
	v := loadVectors(t)
	keys, err := DeriveKeys(v.Psk)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(v.FrameLengths) == 0 {
		t.Fatal("the vectors carry no frame lengths (regenerate with scripts/dev/gen-vectors.mjs)")
	}
	for _, c := range v.FrameLengths {
		plain := bytes.Repeat([]byte{7}, c.PlainLen)
		data, err := EncodeFrame(&keys.BoxKey, FrameData, 1, plain, 0)
		if err != nil {
			t.Fatalf("data frame of %d bytes: %v", c.PlainLen, err)
		}
		if len(data) != c.Data {
			t.Errorf("DATA frame of %d bytes: got %d, want %d", c.PlainLen, len(data), c.Data)
		}
		open, err := EncodeFrame(&keys.BoxKey, FrameOpen, 1, plain, 0)
		if err != nil {
			t.Fatalf("open frame of %d bytes: %v", c.PlainLen, err)
		}
		if len(open) != c.Open {
			t.Errorf("OPEN frame of %d bytes: got %d, want %d", c.PlainLen, len(open), c.Open)
		}
	}
}

func TestSlotValidation(t *testing.T) {
	for _, bad := range []int{-1, MaxSlots, MaxSlots + 5} {
		if err := ValidSlot(bad); err == nil {
			t.Errorf("slot %d must be rejected", bad)
		}
		if _, err := SlotSalt("psk", bad); err == nil {
			t.Errorf("SlotSalt(%d) must fail", bad)
		}
		if _, err := SlotBoxKey("psk", bad); err == nil {
			t.Errorf("SlotBoxKey(%d) must fail", bad)
		}
	}
	if err := ValidSlot(0); err != nil {
		t.Errorf("slot 0 must be valid: %v", err)
	}
	if err := ValidSlot(MaxSlots - 1); err != nil {
		t.Errorf("the last slot must be valid: %v", err)
	}
}
