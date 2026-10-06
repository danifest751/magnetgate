package peer

import (
	"errors"
	"os"
	"path/filepath"
)

// Load before exposing the listener. Successfully persisted bans apply to
// control, pair and enrollment after restart. Revoke returns an error on a
// persistence failure and denies all live admission until operator recovery;
// that failure must not be reported as a committed ban.
func (s *Service) LoadRevocations(dir string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revocationFile = filepath.Join(dir, "revocations.json")
	if err := readJSON(s.revocationFile, &s.Revoked); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if s.Revoked == nil || len(s.Revoked) > 512 {
		return errors.New("invalid revocation ledger")
	}
	for device := range s.Revoked {
		if _, err := ParsePublic(device); err != nil {
			return err
		}
	}
	return nil
}
