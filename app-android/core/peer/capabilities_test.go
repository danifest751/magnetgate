package peer

import "testing"

type guestOnlyNetwork struct{ Network }

func (guestOnlyNetwork) CanShare() bool { return false }

func TestSharingRequiresExitRoleAndPlatformSupport(t *testing.T) {
	store, _, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{Store: store, Credential: Credential{Claims: Claims{Guest: true}}}
	policy := DefaultPolicy()
	policy.Enabled = true
	if client.CanShare() || client.SetPolicy(policy) == nil || store.Policy().Enabled {
		t.Fatal("guest credential enabled sharing")
	}
	client.Credential.Claims.Exit = true
	client.Network = guestOnlyNetwork{}
	if client.CanShare() || client.SetPolicy(policy) == nil || store.Policy().Enabled {
		t.Fatal("unsupported platform enabled sharing")
	}
}
