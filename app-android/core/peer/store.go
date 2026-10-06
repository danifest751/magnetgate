package peer

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Policy struct {
	Enabled      bool    `json:"enabled"`
	Automatic    bool    `json:"automatic"`
	MaxMbps      float64 `json:"maxMbps"`
	MaxGuests    int     `json:"maxGuests"`
	DailyBytes   int64   `json:"dailyBytes"`
	MonthlyBytes int64   `json:"monthlyBytes"`
}

func DefaultPolicy() Policy {
	return Policy{Automatic: true, MaxMbps: 5, MaxGuests: 2, DailyBytes: 1 << 30, MonthlyBytes: 20 << 30}
}
func (p Policy) Validate() error {
	if math.IsNaN(p.MaxMbps) || math.IsInf(p.MaxMbps, 0) || p.MaxMbps < 0.1 || p.MaxMbps > 5 || p.MaxGuests < 1 || p.MaxGuests > 2 || p.DailyBytes < 65536 || p.MonthlyBytes < p.DailyBytes {
		return errors.New("invalid sharing limits (pilot: 0.1–5 Mbps, 1–2 guests)")
	}
	return nil
}

type usage struct {
	Day     string `json:"day"`
	Month   string `json:"month"`
	Daily   int64  `json:"daily"`
	Monthly int64  `json:"monthly"`
}
type Store struct {
	mu     sync.Mutex
	dir    string
	policy Policy
	usage  usage
	active bool
}

// atomicFile never reuses a predictable temporary name and syncs before
// replacement. The dirty marker is a separate, durable crash interlock.
func atomicFile(path string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path+"."+randomID()+".tmp", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = durableRename(name, path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}
func readJSON(path string, v any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("peer state must be a regular private file")
	}
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, v)
}
func OpenStore(dir string) (*Store, Identity, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, Identity{}, err
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, Identity{}, errors.New("peer profile must be a real private directory")
	}
	if err = protectDirectory(dir); err != nil {
		return nil, Identity{}, err
	}
	s := &Store{dir: dir, policy: DefaultPolicy()}
	var seed string
	err = readJSON(filepath.Join(dir, "identity.json"), &seed)
	if errors.Is(err, os.ErrNotExist) {
		i, e := NewIdentity()
		if e != nil {
			return nil, i, e
		}
		seed = hex.EncodeToString(i.Key.Seed())
		err = atomicFile(filepath.Join(dir, "identity.json"), seed)
	}
	if err != nil {
		return nil, Identity{}, err
	}
	b, err := hex.DecodeString(seed)
	if err != nil || len(b) != ed25519.SeedSize {
		return nil, Identity{}, errors.New("invalid stored peer identity")
	}
	i := Identity{ed25519.NewKeyFromSeed(b)}
	if err = readJSON(filepath.Join(dir, "policy.json"), &s.policy); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, i, err
	}
	if err = s.policy.Validate(); err != nil {
		return nil, i, err
	}
	if err = readJSON(filepath.Join(dir, "usage.json"), &s.usage); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, i, err
	}
	if s.usage.Daily < 0 || s.usage.Monthly < 0 {
		return nil, i, errors.New("invalid usage ledger")
	}
	if _, err = os.Stat(filepath.Join(dir, "unclean.json")); err == nil {
		s.policy.Enabled = false
		if err = atomicFile(filepath.Join(dir, "policy.json"), s.policy); err != nil {
			return nil, i, err
		}
		// Keep the marker until a new explicit safe policy write succeeds.
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, i, err
	}
	return s, i, nil
}
func (s *Store) Policy() Policy { s.mu.Lock(); defer s.mu.Unlock(); return s.policy }
func (s *Store) Available() bool {
	return s.available(time.Now().UTC())
}
func (s *Store) available(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active && s.policy.Enabled &&
		(s.usage.Day < now.Format("2006-01-02") || s.usage.Daily < s.policy.DailyBytes) &&
		(s.usage.Month < now.Format("2006-01") || s.usage.Monthly < s.policy.MonthlyBytes)
}
func (s *Store) Save(p Policy) error {
	if err := p.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := atomicFile(filepath.Join(s.dir, "policy.json"), p); err != nil {
		s.policy.Enabled = false
		return err
	}
	s.policy = p
	return nil
}
func (s *Store) Begin() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.policy.Enabled {
		return errors.New("sharing is disabled")
	}
	if err := atomicFile(filepath.Join(s.dir, "unclean.json"), time.Now().UTC()); err != nil {
		s.policy.Enabled = false
		return err
	}
	s.active = true
	return nil
}
func (s *Store) End() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active = false
	// Caller has already denied new sessions and closed every existing session.
	if err := atomicFile(filepath.Join(s.dir, "policy.json"), s.policy); err != nil {
		s.policy.Enabled = false
		return err
	}
	err := os.Remove(filepath.Join(s.dir, "unclean.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return syncDirectory(s.dir)
}

// Charge reserves bytes BEFORE accepting/forwarding them. A crash can overcount
// one 16 KiB copy chunk, but can never erase used quota or overshoot the cap.
func (s *Store) Charge(n int) error {
	return s.charge(n, time.Now().UTC())
}
func (s *Store) charge(n int, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.active || !s.policy.Enabled {
		return errors.New("sharing is stopped")
	}
	day, month := now.Format("2006-01-02"), now.Format("2006-01")
	u := s.usage
	if u.Day < day {
		u.Day = day
		u.Daily = 0
	}
	if u.Month < month {
		u.Month = month
		u.Monthly = 0
	}
	if n < 0 || int64(n) > s.policy.DailyBytes-u.Daily || int64(n) > s.policy.MonthlyBytes-u.Monthly {
		return errors.New("sharing traffic quota exhausted")
	}
	u.Daily += int64(n)
	u.Monthly += int64(n)
	if err := atomicFile(filepath.Join(s.dir, "usage.json"), u); err != nil {
		s.policy.Enabled = false
		return err
	}
	s.usage = u
	return nil
}

func (s *Store) Usage() (int64, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	daily, monthly := s.usage.Daily, s.usage.Monthly
	if s.usage.Day < now.Format("2006-01-02") {
		daily = 0
	}
	if s.usage.Month < now.Format("2006-01") {
		monthly = 0
	}
	return daily, monthly
}
