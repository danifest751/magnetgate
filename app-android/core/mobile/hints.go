package mobile

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"magnetgate/core/pool"
)

type hintStore struct {
	mu          sync.Mutex
	path, group string
	latest      int64
}

type storedHint struct {
	Group string    `json:"group"`
	Hint  pool.Hint `json:"hint"`
}

func newHintStore(path, psk string) *hintStore {
	digest := sha256.Sum256([]byte(psk))
	return &hintStore{path: path, group: hex.EncodeToString(digest[:])}
}

func (s *hintStore) load() *pool.Hint {
	if s.path == "" {
		return nil
	}
	file, err := os.Open(s.path)
	if err != nil {
		return nil
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 1025))
	if err != nil || len(data) > 1024 {
		return nil
	}
	var stored storedHint
	if json.Unmarshal(data, &stored) != nil || stored.Group != s.group {
		return nil
	}
	age := time.Now().UnixMilli() - stored.Hint.GoodAt
	if age < 0 || age >= pool.HintTTL.Milliseconds() || len(stored.Hint.Fingerprint) != 64 {
		return nil
	}
	s.latest = stored.Hint.GoodAt
	return &stored.Hint
}

func (s *hintStore) save(hint pool.Hint) {
	if s.path == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if hint.GoodAt < s.latest {
		return
	}
	data, err := json.Marshal(storedHint{s.group, hint})
	if err != nil {
		return
	}
	file, err := os.CreateTemp(filepath.Dir(s.path), ".route-hint-*")
	if err != nil {
		return
	}
	temp := file.Name()
	defer os.Remove(temp)
	_, err = file.Write(data)
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return
	}
	if os.Rename(temp, s.path) == nil {
		s.latest = hint.GoodAt
	}
}
