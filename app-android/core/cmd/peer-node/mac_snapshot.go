package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
)

var macPhysicalName = regexp.MustCompile(`^(en|bridge|bond|vlan)[0-9]+$`)

func macPhysicalInterface(name string) bool { return macPhysicalName.MatchString(name) }

// Only IPv4 guest targets are supported. macOS keeps idle/system IPv6 utuns
// around: their existence alone says nothing about the IPv4 exit route.
func macRoutes(data []byte) (string, string, error) {
	if len(data) == 0 || len(data) > 1024*1024 {
		return "", "", errors.New("invalid macOS routing table size")
	}
	var rows []string
	device := ""
	columns := map[string]int{}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) == 0 || line == "Routing tables" || line == "Internet:" {
			continue
		}
		if f[0] == "Destination" {
			for i, name := range f {
				columns[name] = i
			}
			continue
		}
		for _, key := range []string{"Destination", "Gateway", "Flags", "Netif"} {
			if i, ok := columns[key]; !ok || i >= len(f) {
				return "", "", errors.New("unrecognized macOS routing table")
			}
		}
		dst, gateway, flags, iface := f[columns["Destination"]], f[columns["Gateway"]], f[columns["Flags"]], f[columns["Netif"]]
		if iface != "lo0" && !macPhysicalInterface(iface) {
			return "", "", errors.New("IPv4 route uses an unverified interface")
		}
		if !strings.Contains(flags, "U") {
			return "", "", errors.New("inactive macOS route")
		}
		if dst == "default" && !strings.Contains(flags, "I") {
			if device != "" && device != iface || !macPhysicalInterface(iface) {
				return "", "", errors.New("ambiguous macOS default route")
			}
			device = iface
		}
		// ARP/link-layer and protocol-cloned host entries change during ordinary
		// browsing. Inspect their interface first, then omit their cache lifetime.
		if strings.ContainsAny(flags, "LW") {
			continue
		}
		rows = append(rows, strings.Join([]string{dst, gateway, flags, iface}, " "))
	}
	if device == "" {
		return "", "", errors.New("no physical IPv4 default route")
	}
	sort.Strings(rows)
	return strings.Join(rows, "\n"), device, nil
}

func macDNS(data []byte) (string, error) {
	if len(data) == 0 || len(data) > 256*1024 {
		return "", errors.New("invalid macOS DNS configuration size")
	}
	var rows []string
	resolver, hasServer := false, false
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.Join(strings.Fields(line), " ")
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "DNS configuration") {
			rows = append(rows, line)
			resolver = false
			continue
		}
		if strings.HasPrefix(line, "resolver #") {
			rows = append(rows, line)
			resolver = true
			continue
		}
		if !resolver {
			return "", errors.New("unrecognized macOS DNS configuration")
		}
		key, value, ok := strings.Cut(line, " : ")
		if !ok {
			return "", errors.New("unrecognized macOS resolver field")
		}
		if strings.HasPrefix(key, "nameserver[") {
			ip, err := netip.ParseAddr(value)
			if err != nil {
				return "", errors.New("invalid macOS nameserver")
			}
			if !ip.Unmap().Is4() || ip.Zone() != "" {
				return "", errors.New("macOS IPv4 sharing requires IPv4 DNS servers")
			}
			hasServer = true
			// Loopback resolvers can belong to another VPN or a local proxy.
			if ip.IsLoopback() || ip.IsUnspecified() {
				return "", errors.New("local DNS proxy is not a verified physical resolver")
			}
		}
		if key == "if_index" {
			_, iface, ok := strings.Cut(value, " (")
			if !ok || !macPhysicalInterface(strings.TrimSuffix(iface, ")")) {
				return "", errors.New("DNS uses an unverified interface")
			}
		}
		// Reachability bits fluctuate independently of resolver configuration.
		if key != "reach" {
			rows = append(rows, line)
		}
	}
	if !hasServer {
		return "", errors.New("no physical DNS server")
	}
	return strings.Join(rows, "\n"), nil
}

func macNetworkSnapshot(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	routes, err := exec.CommandContext(ctx, "/usr/sbin/netstat", "-rn", "-f", "inet").Output()
	if err != nil {
		return "", errors.New("cannot inspect macOS IPv4 routes")
	}
	table, device, err := macRoutes(routes)
	if err != nil {
		return "", err
	}
	dns, err := exec.CommandContext(ctx, "/usr/sbin/scutil", "--dns").Output()
	if err != nil {
		return "", errors.New("cannot inspect macOS DNS")
	}
	resolvers, err := macDNS(dns)
	if err != nil {
		return "", err
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		return "", err
	}
	var rows []string
	found := false
	for _, iface := range interfaces {
		if !macPhysicalInterface(iface.Name) || iface.Flags&net.FlagUp == 0 {
			continue
		}
		if iface.Flags&net.FlagPointToPoint != 0 {
			return "", errors.New("physical interface is point-to-point")
		}
		addresses, err := iface.Addrs()
		if err != nil {
			return "", err
		}
		for _, addr := range addresses {
			p, err := netip.ParsePrefix(addr.String())
			if err == nil && p.Addr().Is4() {
				rows = append(rows, fmt.Sprintf("%s:%d:%s", iface.Name, iface.Index, p))
				if iface.Name == device {
					found = true
				}
			}
		}
	}
	if !found {
		return "", errors.New("default interface has no physical IPv4 address")
	}
	sort.Strings(rows)
	// Pure-Go resolver builds may use this file instead of the Dynamic Store.
	fallbackDNS, err := os.ReadFile("/etc/resolv.conf")
	if err != nil || len(fallbackDNS) > 65536 {
		return "", errors.New("cannot inspect fallback DNS")
	}
	if err := macFallbackDNS(fallbackDNS); err != nil {
		return "", err
	}
	return "mac-interface=" + device + "\n" + strings.Join(rows, "\n") + "\n" + table + "\n" + resolvers + "\n" + string(fallbackDNS), nil
}

func macFallbackDNS(data []byte) error {
	found := false
	for _, line := range strings.Split(string(data), "\n") {
		line, _, _ = strings.Cut(line, "#")
		line, _, _ = strings.Cut(line, ";")
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "nameserver" {
			continue
		}
		if len(fields) != 2 {
			return errors.New("invalid fallback nameserver")
		}
		ip, err := netip.ParseAddr(fields[1])
		if err != nil || !ip.Is4() || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
			return errors.New("fallback DNS is not a physical IPv4 resolver")
		}
		found = true
	}
	if !found {
		return errors.New("no fallback IPv4 DNS server")
	}
	return nil
}
