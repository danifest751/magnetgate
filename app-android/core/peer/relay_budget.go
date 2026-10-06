package peer

import (
	"context"
	"errors"
	"golang.org/x/time/rate"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type relayLedger struct {
	Day        string           `json:"day"`
	Total      int64            `json:"total"`
	Principals map[string]int64 `json:"principals"`
}
type RelayBudget struct {
	mu       sync.Mutex
	file     string
	ledger   relayLedger
	global   *rate.Limiter
	accounts map[string]*rate.Limiter
	failed   bool
}

// Daily aggregate quotas survive reconnects and, with a path, service restarts.
// Production hosts must supply a private ledger path. An empty path is for
// ephemeral local tests only, with the same live caps.
func OpenRelayBudget(dir string) (*RelayBudget, error) {
	b := &RelayBudget{global: rate.NewLimiter(50*125000, 32768), accounts: map[string]*rate.Limiter{}, ledger: relayLedger{Principals: map[string]int64{}}}
	if dir != "" {
		if e := os.MkdirAll(dir, 0700); e != nil {
			return nil, e
		}
		b.file = filepath.Join(dir, "relay-usage.json")
		if e := readJSON(b.file, &b.ledger); e != nil && !errors.Is(e, os.ErrNotExist) {
			return nil, e
		}
	}
	if b.ledger.Total < 0 || len(b.ledger.Principals) > 128 {
		return nil, errors.New("invalid relay usage ledger")
	}
	for _, n := range b.ledger.Principals {
		if n < 0 {
			return nil, errors.New("invalid principal usage")
		}
	}
	if b.ledger.Principals == nil {
		b.ledger.Principals = map[string]int64{}
	}
	return b, nil
}
func (b *RelayBudget) charge(principal string, n int) (*rate.Limiter, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failed || principal == "" || len(principal) > 128 || n < 0 {
		return nil, errors.New("relay budget unavailable")
	}
	day := time.Now().UTC().Format("2006-01-02")
	if b.ledger.Day != day {
		b.ledger = relayLedger{day, 0, map[string]int64{}}
	}
	if _, ok := b.ledger.Principals[principal]; !ok && len(b.ledger.Principals) >= 128 {
		return nil, errors.New("principal admission capacity")
	}
	// Pilot caps: 1 GiB/day per service principal; 32 GiB/day for this relay.
	if int64(n) > (1<<30)-b.ledger.Principals[principal] || int64(n) > (32<<30)-b.ledger.Total {
		return nil, errors.New("relay daily budget exhausted")
	}
	b.ledger.Total += int64(n)
	b.ledger.Principals[principal] += int64(n)
	if b.file != "" {
		if e := atomicFile(b.file, b.ledger); e != nil {
			b.failed = true
			return nil, e
		}
	}
	l := b.accounts[principal]
	if l == nil {
		if len(b.accounts) >= 128 {
			return nil, errors.New("relay rate admission capacity")
		}
		l = rate.NewLimiter(5*125000, 32768)
		b.accounts[principal] = l
	}
	return l, nil
}
func (b *RelayBudget) copy(ctx context.Context, dst io.Writer, src io.Reader, principal string) error {
	buffer := make([]byte, 16*1024)
	for {
		n, e := src.Read(buffer)
		if n > 0 {
			l, err := b.charge(principal, n)
			if err != nil {
				return err
			}
			if err = b.global.WaitN(ctx, n); err != nil {
				return err
			}
			if err = l.WaitN(ctx, n); err != nil {
				return err
			}
			written, err := dst.Write(buffer[:n])
			if err != nil {
				return err
			}
			if written != n {
				return io.ErrShortWrite
			}
		}
		if e != nil {
			return e
		}
	}
}
