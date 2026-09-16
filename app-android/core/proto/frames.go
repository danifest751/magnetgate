package proto

import (
	"crypto/rand"
	"encoding/binary"
	"errors"

	"golang.org/x/crypto/nacl/secretbox"
)

// Multiplexed frames, protocol v4 (see frame2/makeCodecV2 in src/common.mjs):
//
//	[u32 length][24-byte nonce][secretbox(body)]
//	body = [1 version=4][8 sequence][1 type][4 streamId][plaintext]
//
// `length` counts everything after itself. The version, sequence, type and streamId live *inside* the
// box, so routing metadata is authenticated and a replayed or reordered frame is rejected rather than
// acted on. streamId 0 is session level (ping/pong); every other type needs a non-zero stream.
//
// DATA plaintext is padded inside the box as [u16 padLen][pad][data], quantized to buckets, so wire
// sizes do not reveal the payload shape exactly.
const (
	FrameOpen     = 1
	FrameData     = 2
	FrameClose    = 3
	FramePing     = 4
	FramePong     = 5
	FrameUDPAssoc = 6
	FrameUDPData  = 7
	FrameUDPClose = 8
	FrameOpenOK   = 9
	FrameEnd      = 10

	frameVersion = 4
	padHdr       = 2
	// length (4) + nonce (24) + MAC (16) + version/sequence/type/streamId (14)
	frameHeader = 4 + 24 + 16 + 14
	// MaxFrameBytes is the limit the peer enforces as well: anything larger kills the session.
	MaxFrameBytes = 4 * 1024 * 1024
	// the smallest `length` value the decoder accepts (nonce + MAC + header, empty plaintext)
	MinFrameLength = 54
)

var (
	ErrInvalidFrame  = errors.New("invalid frame")
	ErrFrameTooLarge = errors.New("frame too large")
)

var padBuckets = []int{64, 256, 512, 1024, 2048, 4096}

// paddedLength mirrors paddedLength() in src/common.mjs: the first bucket that fits, otherwise the
// next multiple of 4096. Deterministic, which is what makes frame sizes testable.
func paddedLength(n int) int {
	for _, bucket := range padBuckets {
		if n+padHdr <= bucket {
			return bucket
		}
	}
	return ((n + padHdr + 4095) / 4096) * 4096
}

func padPlain(plain []byte) []byte {
	outLen := paddedLength(len(plain))
	padLen := outLen - len(plain) - padHdr
	out := make([]byte, outLen)
	binary.BigEndian.PutUint16(out[0:2], uint16(padLen))
	if padLen > 0 {
		if _, err := rand.Read(out[padHdr : padHdr+padLen]); err != nil {
			// crypto/rand failing is unrecoverable; the caller sees a short pad of zeros, which is
			// still a valid frame — never a protocol error.
			_ = err
		}
	}
	copy(out[padHdr+padLen:], plain)
	return out
}

func validType(typ byte) bool {
	return typ >= FrameOpen && typ <= FrameEnd
}

// ValidFrameHeader mirrors validHeader(): ping/pong are session level (id 0), everything else must
// address a stream.
func ValidFrameHeader(typ byte, streamID uint32) bool {
	if !validType(typ) {
		return false
	}
	if typ == FramePing || typ == FramePong {
		return streamID == 0
	}
	return streamID > 0
}

// EncodeFrame mirrors frame2(): one sealed frame with an explicit sequence number.
func EncodeFrame(key *[32]byte, typ byte, streamID uint32, plain []byte, sequence uint64) ([]byte, error) {
	if !ValidFrameHeader(typ, streamID) {
		return nil, ErrInvalidFrame
	}
	padded := plain
	if typ == FrameData {
		padded = padPlain(plain)
	}
	if frameHeader+len(padded) > MaxFrameBytes {
		return nil, ErrFrameTooLarge
	}
	body := make([]byte, 14+len(padded))
	body[0] = frameVersion
	binary.BigEndian.PutUint64(body[1:9], sequence)
	body[9] = typ
	binary.BigEndian.PutUint32(body[10:14], streamID)
	copy(body[14:], padded)

	var nonce [24]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	out := make([]byte, 4, 4+24+len(body)+secretbox.Overhead)
	binary.BigEndian.PutUint32(out, uint32(24+len(body)+secretbox.Overhead))
	out = append(out, nonce[:]...)
	return secretbox.Seal(out, body, &nonce, key), nil
}

