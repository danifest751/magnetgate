//go:build windows

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"net"
	"os"
	"os/exec"
	"sort"
	"strings"
	"syscall"
	"unsafe"
)

func dropPrivileges(child bool) (bool, error) {
	token := windows.GetCurrentProcessToken()
	if child {
		if token.IsElevated() && !safeRestrictedToken(token) {
			return true, errors.New("peer host still has elevated privileges")
		}
		return false, nil
	}
	if !token.IsElevated() {
		return false, nil
	}
	limited, err := token.GetLinkedToken()
	if err != nil {
		limited, err = restrictedUserToken()
		if err != nil {
			return true, errors.New("cannot obtain unprivileged peer host token: " + err.Error())
		}
	}
	defer limited.Close()
	if limited.IsElevated() && !safeRestrictedToken(limited) {
		return true, errors.New("linked token is elevated")
	}
	executable, err := os.Executable()
	if err != nil {
		return true, err
	}
	args := append(append([]string{}, os.Args[1:]...), "--user-child")
	cmd := exec.Command(executable, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Token: syscall.Token(limited), HideWindow: true}
	return true, cmd.Run()
}
func networkSnapshot(ctx context.Context) (string, error) {
	interfaces, err := interfaceSnapshot()
	if err != nil {
		return "", err
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	var size uint32
	proc := windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetIpForwardTable")
	r, _, _ := proc.Call(0, uintptr(unsafe.Pointer(&size)), 0)
	if r != 122 || size < 4 || size > 1<<20 {
		return "", errors.New("invalid route table size")
	}
	b := make([]byte, size)
	r, _, _ = proc.Call(uintptr(unsafe.Pointer(&b[0])), uintptr(unsafe.Pointer(&size)), 0)
	if r != 0 {
		return "", fmt.Errorf("GetIpForwardTable failed: %d", r)
	}
	count := binary.LittleEndian.Uint32(b[:4])
	if uint64(count)*56+4 > uint64(len(b)) {
		return "", errors.New("invalid route table")
	}
	var rows []string
	foundDefault := false
	for i := uint32(0); i < count; i++ {
		row := b[4+i*56 : 4+(i+1)*56]
		dest := net.IP(row[0:4]).String()
		mask := net.IP(row[4:8]).String()
		if mask == "128.0.0.0" && (dest == "0.0.0.0" || dest == "128.0.0.0") {
			return "", errors.New("split tunnel route")
		}
		if dest == "0.0.0.0" && mask == "0.0.0.0" {
			foundDefault = true
		}
		rows = append(rows, fmt.Sprintf("%s/%s:%s:%d:%d", dest, mask, net.IP(row[12:16]), binary.LittleEndian.Uint32(row[16:20]), binary.LittleEndian.Uint32(row[36:40])))
	}
	if !foundDefault {
		return "", errors.New("no default route")
	}
	sort.Strings(rows)
	dns, err := dnsSnapshot()
	if err != nil {
		return "", err
	}
	return interfaces + "\n" + strings.Join(rows, "\n") + "\n" + dns, nil
}

func dnsSnapshot() (string, error) {
	size := uint32(16384)
	for attempt := 0; attempt < 3; attempt++ {
		if size > 1<<20 {
			return "", errors.New("invalid adapter buffer")
		}
		buffer := make([]byte, size)
		first := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buffer[0]))
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, 0, 0, first, &size)
		if err == windows.ERROR_BUFFER_OVERFLOW {
			continue
		}
		if err != nil {
			return "", err
		}
		var rows []string
		for adapter := first; adapter != nil; adapter = adapter.Next {
			if adapter.OperStatus != 1 {
				continue
			}
			for dns := adapter.FirstDnsServerAddress; dns != nil; dns = dns.Next {
				rows = append(rows, fmt.Sprintf("%d:%s", adapter.IfIndex, dns.Address.IP()))
			}
		}
		sort.Strings(rows)
		return strings.Join(rows, "\n"), nil
	}
	return "", errors.New("DNS adapter table changed repeatedly")
}
