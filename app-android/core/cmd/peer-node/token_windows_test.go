//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func TestRestrictedWindowsChildCannotWriteSystemSettings(t *testing.T) {
	if os.Getenv("MAGNETGATE_TOKEN_TEST_CHILD") == "1" {
		token := windows.GetCurrentProcessToken()
		if !safeRestrictedToken(token) {
			t.Fatal("child privileges are unsafe")
		}
		handled, err := dropPrivileges(true)
		if handled || err != nil {
			t.Fatal("restricted child refused", err)
		}
		key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE`, registry.SET_VALUE)
		if err == nil {
			key.Close()
			t.Fatal("child can write machine-wide settings")
		}
		if err != windows.ERROR_ACCESS_DENIED {
			t.Fatal("unexpected system access error", err)
		}
		return
	}
	token, err := restrictedUserToken()
	if err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	child := exec.Command(os.Args[0], "-test.run=^TestRestrictedWindowsChildCannotWriteSystemSettings$", "-test.v")
	child.Env = append(os.Environ(), "MAGNETGATE_TOKEN_TEST_CHILD=1")
	child.SysProcAttr = &syscall.SysProcAttr{Token: syscall.Token(token), HideWindow: true}
	if out, err := child.CombinedOutput(); err != nil {
		t.Fatalf("restricted child failed: %v\n%s", err, out)
	}
}
