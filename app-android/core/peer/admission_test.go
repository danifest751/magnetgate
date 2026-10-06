package peer

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func enrollmentRequest(e *Enrollment, token, device string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "https://service/v1/enroll", strings.NewReader(`{"device":"`+device+`","exit":true,"principal":"attacker"}`))
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r)
	return w
}

func TestAdmissionRolesAndDeviceCapSurviveRestart(t *testing.T) {
	root, _ := NewIdentity()
	dir := t.TempDir()
	token := strings.Repeat("a", 32)
	accounts := []Account{{Token: token, Principal: "guest-account", Guest: true}}
	e, err := NewEnrollment(root.Key, accounts, dir)
	if err != nil {
		t.Fatal(err)
	}
	var first string
	for i := 0; i < 4; i++ {
		device, _ := NewIdentity()
		if i == 0 {
			first = device.Public()
		}
		reply := enrollmentRequest(e, token, device.Public())
		if reply.Code != 200 {
			t.Fatal(reply.Code, reply.Body.String())
		}
		var credential Credential
		if err := json.Unmarshal(reply.Body.Bytes(), &credential); err != nil {
			t.Fatal(err)
		}
		if credential.Claims.Exit || credential.Claims.Principal != "guest-account" {
			t.Fatal("client elevated its own role")
		}
	}
	e, err = NewEnrollment(root.Key, accounts, dir)
	if err != nil {
		t.Fatal(err)
	}
	fifth, _ := NewIdentity()
	if reply := enrollmentRequest(e, token, fifth.Public()); reply.Code != 429 || !strings.Contains(reply.Body.String(), "admission capacity") {
		t.Fatal("restart erased device cap", reply.Code)
	}
	if reply := enrollmentRequest(e, strings.Repeat("b", 32), first); reply.Code != 401 {
		t.Fatal("wrong account token admitted", reply.Code)
	}
	if reply := enrollmentRequest(e, token, first); reply.Code != 200 {
		t.Fatal("known device renewal rejected", reply.Code)
	}
}

func TestCommittedRevocationBlocksEnrollmentAfterRestart(t *testing.T) {
	root, _ := NewIdentity()
	device, _ := NewIdentity()
	dir := t.TempDir()
	service := NewService(root.Key, nil)
	if err := service.LoadRevocations(dir); err != nil {
		t.Fatal(err)
	}
	if err := service.Revoke(device.Public()); err != nil {
		t.Fatal(err)
	}
	service.Close()
	reopened := NewService(root.Key, nil)
	defer reopened.Close()
	if err := reopened.LoadRevocations(dir); err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("a", 32)
	e, err := NewEnrollment(root.Key, []Account{{Token: token, Principal: "account", Guest: true}}, dir)
	if err != nil {
		t.Fatal(err)
	}
	e.Denied = reopened.Denied
	if reply := enrollmentRequest(e, token, device.Public()); reply.Code != 403 {
		t.Fatal("revoked device obtained fresh admission", reply.Code)
	}
}

func TestRelayQuotaPersistsAndWriteFailureDeniesFurtherCharges(t *testing.T) {
	dir := t.TempDir()
	b, err := OpenRelayBudget(dir)
	if err != nil {
		t.Fatal(err)
	}
	b.ledger = relayLedger{Day: time.Now().UTC().Format("2006-01-02"), Total: (1 << 30) - 16, Principals: map[string]int64{"guest": (1 << 30) - 16}}
	if _, err := b.charge("guest", 16); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenRelayBudget(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.charge("guest", 1); err == nil {
		t.Fatal("restart/reconnect reset principal quota")
	}
	if _, err := reopened.charge("other", 16); err != nil {
		t.Fatal("unrelated principal lost allowance", err)
	}
	reopened.file = filepath.Join(dir, "missing-parent", "ledger.json")
	if _, err := reopened.charge("other", 16); err == nil {
		t.Fatal("failed persistence accepted bytes")
	}
	reopened.file = ""
	if _, err := reopened.charge("other", 1); err == nil {
		t.Fatal("failed ledger resumed without repair")
	}
}
