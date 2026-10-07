//go:build !windows

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
)

func dropPrivileges(bool) (bool, error) {
	if os.Geteuid() == 0 {
		return true, errors.New("peer host must run as an unprivileged user")
	}
	return false, nil
}
func networkSnapshot(ctx context.Context) (string, error) {
	if runtime.GOOS == "darwin" {
		return macNetworkSnapshot(ctx)
	}
	interfaces, err := interfaceSnapshot()
	if err != nil {
		return "", err
	}
	if runtime.GOOS != "linux" {
		return "", errors.New("unsupported exit platform")
	}
	b, err := exec.CommandContext(ctx, "ip", "-j", "route", "show", "table", "all").Output()
	if err != nil {
		return "", err
	}
	text, err := canonicalRoutes(b)
	if err != nil {
		return "", err
	}
	dns, err := os.ReadFile("/etc/resolv.conf")
	if err != nil {
		return "", err
	}
	return interfaces + "\n" + text + "\n" + string(dns), nil
}
