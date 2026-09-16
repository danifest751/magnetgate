package proto

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"testing"

	"golang.org/x/crypto/nacl/secretbox"
)

func testKey(t *testing.T) *[32]byte {
	t.Helper()
	keys, err := DeriveKeys("frames-test-psk")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	return &keys.BoxKey
}

// Collect decodes everything a decoder receives.
type collector struct {
	frames []Frame
	killed bool
}

func newCollector() *collector { return &collector{} }

func (c *collector) dec(key *[32]byte) *Decoder {
	return NewDecoder(key, func(f Frame) { c.frames = append(c.frames, f) }, func() { c.killed = true })
}

func TestFrameLengthsAreDeterministic(t *testing.T) {
	key := testKey(t)
	cases := []struct {
		typ        byte
		plainLen   int
		wantPadded int
	}{
		{FrameData, 0, 64},
		{FrameData, 1, 64},
		{FrameData, 62, 64},
		{FrameData, 63, 256},
		{FrameData, 254, 256},
		{FrameData, 255, 512},
		{FrameData, 4094, 4096},
		{FrameData, 4095, 8192},
		{FrameData, 10000, 12288},
		{FramePing, 0, 0},
		{FramePing, 40, 40},
		{FrameOpenOK, 100, 100},
	}
	for _, c := range cases {
		plain := bytes.Repeat([]byte{7}, c.plainLen)
		frame, err := EncodeFrame(key, c.typ, streamIDFor(c.typ), plain, 0)
		if err != nil {
			t.Fatalf("encode type=%d len=%d: %v", c.typ, c.plainLen, err)
		}
		wantPadded := c.plainLen
		if c.typ == FrameData {
			wantPadded = PaddedLengthForData(c.plainLen)
		}
		if wantPadded != c.wantPadded {
			t.Errorf("type=%d len=%d: padded %d, want %d", c.typ, c.plainLen, wantPadded, c.wantPadded)
		}
		if got, want := len(frame), FrameHeaderSize()+wantPadded; got != want {
			t.Errorf("type=%d len=%d: frame %d bytes, want %d", c.typ, c.plainLen, got, want)
		}
	}
}

func streamIDFor(typ byte) uint32 {
	if typ == FramePing || typ == FramePong {
		return 0
	}
	return 1
}

// Payloads in the same bucket must be indistinguishable by length — that is the point of the padding.
func TestDataPaddingQuantisesSizes(t *testing.T) {
	key := testKey(t)
	small := bytes.Repeat([]byte{1}, 1)
	almostBucket := bytes.Repeat([]byte{2}, 62)
	// monotonic sequence numbers: the decoder treats a repeat as a replay and kills the session
	encoder := NewFrameEncoder(key)
	a, err := encoder.Encode(FrameData, 1, small)
	if err != nil {
		t.Fatalf("encode small: %v", err)
	}
	b, err := encoder.Encode(FrameData, 1, almostBucket)
	if err != nil {
		t.Fatalf("encode near bucket: %v", err)
	}
	if len(a) != len(b) {
		t.Errorf("1 and 62 byte payloads must share a wire length: %d vs %d", len(a), len(b))
	}
	c := newCollector()
	dec := c.dec(key)
	dec.Push(a)
	dec.Push(b)
	if c.killed {
		t.Fatal("decoder killed valid frames")
	}
	if len(c.frames) != 2 {
		t.Fatalf("expected 2 frames, got %d", len(c.frames))
	}
	if !bytes.Equal(c.frames[0].Plain, small) || !bytes.Equal(c.frames[1].Plain, almostBucket) {
		t.Error("padding must be stripped back to the original payload")
	}
}

