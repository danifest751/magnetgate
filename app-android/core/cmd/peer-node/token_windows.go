//go:build windows

package main

import (
	"errors"
	"runtime"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func tokenInformation(token windows.Token, class uint32) ([]byte, error) {
	var size uint32
	err := windows.GetTokenInformation(token, class, nil, 0, &size)
	if err != windows.ERROR_INSUFFICIENT_BUFFER || size == 0 || size > 1<<20 {
		return nil, errors.New("invalid token information size")
	}
	b := make([]byte, size)
	err = windows.GetTokenInformation(token, class, &b[0], size, &size)
	return b, err
}

func safeRestrictedToken(token windows.Token) bool {
	// Inspect actual access rights. IsTokenRestricted concerns restricting SID
	// lists, and CheckTokenMembership does not accept this primary token.
	groups, err := token.GetTokenGroups()
	if err != nil {
		return false
	}
	for _, group := range groups.AllGroups() {
		if !ordinaryGroup(group) && group.Attributes&windows.SE_GROUP_ENABLED != 0 {
			return false
		}
	}
	b, err := tokenInformation(token, windows.TokenIntegrityLevel)
	if err != nil {
		return false
	}
	sid := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&b[0])).Label.Sid
	if sid == nil {
		return false
	}
	level, known := strings.CutPrefix(sid.String(), "S-1-16-")
	rid, parseErr := strconv.ParseUint(level, 10, 32)
	if !known || parseErr != nil || rid > 0x2000 {
		return false
	}
	privileges, err := tokenInformation(token, windows.TokenPrivileges)
	if err != nil {
		return false
	}
	var changeNotify windows.LUID
	name, err := windows.UTF16PtrFromString("SeChangeNotifyPrivilege")
	if err != nil || windows.LookupPrivilegeValue(nil, name, &changeNotify) != nil {
		return false
	}
	for _, p := range (*windows.Tokenprivileges)(unsafe.Pointer(&privileges[0])).AllPrivileges() {
		// Even disabled administrative privileges must be removed, not re-enableable.
		if p.Luid != changeNotify {
			return false
		}
	}
	runtime.KeepAlive(b)
	runtime.KeepAlive(privileges)
	return true
}

// UAC-disabled hosts have no linked token. Keep the user's identity, remove
// administrative groups/privileges, and lower integrity before starting our child.
func restrictedUserToken() (windows.Token, error) {
	var original windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ALL_ACCESS, &original); err != nil {
		return 0, err
	}
	defer original.Close()
	groups, err := original.GetTokenGroups()
	if err != nil {
		return 0, err
	}
	var deny []windows.SIDAndAttributes
	for _, group := range groups.AllGroups() {
		if ordinaryGroup(group) {
			continue
		}
		deny = append(deny, group)
	}
	var denyPtr uintptr
	if len(deny) > 0 {
		denyPtr = uintptr(unsafe.Pointer(&deny[0]))
	}
	var restricted windows.Token
	proc := windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateRestrictedToken")
	r, _, callErr := proc.Call(uintptr(original), 5, uintptr(len(deny)), denyPtr, 0, 0, 0, 0, uintptr(unsafe.Pointer(&restricted)))
	runtime.KeepAlive(groups)
	runtime.KeepAlive(deny)
	if r == 0 {
		return 0, callErr
	}
	ok := false
	defer func() {
		if !ok {
			restricted.Close()
		}
	}()
	medium, err := windows.StringToSid("S-1-16-8192")
	if err != nil {
		return 0, err
	}
	label := windows.Tokenmandatorylabel{Label: windows.SIDAndAttributes{Sid: medium, Attributes: windows.SE_GROUP_INTEGRITY}}
	if err = windows.SetTokenInformation(restricted, windows.TokenIntegrityLevel, (*byte)(unsafe.Pointer(&label)), label.Size()); err != nil {
		return 0, err
	}
	if !safeRestrictedToken(restricted) {
		return 0, errors.New("restricted child token did not pass privilege checks")
	}
	ok = true
	return restricted, nil
}

func ordinaryGroup(group windows.SIDAndAttributes) bool {
	sid := group.Sid.String()
	return group.Attributes&windows.SE_GROUP_INTEGRITY != 0 || group.Attributes&windows.SE_GROUP_LOGON_ID == windows.SE_GROUP_LOGON_ID || sid == "S-1-1-0" || sid == "S-1-5-11" || sid == "S-1-5-32-545"
}
