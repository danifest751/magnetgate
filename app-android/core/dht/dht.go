// Package dht is the client half of the DHT rendezvous channel.
//
// A node publishes its sealed offer as a BEP 44 mutable item under
// target = SHA1(pk ‖ salt). This package reads that item back and verifies it before anyone looks
// inside: the value is handed over only when the ed25519 signature covers exactly the (salt, seq, v)
// triple that was asked for.
//
// Only the read path exists here, and that is deliberate: exits publish (src/exit.js does it with
// bittorrent-dht), clients never do. There is no put, no announce and no peer store on this side, so a
// phone cannot be turned into a DHT writer by a bug in the client.
package dht

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"

	"github.com/anacrolix/dht/v2"
	"github.com/anacrolix/dht/v2/bep44"
	"github.com/anacrolix/dht/v2/exts/getput"

	"magnetgate/core/proto"
)

var (
	// ErrNotFound means no node on the lookup path had the item (yet).
	ErrNotFound = errors.New("dht: no offer")
	// ErrBadSignature means the item exists but was not signed by the key we asked for.
	ErrBadSignature = errors.New("dht: offer signature does not match the key")
	// ErrNotMutable means the item came back as an immutable one, which is never how a node publishes.
	ErrNotMutable = errors.New("dht: item is not mutable")
	// ErrBadValue means the item is not a bencoded byte string, so it cannot be a sealed offer.
	ErrBadValue = errors.New("dht: malformed value")
)

// Config is what a client needs to join the DHT.
type Config struct {
	// Bootstrap is host:port of the routers (and of the deployment's own bootstrap node) to start from.
	Bootstrap []string
	// Passive keeps the node from answering queries: a phone reads offers, it does not serve a swarm.
	Passive bool
	// Logf, when set, receives connection-level notes; nil means silent.
	Logf func(format string, args ...any)
}

// Client is a read-only DHT node.
type Client struct {
	server *dht.Server
	conn   net.PacketConn
	logf   func(string, ...any)
}

// New joins the DHT. It returns once the socket is up; the first lookup does the bootstrapping.
func New(cfg Config) (*Client, error) {
	if len(cfg.Bootstrap) == 0 {
		return nil, errors.New("dht: no bootstrap nodes")
	}
	conn, err := net.ListenPacket("udp4", ":0")
	if err != nil {
		return nil, err
	}
	resolve := func() ([]dht.Addr, error) {
		addrs, err := dht.ResolveHostPorts(cfg.Bootstrap)
		if err != nil {
			return nil, err
		}
		if len(addrs) == 0 {
			return nil, errors.New("dht: bootstrap nodes did not resolve")
		}
		return addrs, nil
	}
	server, err := dht.NewServer(&dht.ServerConfig{
		Conn:          conn,
		StartingNodes: resolve,
		Passive:       cfg.Passive,
		// The deployment publishes with an unsecured node id (BEP 42 is not implemented on the exit
		// side), so there is no security extension to comply with here either.
		NoSecurity: true,
	})
	if err != nil {
		conn.Close()
		return nil, err
	}
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Client{server: server, conn: conn, logf: logf}, nil
}

// Close stops the node and its socket.
func (c *Client) Close() error {
	c.server.Close()
	return c.conn.Close()
}

// Get reads the mutable item published for (pk, salt), verifying its BEP 44 signature.
//
// The caller gets the raw sealed value and the sequence it was stored under: the sequence is not
// decoration, it is the domain the envelope was sealed with, so the two must be used together.
func (c *Client) Get(ctx context.Context, pk [32]byte, salt []byte) ([]byte, int64, error) {
	target := bep44.MakeMutableTarget(pk, salt)
	result, stats, err := getput.Get(ctx, target, c.server, nil, salt)
	if err != nil {
		// a traversal that finds nothing is the normal "not published yet" case, not a failure
		return nil, 0, fmt.Errorf("%w: %v", ErrNotFound, err)
	}
	c.logf("dht: lookup finished: %d queries, %d responses", stats.NumAddrsTried, stats.NumResponses)
	if !result.Mutable {
		return nil, 0, ErrNotMutable
	}
	if len(result.V) == 0 {
		return nil, 0, ErrNotFound
	}
	// result.V is the value as it sits on the wire — a bencoded byte string — which is exactly what the
	// signature covers; the envelope inside it is what we actually want.
	if !verifySignature(pk, salt, result.Seq, result.V, result.Sig) {
		return nil, 0, ErrBadSignature
	}
	value, err := unwrapValue(result.V)
	if err != nil {
		return nil, 0, err
	}
	return value, result.Seq, nil
}

// verifySignature checks a record against the key it claims to be published under.
func verifySignature(pk [32]byte, salt []byte, seq int64, valueToken []byte, sig [64]byte) bool {
	return proto.VerifyDetached(sig[:], SigningInput(salt, seq, valueToken), pk)
}

// SigningInput rebuilds the bytes BEP 44 signs.
//
// Both sides of the wire strip the bencode dictionary markers: bittorrent-dht encodes {salt, seq, v}
// and signs `encode(ref).slice(1, -1)`, i.e. everything between the 'd' and the final 'e'. The value
// stays in its wire form (a byte string, length prefix included), so the caller passes the token it
// received, not the decoded envelope.
func SigningInput(salt []byte, seq int64, valueToken []byte) []byte {
	out := make([]byte, 0, 32+len(salt)+len(valueToken))
	if len(salt) > 0 {
		out = appendString(out, []byte("salt"))
		out = appendString(out, salt)
	}
	out = append(out, "3:seqi"...)
	out = strconv.AppendInt(out, seq, 10)
	out = append(out, "e1:v"...)
	return append(out, valueToken...)
}

// unwrapValue decodes the bencoded byte string a node serves as `v`. It is strict on purpose: an
// offer is always published as a byte string, so anything else is a record this client should refuse
// rather than guess at.
func unwrapValue(token []byte) ([]byte, error) {
	colon := bytes.IndexByte(token, ':')
	if colon < 1 || colon > 10 {
		return nil, fmt.Errorf("%w: value is not a byte string", ErrBadValue)
	}
	length, err := strconv.Atoi(string(token[:colon]))
	if err != nil || length < 0 {
		return nil, fmt.Errorf("%w: value length %q", ErrBadValue, token[:colon])
	}
	body := token[colon+1:]
	if len(body) == 0 || len(body) != length {
		return nil, fmt.Errorf("%w: value length %d does not match %d bytes", ErrBadValue, length, len(body))
	}
	return body, nil
}

func appendString(dst, s []byte) []byte {
	dst = strconv.AppendInt(dst, int64(len(s)), 10)
	dst = append(dst, ':')
	return append(dst, s...)
}
