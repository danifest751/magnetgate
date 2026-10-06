// Package peer implements the opt-in user exit protocol. It deliberately does
// not import the legacy rendezvous PSK or its signing keys.
package peer

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"time"
)

const Version = 1
const Audience = "magnetgate-peer-v1"

type Identity struct{ Key ed25519.PrivateKey }

func NewIdentity() (Identity, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	return Identity{key}, err
}
func (i Identity) Public() string { return hex.EncodeToString(i.Key.Public().(ed25519.PublicKey)) }
func ParsePublic(s string) (ed25519.PublicKey, error) {
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("invalid device public key")
	}
	return ed25519.PublicKey(b), nil
}
func randomID() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// These fixed structs, not arbitrary JSON maps, define signed bytes. Version
// and audience are checked independently of the signature.
type Claims struct {
	Version   int    `json:"version"`
	Audience  string `json:"audience"`
	Device    string `json:"device"`
	Principal string `json:"principal"`
	Guest     bool   `json:"guest"`
	Exit      bool   `json:"exit"`
	Expires   int64  `json:"expires"`
}
type Credential struct {
	Claims    Claims `json:"claims"`
	Signature string `json:"signature"`
}

func IssueCredential(key ed25519.PrivateKey, c Claims) Credential {
	c.Version, c.Audience = Version, Audience
	b, _ := json.Marshal(c)
	return Credential{c, base64.RawStdEncoding.EncodeToString(ed25519.Sign(key, b))}
}
func (c Credential) Verify(authority ed25519.PublicKey, now time.Time) error {
	b, _ := json.Marshal(c.Claims)
	s, err := base64.RawStdEncoding.DecodeString(c.Signature)
	if err != nil || !ed25519.Verify(authority, b, s) {
		return errors.New("invalid service credential")
	}
	if c.Claims.Version != Version || c.Claims.Audience != Audience || c.Claims.Expires <= now.Unix() || c.Claims.Expires > now.Add(24*time.Hour).Unix() || c.Claims.Principal == "" || len(c.Claims.Principal) > 128 {
		return errors.New("expired or incompatible credential")
	}
	_, err = ParsePublic(c.Claims.Device)
	return err
}
func proof(key ed25519.PrivateKey, challenge, scope string) string {
	return base64.RawStdEncoding.EncodeToString(ed25519.Sign(key, []byte(Audience+"\x00"+scope+"\x00"+challenge)))
}
func verifyProof(public, challenge, scope, sig string) bool {
	key, err := ParsePublic(public)
	if err != nil {
		return false
	}
	b, err := base64.RawStdEncoding.DecodeString(sig)
	return err == nil && ed25519.Verify(key, []byte(Audience+"\x00"+scope+"\x00"+challenge), b)
}

func (i Identity) certificate() (tls.Certificate, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	now := time.Now()
	t := &x509.Certificate{SerialNumber: serial, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, t, t, i.Key.Public(), i.Key)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: i.Key}, err
}
func (i Identity) tlsConfig(remote string, server bool) (*tls.Config, error) {
	key, err := ParsePublic(remote)
	if err != nil {
		return nil, err
	}
	cert, err := i.certificate()
	if err != nil {
		return nil, err
	}
	cfg := &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, SessionTicketsDisabled: true}
	// Authentication is an exact Ed25519 device pin, rather than a web PKI name.
	// VerifyConnection runs on every handshake (including future resumption).
	cfg.InsecureSkipVerify = true
	cfg.VerifyConnection = func(s tls.ConnectionState) error {
		if s.Version != tls.VersionTLS13 || len(s.PeerCertificates) != 1 {
			return errors.New("missing peer identity")
		}
		cert := s.PeerCertificates[0]
		pk, ok := cert.PublicKey.(ed25519.PublicKey)
		if !ok || !pk.Equal(key) || time.Now().Before(cert.NotBefore) || time.Now().After(cert.NotAfter) {
			return errors.New("peer identity mismatch")
		}
		return nil
	}
	if server {
		cfg.ClientAuth = tls.RequireAnyClientCert
	}
	return cfg, nil
}
