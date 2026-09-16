package dht

import (
	"context"
	"crypto/ed25519"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/anacrolix/dht/v2"
	"github.com/anacrolix/dht/v2/bep44"

	"magnetgate/core/proto"
)

// startNode brings up a local DHT node; the read path is then tested against it.
func startNode(t *testing.T, bootstrap ...string) (*dht.Server, string) {
	t.Helper()
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	cfg := &dht.ServerConfig{Conn: conn, NoSecurity: true}
	if len(bootstrap) > 0 {
		cfg.StartingNodes = func() ([]dht.Addr, error) { return dht.ResolveHostPorts(bootstrap) }
	}
	server, err := dht.NewServer(cfg)
	if err != nil {
		conn.Close()
		t.Fatalf("dht server: %v", err)
	}
	t.Cleanup(server.Close)
	return server, conn.LocalAddr().String()
}

func newClient(t *testing.T, bootstrap ...string) *Client {
	t.Helper()
	client, err := New(Config{Bootstrap: bootstrap, Passive: true})
	if err != nil {
		t.Fatalf("dht client: %v", err)
	}
	t.Cleanup(func() { client.Close() })
	return client
}

func testKeys(t *testing.T, psk string) proto.Keys {
	t.Helper()
	keys, err := proto.DeriveKeys(psk)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	return keys
}

// The signed bytes are a wire contract with every exit: bittorrent-dht signs
// bencode({salt, seq, v}) with the dictionary markers sliced off, and the value keeps its own length
// prefix. The layout is pinned here by signing it by hand and handing it to the verifier that actually
// runs, so there is exactly one encoder on our side (the library's) and a test that notices if the
// convention ever changes.
func TestSignedBytesLayoutIsTheWireContract(t *testing.T) {
	keys := testKeys(t, "dht-test-psk")
	salt := []byte("s")
	seq := int64(7)
	token := []byte("2:hi") // what a node serves as `v` for the value "hi"

	// "4:salt1:s" + "3:seqi7e1:v" + "2:hi", i.e. the bencoding of {salt, seq, v} without the 'd'/'e'
	signed := append([]byte("4:salt1:s3:seqi7e1:v"), token...)
	if !bep44.Verify(keys.Pk[:], salt, seq, token, ed25519.Sign(keys.Sk, signed)) {
		t.Fatal("the agreed layout must verify")
	}
	// keeping the dictionary markers, as a naive bencoder would, must not
	withMarkers := append([]byte{'d'}, append(signed, 'e')...)
	if bep44.Verify(keys.Pk[:], salt, seq, token, ed25519.Sign(keys.Sk, withMarkers)) {
		t.Error("the dictionary markers must not be part of the signed bytes")
	}
	// a doubly encoded value is a different byte string and must not pass against this signature
	doubleEncoded := []byte("4:2:hi")
	if bep44.Verify(keys.Pk[:], salt, seq, doubleEncoded, ed25519.Sign(keys.Sk, signed)) {
		t.Error("a doubly encoded value must not verify")
	}
}

// The library signs with its own reconstruction of the same bytes; this keeps the tamper cases honest.
func TestSignatureVerificationMatchesTheSigner(t *testing.T) {
	keys := testKeys(t, "dht-test-psk")
	salt := proto.SaltOf("dht-test-psk")
	item, err := bep44.NewItem([]byte("hello"), salt, 1, 0, keys.Sk)
	if err != nil {
		t.Fatalf("item: %v", err)
	}
	token := []byte("5:hello") // what a node serves as `v` for that value

	if !bep44.Verify(keys.Pk[:], salt, 1, token, item.Sig[:]) {
		t.Fatal("a genuine signature must verify")
	}
	direct := bep44.Sign(keys.Sk, salt, 1, token)
	var fromSign [64]byte
	copy(fromSign[:], direct)
	if fromSign != item.Sig {
		t.Fatal("bep44.Sign and NewItem must produce the same signature")
	}
	if bep44.Verify(keys.Pk[:], salt, 1, []byte("5:other"), item.Sig[:]) {
		t.Error("a tampered value must not verify")
	}
	if bep44.Verify(keys.Pk[:], salt, 2, token, item.Sig[:]) {
		t.Error("a different sequence number must not verify")
	}
	other := testKeys(t, "another-psk")
	if bep44.Verify(other.Pk[:], salt, 1, token, item.Sig[:]) {
		t.Error("a different key must not verify")
	}
	if bep44.Verify(keys.Pk[:], proto.SaltOf("another-psk"), 1, token, item.Sig[:]) {
		t.Error("a different salt must not verify")
	}
}

func TestUnwrapValueIsStrict(t *testing.T) {
	got, err := unwrapValue([]byte("5:hello"))
	if err != nil || string(got) != "hello" {
		t.Fatalf("got %q, %v", got, err)
	}
	// an empty byte string is not an offer, and neither is a mismatched length or a raw envelope
	for _, bad := range []string{"", "0:", "5:hell", "x:hello", "5:helloo", "\x04\x00K\xc8"} {
		if _, err := unwrapValue([]byte(bad)); !errors.Is(err, ErrBadValue) {
			t.Errorf("%q must be refused, got %v", bad, err)
		}
	}
}

// The target is what the exit publishes under; if these ever drift, offers are looked up in the wrong
// place and nothing is ever found.
func TestTargetMatchesTheTargetNodesPublishUnder(t *testing.T) {
	keys := testKeys(t, "dht-test-psk")
	for _, salt := range [][]byte{proto.SaltOf("dht-test-psk"), nil, []byte("slot-9")} {
		want := bep44.MakeMutableTarget(keys.Pk, salt)
		if got := [20]byte(proto.TargetOf(keys.Pk, salt)); got != want {
			t.Errorf("salt %q: proto.TargetOf gives %x, BEP 44 wants %x", salt, got, want)
		}
	}
}

// Nothing published yet is the normal state before a node comes up, and must be a specific error: the
// rendezvous loop polls while a slot is quiet.
func TestGetReportsWhenNothingIsPublished(t *testing.T) {
	keys := testKeys(t, "dht-test-psk")
	_, addr := startNode(t)
	client := newClient(t, addr)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, _, err := client.Get(ctx, keys.Pk, proto.SaltOf("dht-test-psk")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestNewNeedsBootstrap(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("a client without bootstrap nodes must not start")
	}
}
