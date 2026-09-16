package dht

import (
	"context"
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
// bencode({salt, seq, v}) with the dictionary markers sliced off, so a reconstruction that keeps them
// (or that re-encodes the value) would reject every genuine offer.
func TestSigningInputMatchesBEP44(t *testing.T) {
	// the value token is what sits on the wire: the bencoding of a byte string, prefix included
	if got := string(SigningInput([]byte("s"), 7, []byte("2:hi"))); got != "4:salt1:s3:seqi7e1:v2:hi" {
		t.Errorf("with salt: got %q", got)
	}
	if got := string(SigningInput(nil, 1, []byte("1:v"))); got != "3:seqi1e1:v1:v" {
		t.Errorf("without salt: got %q", got)
	}
}

// The library signs with its own reconstruction of the same bytes; if ours differed by one byte, every
// genuine record would be refused.
func TestSignatureVerificationMatchesTheSigner(t *testing.T) {
	keys := testKeys(t, "dht-test-psk")
	salt := proto.SaltOf("dht-test-psk")
	item, err := bep44.NewItem([]byte("hello"), salt, 1, 0, keys.Sk)
	if err != nil {
		t.Fatalf("item: %v", err)
	}
	token := []byte("5:hello") // what a node serves as `v` for that value

	if !verifySignature(keys.Pk, salt, 1, token, item.Sig) {
		t.Fatal("a genuine signature must verify")
	}
	direct := bep44.Sign(keys.Sk, salt, 1, token)
	var fromSign [64]byte
	copy(fromSign[:], direct)
	if fromSign != item.Sig {
		t.Fatal("bep44.Sign and NewItem must produce the same signature")
	}
	if verifySignature(keys.Pk, salt, 1, []byte("5:other"), item.Sig) {
		t.Error("a tampered value must not verify")
	}
	if verifySignature(keys.Pk, salt, 2, token, item.Sig) {
		t.Error("a different sequence number must not verify")
	}
	other := testKeys(t, "another-psk")
	if verifySignature(other.Pk, salt, 1, token, item.Sig) {
		t.Error("a different key must not verify")
	}
	otherSalt := proto.SaltOf("another-psk")
	if verifySignature(keys.Pk, otherSalt, 1, token, item.Sig) {
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
