package peer

import (
	"testing"
	"time"
)

func TestLeaseAllowsBoundedClockSkewButRejectsLongOrWrongGrants(t *testing.T) {
	ticket := Ticket{ID: "session", Guest: "guest", Exit: "owner", Epoch: "epoch", Country: "FI"}
	credential := Credential{Claims: Claims{Expires: time.Now().Add(time.Hour).Unix()}}
	lease := SessionLease{Version, Audience, ticket.ID, ticket.Guest, ticket.Exit, ticket.Epoch, ticket.Country, time.Now().Add(61 * time.Second).UnixMilli(), 32, true}
	if err := validLease(lease, ticket, credential); err != nil {
		t.Fatal("normal clock skew rejected", err)
	}
	lease.Expires = time.Now().Add(66 * time.Second).UnixMilli()
	if validLease(lease, ticket, credential) == nil {
		t.Fatal("overlong grant admitted")
	}
	lease.Expires = time.Now().Add(30 * time.Second).UnixMilli()
	lease.Country = "NL"
	if validLease(lease, ticket, credential) == nil {
		t.Fatal("wrong country admitted")
	}
	lease.Country = "FI"
	lease.Expires = time.Now().Add(-time.Second).UnixMilli()
	if validLease(lease, ticket, credential) == nil {
		t.Fatal("expired grant admitted")
	}
}
