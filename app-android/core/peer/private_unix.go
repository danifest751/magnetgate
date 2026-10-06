//go:build !windows

package peer

import "os"

func protectDirectory(dir string) error { return os.Chmod(dir, 0700) }
