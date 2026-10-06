package mgbox

import (
	"context"
	"encoding/json"
	"errors"
	"magnetgate/core/peer"
	"sync"
)

var peerState struct {
	sync.Mutex
	host    *peer.Host
	cancel  context.CancelFunc
	network *mobilePeerNetwork
}

var peerInit sync.Mutex

func StartPeer(profile string, platform PeerPlatform) (string, error) {
	peerInit.Lock()
	defer peerInit.Unlock()
	peerState.Lock()
	existing := peerState.host
	peerState.Unlock()
	if existing != nil {
		return existing.JSON(), nil
	}
	if platform == nil {
		return "", errors.New("physical network adapter is required")
	}
	ctx, cancel := context.WithCancel(context.Background())
	// Consent is process scoped on Android, including a clean service restart.
	store, _, err := peer.OpenStore(profile)
	if err != nil {
		cancel()
		return "", err
	}
	policy := store.Policy()
	policy.Enabled = false
	if err = store.Save(policy); err != nil {
		cancel()
		return "", err
	}
	n := newMobilePeerNetwork(platform)
	host, err := peer.OpenHost(ctx, profile, n, n.link)
	if err != nil {
		cancel()
		return "", err
	}
	peerState.Lock()
	peerState.host, peerState.cancel, peerState.network = host, cancel, n
	peerState.Unlock()
	return host.JSON(), nil
}
func PeerStatus() string {
	peerState.Lock()
	defer peerState.Unlock()
	if peerState.host == nil {
		return `{"configured":false,"connected":false,"countries":[]}`
	}
	var status map[string]any
	json.Unmarshal([]byte(peerState.host.JSON()), &status)
	peerState.network.mu.Lock()
	if peerState.network.observed.IsValid() {
		status["nativeSource"] = peerState.network.observed.String()
	}
	peerState.network.mu.Unlock()
	value, _ := json.Marshal(status)
	return string(value)
}
func BeginPeer(token string) error {
	peerState.Lock()
	host := peerState.host
	peerState.Unlock()
	if host == nil || token == "" {
		return errors.New("peer guest is not initialized")
	}
	host.ActivateGuest(token)
	return nil
}
func ConnectPeer(country string, token string) (string, error) {
	peerState.Lock()
	host := peerState.host
	peerState.Unlock()
	if host == nil {
		return "", errors.New("peer service is not configured")
	}
	endpoint, err := host.Connect(country, 0, token)
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(endpoint)
	return string(b), err
}
func DisconnectPeer() {
	peerState.Lock()
	host := peerState.host
	peerState.Unlock()
	if host != nil {
		host.Disconnect()
	}
}
func StopPeer() {
	peerInit.Lock()
	defer peerInit.Unlock()
	peerState.Lock()
	host := peerState.host
	if host != nil {
		peerState.network.suspend()
		peerState.cancel()
		peerState.host = nil
		peerState.network = nil
	}
	peerState.Unlock()
	if host != nil {
		host.Close()
	}
}

// SetPeerPolicy is serialized with the synchronous physical-socket barrier.
func SetPeerPolicy(value string) error {
	peerState.Lock()
	defer peerState.Unlock()
	if peerState.host == nil {
		return errors.New("peer service is not configured")
	}
	var policy peer.Policy
	if len(value) > 4096 || json.Unmarshal([]byte(value), &policy) != nil {
		return errors.New("invalid sharing policy")
	}
	if err := policy.Validate(); err != nil {
		return err
	}
	peerState.network.suspend()
	if policy.Enabled {
		peerState.network.resume()
	}
	if err := peerState.host.SetPolicy(policy); err != nil {
		peerState.network.suspend()
		return err
	}
	return nil
}
func SuspendPeerExit() {
	peerState.Lock()
	defer peerState.Unlock()
	if peerState.host == nil {
		return
	}
	peerState.network.suspend()
	if peerState.host.Client != nil {
		peerState.host.Client.SuspendExit()
	}
}
func ResumePeerExit() {
	peerState.Lock()
	defer peerState.Unlock()
	if peerState.host != nil && peerState.host.Store.Policy().Enabled {
		peerState.network.resume()
	}
}
