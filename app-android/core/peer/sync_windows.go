//go:build windows

package peer

import "golang.org/x/sys/windows"

func durableRename(from, to string) error {
	a, e := windows.UTF16PtrFromString(from)
	if e != nil {
		return e
	}
	b, e := windows.UTF16PtrFromString(to)
	if e != nil {
		return e
	}
	return windows.MoveFileEx(a, b, 0x1|0x8)
}

// MOVEFILE_WRITE_THROUGH above commits replacements on Windows. Directory Sync
// is not supported by os.File; a leftover marker after clean shutdown is safe.
func syncDirectory(string) error { return nil }