func TestFramesRoundTripIncludingFragmentedDelivery(t *testing.T) {
	key := testKey(t)
	encoder := NewFrameEncoder(key)
	var wire []byte
	expected := []Frame{
		{Type: FrameOpen, StreamID: 7, Plain: []byte("example.com:443")},
		{Type: FrameData, StreamID: 7, Plain: bytes.Repeat([]byte("x"), 517)}, // TLS ClientHello size
		{Type: FramePing, StreamID: 0, Plain: nil},
		{Type: FrameClose, StreamID: 7, Plain: nil},
	}
	for _, f := range expected {
		frame, err := encoder.Encode(f.Type, f.StreamID, f.Plain)
		if err != nil {
			t.Fatalf("encode %d: %v", f.Type, err)
		}
		wire = append(wire, frame...)
	}

	for _, chunkSize := range []int{1, 7, 4096, len(wire)} {
		c := newCollector()
		dec := c.dec(key)
		for offset := 0; offset < len(wire); offset += chunkSize {
			end := offset + chunkSize
			if end > len(wire) {
				end = len(wire)
			}
			dec.Push(wire[offset:end])
		}
		if c.killed {
			t.Fatalf("chunk size %d: decoder killed a valid stream", chunkSize)
		}
		if len(c.frames) != len(expected) {
			t.Fatalf("chunk size %d: got %d frames, want %d", chunkSize, len(c.frames), len(expected))
		}
		for i, want := range expected {
			got := c.frames[i]
			if got.Type != want.Type || got.StreamID != want.StreamID {
				t.Errorf("chunk size %d frame %d: type/stream %d/%d, want %d/%d",
					chunkSize, i, got.Type, got.StreamID, want.Type, want.StreamID)
			}
			if !bytes.Equal(got.Plain, want.Plain) {
				t.Errorf("chunk size %d frame %d: payload mismatch (%d vs %d bytes)",
					chunkSize, i, len(got.Plain), len(want.Plain))
			}
		}
	}
}

func TestEncoderRefusesInvalidHeaders(t *testing.T) {
	key := testKey(t)
	for _, c := range []struct {
		typ byte
		id  uint32
	}{
		{0, 1}, {11, 1}, {FramePing, 1}, {FramePong, 5}, {FrameOpen, 0}, {FrameData, 0}, {FrameClose, 0},
	} {
		if _, err := EncodeFrame(key, c.typ, c.id, nil, 0); !errors.Is(err, ErrInvalidFrame) {
			t.Errorf("type=%d id=%d must be refused, got %v", c.typ, c.id, err)
		}
	}
	if ValidFrameHeader(FramePing, 0) != true || ValidFrameHeader(FrameOpen, 1) != true {
		t.Error("valid headers must be accepted")
	}
}

func TestEncoderRefusesOversizedFrames(t *testing.T) {
	key := testKey(t)
	huge := make([]byte, MaxFrameBytes)
	if _, err := EncodeFrame(key, FrameData, 1, huge, 0); !errors.Is(err, ErrFrameTooLarge) {
		t.Errorf("a DATA payload that pads past the frame limit must be refused, got %v", err)
	}
}

// sealBody is a test helper that seals an arbitrary body with the right nonce/format, so the decoder's
// validation can be exercised on frames an honest encoder would never produce.
func sealBody(t *testing.T, key *[32]byte, body []byte) []byte {
	t.Helper()
	var nonce [24]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatalf("nonce: %v", err)
	}
	out := make([]byte, 4, 4+24+len(body)+secretbox.Overhead)
	binary.BigEndian.PutUint32(out, uint32(24+len(body)+secretbox.Overhead))
	out = append(out, nonce[:]...)
	return secretbox.Seal(out, body, &nonce, key)
}

func dataBody(seq uint64, typ byte, streamID uint32, plain []byte) []byte {
	body := make([]byte, 14+len(plain))
	body[0] = frameVersion
	binary.BigEndian.PutUint64(body[1:9], seq)
	body[9] = typ
	binary.BigEndian.PutUint32(body[10:14], streamID)
	copy(body[14:], plain)
	return body
}