// FrameEncoder mirrors makeFrameEncoder(): one monotonic counter per direction.
type FrameEncoder struct {
	key *[32]byte
	seq uint64
}

func NewFrameEncoder(key *[32]byte) *FrameEncoder { return &FrameEncoder{key: key} }

func (e *FrameEncoder) Encode(typ byte, streamID uint32, plain []byte) ([]byte, error) {
	frame, err := EncodeFrame(e.key, typ, streamID, plain, e.seq)
	if err != nil {
		return nil, err
	}
	e.seq++
	return frame, nil
}

// Frame is what a decoder hands to the application.
type Frame struct {
	Type     byte
	StreamID uint32
	Plain    []byte
}

// Decoder mirrors makeCodecV2(): it accepts a byte stream (chunks may split frames anywhere), enforces
// the exact frame limit, requires the authenticated sequence to be exactly the next one, and calls
// Kill() on the first violation. Ordering is guaranteed by the sender's ReliableStream, so a mismatch
// means tampering or a bug, not jitter.
type Decoder struct {
	key     *[32]byte
	onFrame func(Frame)
	onKill  func()
	killed  bool
	seq     uint64
	buffer  []byte
	used    int
	needed  int
}

func NewDecoder(key *[32]byte, onFrame func(Frame), onKill func()) *Decoder {
	return &Decoder{key: key, onFrame: onFrame, onKill: onKill, buffer: make([]byte, 4), needed: 4}
}

func (d *Decoder) Killed() bool { return d.killed }

func (d *Decoder) Kill() {
	if d.killed {
		return
	}
	d.killed = true
	d.buffer = nil
	if d.onKill != nil {
		d.onKill()
	}
}

// Push feeds newly received bytes. An empty chunk is a no-op, so a transport can call it safely.
func (d *Decoder) Push(chunk []byte) {
	if d.killed {
		return
	}
	offset := 0
	for !d.killed && offset < len(chunk) {
		take := d.needed - d.used
		if remaining := len(chunk) - offset; remaining < take {
			take = remaining
		}
		copy(d.buffer[d.used:d.used+take], chunk[offset:offset+take])
		d.used += take
		offset += take
		if d.used < d.needed {
			continue
		}
		if d.needed == 4 {
			length := int(binary.BigEndian.Uint32(d.buffer))
			if length < MinFrameLength || length > MaxFrameBytes {
				d.Kill()
				return
			}
			d.needed = length
			d.used = 0
			d.buffer = make([]byte, length)
			continue
		}
		var nonce [24]byte
		copy(nonce[:], d.buffer[0:24])
		body, ok := secretbox.Open(nil, d.buffer[24:], &nonce, d.key)
		if !ok || len(body) < 14 {
			d.Kill()
			return
		}
		if body[0] != frameVersion ||
			binary.BigEndian.Uint64(body[1:9]) != d.seq ||
			!ValidFrameHeader(body[9], binary.BigEndian.Uint32(body[10:14])) {
			d.Kill()
			return
		}
		typ := body[9]
		streamID := binary.BigEndian.Uint32(body[10:14])
		plain := body[14:]
		if typ == FrameData {
			if len(plain) < padHdr {
				d.Kill()
				return
			}
			padLen := int(binary.BigEndian.Uint16(plain[0:2]))
			if padLen > len(plain)-padHdr {
				d.Kill()
				return
			}
			plain = plain[padHdr+padLen:]
		}
		d.seq++
		d.needed = 4
		d.used = 0
		d.buffer = make([]byte, 4)
		if d.onFrame != nil {
			func() {
				defer func() {
					if recover() != nil {
						d.Kill()
					}
				}()
				d.onFrame(Frame{Type: typ, StreamID: streamID, Plain: plain})
			}()
		}
		if d.killed {
			return
		}
	}
}

// PaddedLengthForData is exposed for tests and for the shared vectors: the wire length of a DATA frame
// is deterministic for a given plaintext size (only the nonce and pad bytes are random).
func PaddedLengthForData(plainLen int) int { return paddedLength(plainLen) }

// FrameHeaderSize is the overhead outside the padded plaintext (length prefix, nonce, MAC, header).
func FrameHeaderSize() int { return frameHeader }
