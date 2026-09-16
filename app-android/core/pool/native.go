package pool

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"

	"magnetgate/core/proto"
	"magnetgate/core/session"
)

// Native is the connector for the "mgt" plane: the multiplexed protocol this repository implements
// (a Go port of src/native-client.mjs) rather than a third-party transport.
//
// It keeps one session per exit, opened once and shared by every stream that node carries, and it
// derives the handshake key per slot: exits of different slots seal their handshake with different
// keys, so a node learned on slot 1 is unreachable with slot 0's key.
type Native struct {
	psk string

	mu         sync.Mutex
	sessions   map[string]*session.Session
	connecting map[string]chan struct{}
	keys       map[int]*[32]byte
}

// NewNative prepares the native connector. The PSK is validated here, so a bad one fails at startup
// instead of on the first request.
func NewNative(psk string) (*Native, error) {
	if _, err := proto.DeriveKeys(psk); err != nil {
		return nil, err
	}
	return &Native{
		psk:        psk,
		sessions:   map[string]*session.Session{},
		connecting: map[string]chan struct{}{},
		keys:       map[int]*[32]byte{},
	}, nil
}

// Open dials the native endpoint of one node and opens a stream to the target.
func (n *Native) Open(ctx context.Context, node Node, plane json.RawMessage, target Target) (Conn, error) {
	var endpoint struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	}
	if err := json.Unmarshal(plane, &endpoint); err != nil || endpoint.Host == "" || endpoint.Port == 0 {
		return nil, errors.New("pool: native plane has no usable endpoint")
	}
	s, err := n.session(ctx, node.Slot, endpoint.Host, endpoint.Port)
	if err != nil {
		return nil, err
	}
	stream, err := s.OpenStream(ctx, session.Target{Host: target.Host, Port: target.Port})
	if err != nil {
		// A stream failure is usually about this one target — the exit could not reach it, or the open
		// timed out — and must not cost every other stream its session. Only a dead session does that,
		// and a dead session reports itself through SetOnClose.
		if isSessionFailure(err) {
			n.drop(node.Slot, endpoint.Host, endpoint.Port, s)
		}
		return nil, err
	}
	return stream, nil
}

// Close tears every session down.
func (n *Native) Close() {
	n.mu.Lock()
	sessions := make([]*session.Session, 0, len(n.sessions))
	for _, s := range n.sessions {
		sessions = append(sessions, s)
	}
	n.sessions = map[string]*session.Session{}
	n.mu.Unlock()
	for _, s := range sessions {
		s.Close()
	}
}

// session returns the live session to a node's endpoint, connecting it once. The handshake runs outside
// the lock: it goes to the network, and holding the lock across it would queue every other stream
// behind one slow or black-holed node.
func (n *Native) session(ctx context.Context, slot int, host string, port int) (*session.Session, error) {
	key := net.JoinHostPort(host, strconv.Itoa(port))
	for {
		n.mu.Lock()
		if s := n.sessions[key]; s != nil {
			n.mu.Unlock()
			return s, nil
		}
		if pending, ok := n.connecting[key]; ok {
			n.mu.Unlock()
			select {
			case <-pending:
				continue // the other caller either connected it or failed; look again
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		pending := make(chan struct{})
		n.connecting[key] = pending
		n.mu.Unlock()

		boxKey, err := n.boxKey(slot)
		var s *session.Session
		if err == nil {
			s, err = session.Connect(ctx, host, port, boxKey)
		}

		n.mu.Lock()
		delete(n.connecting, key)
		if err == nil {
			s.SetOnClose(func() { n.drop(slot, host, port, s) })
			n.sessions[key] = s
		}
		n.mu.Unlock()
		close(pending)

		if err != nil {
			return nil, err
		}
		return s, nil
	}
}

// boxKey derives (once) the box key of a slot.
func (n *Native) boxKey(slot int) (*[32]byte, error) {
	n.mu.Lock()
	if key := n.keys[slot]; key != nil {
		n.mu.Unlock()
		return key, nil
	}
	n.mu.Unlock()

	key, err := proto.SlotBoxKey(n.psk, slot)
	if err != nil {
		return nil, err
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if existing := n.keys[slot]; existing != nil {
		return existing, nil
	}
	n.keys[slot] = &key
	return &key, nil
}

func (n *Native) drop(slot int, host string, port int, s *session.Session) {
	key := net.JoinHostPort(host, strconv.Itoa(port))
	n.mu.Lock()
	known := n.sessions[key]
	if known == s {
		delete(n.sessions, key)
	}
	n.mu.Unlock()
	if known == s {
		s.Close()
	}
}

// isSessionFailure tells a dead session apart from a refused stream.
func isSessionFailure(err error) bool {
	if errors.Is(err, session.ErrSessionClosed) || errors.Is(err, net.ErrClosed) || errors.Is(err, io.EOF) {
		return true
	}
	// a write to a socket the peer has reset or closed surfaces as a net operation error
	var opErr *net.OpError
	return errors.As(err, &opErr)
}
