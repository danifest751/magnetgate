package main

import "testing"

func TestRouteLifetimeDoesNotWithdrawPhysicalNetwork(t *testing.T) {
	a, err := canonicalRoutes([]byte(`[{"dst":"default","dev":"ens18","gateway":"fe80::1","expires":1800},{"dst":"10.0.0.0/24","dev":"ens18"}]`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := canonicalRoutes([]byte(`[{"dev":"ens18","dst":"10.0.0.0/24"},{"gateway":"fe80::1","dev":"ens18","expires":1799,"dst":"default"}]`))
	if err != nil || a != b {
		t.Fatal("lifetime/order incorrectly changes generation", err)
	}
	changed, _ := canonicalRoutes([]byte(`[{"dst":"default","dev":"ens18","gateway":"fe80::2"},{"dst":"10.0.0.0/24","dev":"ens18"}]`))
	if changed == a {
		t.Fatal("gateway change ignored")
	}
	for _, input := range []string{`[]`, `[{"dst":"default","dev":"tun0"}]`, `[{"dst":"0.0.0.0/1","dev":"ens18"}]`, `invalid`} {
		if _, err := canonicalRoutes([]byte(input)); err == nil {
			t.Fatal("unsafe routes accepted", input)
		}
	}
}
