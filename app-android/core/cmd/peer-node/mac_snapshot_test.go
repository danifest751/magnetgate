package main

import (
	"strings"
	"testing"
)

const macRouteFixture = `Routing tables

Internet:
Destination        Gateway            Flags        Netif Expire
default            192.168.1.1        UGScg          en0
127                127.0.0.1          UCS            lo0
192.168.1          link#6             UCS            en0
192.168.1.1        aa:bb:cc:dd:ee:ff   UHLWIir        en0 1199
`
const macDNSFixture = `DNS configuration

resolver #1
  search domain[0] : lan
  nameserver[0] : 192.168.1.1
  if_index : 6 (en0)
  flags : Request A records
  reach : 0x00000002 (Reachable)

resolver #2
  domain : local
  options : mdns
  timeout : 5
  flags : Request A records, Request AAAA records
  order : 300000

DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 192.168.1.1
  if_index : 6 (en0)
  flags : Scoped, Request A records
  reach : 0x00000002 (Reachable)
`

func TestMacRoutesPreservePhysicalGenerationAcrossCacheChanges(t *testing.T) {
	a, device, err := macRoutes([]byte(macRouteFixture))
	if err != nil || device != "en0" {
		t.Fatal(device, err)
	}
	b, _, err := macRoutes([]byte(strings.ReplaceAll(macRouteFixture, "1199", "1180") + "1.1.1.1 192.168.1.1 UGHW3 en0\n"))
	if err != nil || a != b {
		t.Fatal("ARP expiry or cloned flow invalidates physical network", err)
	}
	changed, _, err := macRoutes([]byte(strings.Replace(macRouteFixture, "192.168.1.1", "192.168.1.254", 1)))
	if err != nil || changed == a {
		t.Fatal("gateway change must invalidate generation", err)
	}
	changed, device, err = macRoutes([]byte(strings.ReplaceAll(macRouteFixture, "en0", "en1")))
	if err != nil || device != "en1" || changed == a {
		t.Fatal("Wi-Fi/Ethernet handover ignored", err)
	}
	// Older macOS output has mutable usage counters before Netif.
	_, device, err = macRoutes([]byte("Internet:\nDestination Gateway Flags Refs Use Netif Expire\ndefault 192.168.1.1 UGSc 4 123 en0\n"))
	if err != nil || device != "en0" {
		t.Fatal("column layout", err)
	}
}

func TestMacRoutesRejectVPNAndUnverifiableTables(t *testing.T) {
	for _, input := range []string{
		"", "not a routing table", "Destination Gateway Flags Netif\n",
		strings.ReplaceAll(macRouteFixture, "en0", "utun8"),
		macRouteFixture + "0/1 link#9 UCS utun8\n128/1 link#9 UCS utun8\n",
		macRouteFixture + "8.8.8.8 link#9 UHWI utun8 100\n",
		macRouteFixture + "10.8 link#9 UCS ppp0\n",
		strings.ReplaceAll(macRouteFixture, "en0", "unknown0"),
		macRouteFixture + "default 10.0.0.1 UGSc en1\n",
		"Destination Gateway Flags Netif\ndefault 192.168.1.1 GSc en0\n",
		macRouteFixture + "missing fields\n",
	} {
		if _, _, err := macRoutes([]byte(input)); err == nil {
			t.Fatalf("unsafe routes accepted: %q", input)
		}
	}
}

func TestMacDNSPreservesResolverSemantics(t *testing.T) {
	a, err := macDNS([]byte(macDNSFixture))
	if err != nil {
		t.Fatal(err)
	}
	b, err := macDNS([]byte(strings.ReplaceAll(macDNSFixture, "0x00000002 (Reachable)", "0x00000000 (Not Reachable)")))
	if err != nil || a != b {
		t.Fatal("reachability bits change generation", err)
	}
	for _, input := range []string{
		strings.ReplaceAll(macDNSFixture, "192.168.1.1", "192.168.1.254"),
		strings.ReplaceAll(macDNSFixture, "(en0)", "(en1)"),
		strings.Replace(macDNSFixture, "lan", "office", 1),
		macDNSFixture + "  nameserver[1] : 9.9.9.9\n",
	} {
		b, err := macDNS([]byte(input))
		if err != nil || a == b {
			t.Fatal("DNS change ignored", err)
		}
	}
	for _, input := range []string{"", "No DNS configuration available", "DNS configuration\nresolver #1\ndomain : local\n",
		strings.ReplaceAll(macDNSFixture, "(en0)", "(utun8)"),
		strings.ReplaceAll(macDNSFixture, "192.168.1.1", "127.0.0.1"),
		strings.ReplaceAll(macDNSFixture, "192.168.1.1", "::1"),
		strings.ReplaceAll(macDNSFixture, "192.168.1.1", "2001:4860:4860::8888"),
		strings.ReplaceAll(macDNSFixture, "192.168.1.1", "invalid"),
	} {
		if _, err := macDNS([]byte(input)); err == nil {
			t.Fatalf("unsafe DNS accepted: %q", input)
		}
	}
}
