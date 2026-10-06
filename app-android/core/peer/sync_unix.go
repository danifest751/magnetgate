//go:build !windows

package peer

import "os"

func durableRename(from, to string) error { return os.Rename(from, to) }

func syncDirectory(path string) error {
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
