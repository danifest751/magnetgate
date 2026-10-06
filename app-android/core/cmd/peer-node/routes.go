package main

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

// RA lifetime decreases each second without changing the route. Preserve every
// routing field except that countdown, and compare rows independently of order.
func canonicalRoutes(b []byte) (string, error) {
	var routes []map[string]json.RawMessage
	if err := json.Unmarshal(b, &routes); err != nil {
		return "", err
	}
	rows := make([]string, 0, len(routes))
	foundDefault := false
	for _, route := range routes {
		var dst, dev string
		if err := json.Unmarshal(route["dst"], &dst); err != nil {
			return "", errors.New("missing route destination")
		}
		if err := json.Unmarshal(route["dev"], &dev); err != nil {
			return "", errors.New("missing route interface")
		}
		lower := strings.ToLower(dev)
		if strings.Contains(lower, "tun") || strings.Contains(lower, "tap") || strings.Contains(lower, "wireguard") || strings.Contains(lower, "vpn") || strings.HasPrefix(lower, "wg") || dst == "0.0.0.0/1" || dst == "128.0.0.0/1" {
			return "", errors.New("unverified physical routing table")
		}
		if dst == "default" {
			foundDefault = true
		}
		delete(route, "expires")
		row, err := json.Marshal(route)
		if err != nil {
			return "", err
		}
		rows = append(rows, string(row))
	}
	if !foundDefault {
		return "", errors.New("no default route")
	}
	sort.Strings(rows)
	return strings.Join(rows, "\n"), nil
}
