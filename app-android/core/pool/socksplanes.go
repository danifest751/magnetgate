package pool

import (
	"context"
	"encoding/json"
	"net"
	"strconv"
	"sync"

	"magnetgate/core/socks5client"
)

// SocksPlanes carries planes through local SOCKS listeners.
//
// This is how the app can use a transport it does not implement itself: sing-box (libbox) speaks reality
// and hysteria2, and for every node and plane it can expose a loopback SOCKS listener whose outbound is that
// node's plane. The core then treats such a plane exactly like any other - it only has to know which
// loopback port belongs to which node's plane.
//
// One value serves every plane type: Open learns the plane from the entry itself, so the same mapping
// answers for reality and for hysteria2.
type SocksPlanes struct {
	mu    sync.Mutex
	ports map[string]int
}

// NewSocksPlanes prepares an empty mapping.
func NewSocksPlanes() *SocksPlanes {
	return &SocksPlanes{ports: map[string]int{}}
}

// Set records the loopback port that carries one node's plane.
func (s *SocksPlanes) Set(slot int, plane string, port int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ports[key(slot, plane)] = port
}

// Forget drops everything known about a node, for when the engine is rebuilt.
func (s *SocksPlanes) Forget(slot int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prefix := strconv.Itoa(slot) + ":"
	for existing := range s.ports {
		if len(existing) > len(prefix) && existing[:len(prefix)] == prefix {
			delete(s.ports, existing)
		}
	}
}

// Open sends the stream to the node's plane through the engine.
func (s *SocksPlanes) Open(ctx context.Context, node Node, plane json.RawMessage, target Target) (Conn, error) {
	var entry struct {
		Type string `json:"t"`
	}
	if err := json.Unmarshal(plane, &entry); err != nil || entry.Type == "" {
		return nil, errUnknownPlane
	}
	s.mu.Lock()
	port, ok := s.ports[key(node.Slot, entry.Type)]
	s.mu.Unlock()
	if !ok {
		return nil, errUnknownPlane
	}
	stream, err := socks5client.Dial(ctx, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), target.Host, target.Port)
	if err != nil {
		return nil, err
	}
	return stream, nil
}

func key(slot int, plane string) string { return strconv.Itoa(slot) + ":" + plane }

type planeError string

func (e planeError) Error() string { return string(e) }

const errUnknownPlane = planeError("pool: this node's plane is not reachable through the engine")
