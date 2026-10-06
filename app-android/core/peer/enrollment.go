package peer

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type Account struct {
	Token     string `json:"token"`
	Principal string `json:"principal"`
	Guest     bool   `json:"guest"`
	Exit      bool   `json:"exit"`
}
type Enrollment struct {
	mu       sync.Mutex
	key      ed25519.PrivateKey
	accounts []Account
	devices  map[string]string
	file     string
	limit    *rate.Limiter
	Denied   func(string) bool
}

func NewEnrollment(key ed25519.PrivateKey, accounts []Account, dir string) (*Enrollment, error) {
	e := &Enrollment{key: key, accounts: accounts, devices: map[string]string{}, limit: rate.NewLimiter(2, 4)}
	for _, a := range accounts {
		if len(a.Token) < 32 || a.Principal == "" || len(a.Principal) > 128 {
			return nil, errors.New("invalid service account")
		}
	}
	if dir != "" {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return nil, err
		}
		e.file = filepath.Join(dir, "admission.json")
		if err := readJSON(e.file, &e.devices); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if e.devices == nil || len(e.devices) > 128 {
			return nil, errors.New("invalid admission ledger")
		}
	}
	return e, nil
}

// Service accounts are provisioned by the trusted host, independently from VPN
// PSKs. The public API cannot invent a new principal or elevate its roles.
func (e *Enrollment) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" || !e.limit.Allow() {
		http.Error(w, "unavailable", 429)
		return
	}
	var account *Account
	for i := range e.accounts {
		if ConstantTimeSecret(r.Header.Get("Authorization"), e.accounts[i].Token) {
			account = &e.accounts[i]
			break
		}
	}
	if account == nil {
		http.Error(w, "unauthorized", 401)
		return
	}
	var request struct {
		Device string `json:"device"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if json.NewDecoder(r.Body).Decode(&request) != nil {
		http.Error(w, "invalid enrollment", 400)
		return
	}
	if _, err := ParsePublic(request.Device); err != nil {
		http.Error(w, "invalid device", 400)
		return
	}
	if e.Denied != nil && e.Denied(request.Device) {
		http.Error(w, "revoked device", 403)
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	principal, known := e.devices[request.Device]
	if known && principal != account.Principal {
		http.Error(w, "device account conflict", 403)
		return
	}
	if !known {
		count := 0
		for _, p := range e.devices {
			if p == account.Principal {
				count++
			}
		}
		if count >= 4 || len(e.devices) >= 128 {
			http.Error(w, "device admission capacity", 429)
			return
		}
		e.devices[request.Device] = account.Principal
		if e.file != "" {
			if err := atomicFile(e.file, e.devices); err != nil {
				delete(e.devices, request.Device)
				http.Error(w, "admission persistence failed", 503)
				return
			}
		}
	}
	c := IssueCredential(e.key, Claims{Device: request.Device, Principal: account.Principal, Guest: account.Guest, Exit: account.Exit, Expires: time.Now().Add(time.Hour).Unix()})
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(c)
}
func Enroll(ctx context.Context, service, token, device string, outer *tls.Config, dial ...func(context.Context, string, string) (net.Conn, error)) (Credential, error) {
	u, parseErr := url.Parse(service)
	if parseErr != nil || u.Scheme != "wss" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || len(token) < 32 || outer != nil && outer.InsecureSkipVerify {
		return Credential{}, errors.New("invalid trusted enrollment configuration")
	}
	b, _ := json.Marshal(struct {
		Device string `json:"device"`
	}{device})
	request, err := http.NewRequestWithContext(ctx, "POST", "https://"+strings.TrimPrefix(service, "wss://")+"/v1/enroll", strings.NewReader(string(b)))
	if err != nil {
		return Credential{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{TLSClientConfig: outer, Proxy: nil}
	if len(dial) > 0 {
		transport.DialContext = dial[0]
	}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("enrollment redirect forbidden") }}
	response, err := client.Do(request)
	if err != nil {
		return Credential{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return Credential{}, errors.New("service enrollment failed: " + response.Status)
	}
	var c Credential
	err = json.NewDecoder(http.MaxBytesReader(nil, response.Body, 4096)).Decode(&c)
	return c, err
}