func TestDecoderRejectsBrokenFrames(t *testing.T) {
	key := testKey(t)
	otherKeys, err := DeriveKeys("another-frames-psk")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}

	good, err := EncodeFrame(key, FrameOpen, 3, []byte("payload"), 0)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	t.Run("foreign key", func(t *testing.T) {
		c := newCollector()
		dec := c.dec(&otherKeys.BoxKey)
		dec.Push(good)
		if !c.killed || len(c.frames) != 0 {
			t.Error("a frame sealed for another key must kill the session")
		}
	})

	t.Run("tampered", func(t *testing.T) {
		broken := append([]byte(nil), good...)
		broken[len(broken)-1] ^= 0x01
		c := newCollector()
		dec := c.dec(key)
		dec.Push(broken)
		if !c.killed {
			t.Error("a tampered frame must kill the session")
		}
	})

	t.Run("duplicate sequence", func(t *testing.T) {
		c := newCollector()
		dec := c.dec(key)
		dec.Push(good)
		dec.Push(good) // same sequence again: a replay
		if !c.killed || len(c.frames) != 1 {
			t.Errorf("a replayed frame must kill the session (frames=%d, killed=%v)", len(c.frames), c.killed)
		}
	})

	t.Run("skipped sequence", func(t *testing.T) {
		skipped, err := EncodeFrame(key, FrameOpen, 3, []byte("payload"), 5)
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		c := newCollector()
		dec := c.dec(key)
		dec.Push(skipped)
		if !c.killed {
			t.Error("a frame from the wrong generation (sequence gap) must kill the session")
		}
	})

	t.Run("oversized length prefix", func(t *testing.T) {
		var head [4]byte
		binary.BigEndian.PutUint32(head[:], MaxFrameBytes+1)
		c := newCollector()
		dec := c.dec(key)
		dec.Push(head[:])
		if !c.killed {
			t.Error("a length prefix above the limit must kill the session")
		}
	})

	t.Run("undersized length prefix", func(t *testing.T) {
		var head [4]byte
		binary.BigEndian.PutUint32(head[:], MinFrameLength-1)
		c := newCollector()
		dec := c.dec(key)
		dec.Push(head[:])
		if !c.killed {
			t.Error("a length prefix below the minimum must kill the session")
		}
	})

	t.Run("invalid type in a sealed body", func(t *testing.T) {
		c := newCollector()
		dec := c.dec(key)
		dec.Push(sealBody(t, key, dataBody(0, 0, 1, nil)))
		if !c.killed {
			t.Error("an unknown frame type must kill the session")
		}
	})

	t.Run("session frame with a stream id", func(t *testing.T) {
		c := newCollector()
		dec := c.dec(key)
		dec.Push(sealBody(t, key, dataBody(0, FramePing, 4, nil)))
		if !c.killed {
			t.Error("a ping carrying a stream id must kill the session")
		}
	})

	t.Run("data padding longer than the payload", func(t *testing.T) {
		plain := []byte{0x00, 0x40, 'x'} // claims 64 bytes of padding in a 1-byte payload
		c := newCollector()
		dec := c.dec(key)
		dec.Push(sealBody(t, key, dataBody(0, FrameData, 1, plain)))
		if !c.killed {
			t.Error("an impossible padding length must kill the session")
		}
	})

	t.Run("wrong envelope version inside the box", func(t *testing.T) {
		body := dataBody(0, FrameOpen, 1, nil)
		body[0] = 3
		c := newCollector()
		dec := c.dec(key)
		dec.Push(sealBody(t, key, body))
		if !c.killed {
			t.Error("a foreign frame version must kill the session")
		}
	})
}

func TestDecoderKeepsWorkingAfterAKill(t *testing.T) {
	key := testKey(t)
	c := newCollector()
	dec := c.dec(key)
	dec.Kill()
	if !dec.Killed() {
		t.Fatal("Kill must be observable")
	}
	good, err := EncodeFrame(key, FrameOpen, 1, []byte("x"), 0)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	dec.Push(good)
	if len(c.frames) != 0 {
		t.Error("a killed decoder must ignore everything after the violation")
	}
	if c.killed != true {
		t.Error("onKill must have fired exactly once")
	}
}
