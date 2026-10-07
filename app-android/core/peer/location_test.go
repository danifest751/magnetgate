package peer

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestUnlocatedDualRoleGuestKeepsControlButCannotAdvertiseExit(t *testing.T) {
	root, _ := NewIdentity()
	service := NewService(root.Key, func(net.IP) (string, error) { return "", nil })
	defer service.Close()
	server := httptest.NewTLSServer(service.Handler())
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	id, _ := NewIdentity()
	client := &Client{Identity: id, URL: strings.Replace(server.URL, "https:", "wss:", 1),
		OuterTLS:   &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13},
		Credential: IssueCredential(root.Key, Claims{Device: id.Public(), Principal: "guest", Guest: true, Exit: true, Expires: time.Now().Add(time.Hour).Unix()})}
	ws, err := client.connect(context.Background(), "control")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	read := func(kind string) message {
		t.Helper()
		var m message
		ws.SetReadDeadline(time.Now().Add(2 * time.Second))
		if err := ws.ReadJSON(&m); err != nil {
			t.Fatal(kind, err)
		}
		if m.Type != kind {
			t.Fatalf("expected %s, got %+v", kind, m)
		}
		return m
	}
	read("authenticated")
	read("snapshot")
	for i := 0; i < 3; i++ {
		if err := ws.WriteJSON(message{Type: "heartbeat"}); err != nil {
			t.Fatal(err)
		}
		read("heartbeat")
	}
	if err := ws.WriteJSON(message{Type: "presence", Epoch: "epoch", Revision: 1, Slots: 2}); err != nil {
		t.Fatal(err)
	}
	if read("presence-ack").Ready {
		t.Fatal("withdrawn readiness acknowledged as READY")
	}
	if err := ws.WriteJSON(message{Type: "presence", Ready: true, Epoch: "epoch", Revision: 2, Slots: 2}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(read("error").Error, "location") {
		t.Fatal("unverified exit admission was not rejected")
	}
	snapshot, _, unsubscribe := service.Catalog.Subscribe(time.Now())
	unsubscribe()
	if len(snapshot.Nodes) != 0 {
		t.Fatal("unlocated device advertised as an exit")
	}
	if err := ws.WriteJSON(message{Type: "heartbeat"}); err != nil {
		t.Fatal(err)
	}
	read("heartbeat")
}

func TestVerifiedDualRoleControlClosesWhenLocationIsWithdrawn(t *testing.T) {
	root, _ := NewIdentity()
	var location atomic.Value
	location.Store("DE")
	service := NewService(root.Key, func(net.IP) (string, error) { return location.Load().(string), nil })
	defer service.Close()
	server := httptest.NewTLSServer(service.Handler())
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	id, _ := NewIdentity()
	client := &Client{Identity: id, URL: strings.Replace(server.URL, "https:", "wss:", 1),
		OuterTLS:   &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13},
		Credential: IssueCredential(root.Key, Claims{Device: id.Public(), Principal: "owner", Guest: true, Exit: true, Expires: time.Now().Add(time.Hour).Unix()})}
	ws, err := client.connect(context.Background(), "control")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	for i := 0; i < 2; i++ {
		var m message
		if err := ws.ReadJSON(&m); err != nil {
			t.Fatal(err)
		}
	}
	if err := ws.WriteJSON(message{Type: "presence", Ready: true, Epoch: "epoch", Revision: 1, Slots: 2}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		var m message
		if err := ws.ReadJSON(&m); err != nil {
			t.Fatal(err)
		}
		if m.Type == "presence-ack" && !m.Ready {
			t.Fatal("verified owner was not admitted")
		}
	}
	location.Store("")
	if err := ws.WriteJSON(message{Type: "heartbeat"}); err != nil {
		t.Fatal(err)
	}
	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		var m message
		err := ws.ReadJSON(&m)
		if err == nil {
			continue
		} // a final withdrawal snapshot may precede EOF
		if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
			t.Fatal("verified location withdrawal did not close its control")
		}
		break
	}
	snapshot, _, unsubscribe := service.Catalog.Subscribe(time.Now())
	unsubscribe()
	if len(snapshot.Nodes) != 0 {
		t.Fatal("withdrawn verified location remained advertised")
	}
}
