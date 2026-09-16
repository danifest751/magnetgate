package proto

import (
	"crypto/rand"
	"errors"

	"golang.org/x/crypto/nacl/secretbox"
)

// Envelope layout (see seal/unseal in src/common.mjs):
//
//	[0]        version = 4
//	[1:25]     random 24-byte nonce
//	[25:]      secretbox(body) = 16-byte tag ‖ ciphertext   (XSalsa20-Poly1305)
//
//	body = [0] version = 4 | [1] domain length | domain | plaintext
//
// The domain is authenticated *inside* the box, which is how a record is bound to its channel and
// sequence (`seq` for DHT, `n<seq>` for Nostr) and, in the multi-node design, to its slot.
const (
	EnvelopeVersion = 4
	MaxSealDomain   = 64
	MinEnvelope     = 43   // 1 + 24 + 16 + 2
	MaxEnvelope     = 65536
)

// Seal mirrors seal(): random nonce, authenticated domain, secretbox. The nonce is random by design —
// a deterministic nonce derived from the sequence was the original scheme and was replaced because it
// is unsafe when a sequence repeats.
func Seal(key *[32]byte, plain []byte, domain string) ([]byte, error) {
	if len(domain) > MaxSealDomain {
		return nil, errors.New("invalid seal domain")
	}
	var nonce [24]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	body := make([]byte, 0, 2+len(domain)+len(plain))
	body = append(body, EnvelopeVersion, byte(len(domain)))
	body = append(body, domain...)
	body = append(body, plain...)

	out := make([]byte, 0, 1+24+len(body)+secretbox.Overhead)
	out = append(out, EnvelopeVersion)
	out = append(out, nonce[:]...)
	return secretbox.Seal(out, body, &nonce, key), nil
}

// Unseal mirrors unseal(): returns nil for anything that is not a valid envelope for this key and
// domain — wrong version, truncated, tampered, or a different generation.
func Unseal(key *[32]byte, envelope []byte, domain string) []byte {
	if len(envelope) < MinEnvelope || len(envelope) > MaxEnvelope || envelope[0] != EnvelopeVersion {
		return nil
	}
	var nonce [24]byte
	copy(nonce[:], envelope[1:25])
	body, ok := secretbox.Open(nil, envelope[25:], &nonce, key)
	if !ok {
		return nil
	}
	if len(body) < 2 || body[0] != EnvelopeVersion {
		return nil
	}
	domainLen := int(body[1])
	if len(body) < 2+domainLen || string(body[2:2+domainLen]) != domain {
		return nil
	}
	return body[2+domainLen:]
}
