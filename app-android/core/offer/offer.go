// Package offer holds the rendezvous-offer policy: merging the two channels, picking a data plane and
// learning further slots from `peers`. It mirrors src/offer.mjs and is pure, so it can be tested
// against the tracked vectors without a network or a DHT.
package offer

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Schema is the offer schema version (OFFER_SCHEMA in src/common.mjs).
const Schema = 3

// Peer is one entry of the `peers` list a node advertises.
type Peer struct {
	Slot int   `json:"slot"`
	TS   int64 `json:"ts"`
}

// Offer is one rendezvous record. Data-plane entries are kept raw: the transport builder needs their
// protocol-specific fields (Reality keys, hysteria2 cert), and this layer only cares about their type.
// RuleSets is the manifest an exit advertises: a generation, and one entry per list.
type RuleSets struct {
	V    int           `json:"v"`
	Sets []RuleSetItem `json:"sets"`
}

// RuleSetItem names one list: where it lives, how large it is and what it must hash to. The checksum is
// the whole control - the file itself is fetched from wherever Url points, so a mirror that serves
// something else fails verification instead of quietly changing what bypasses the tunnel.
type RuleSetItem struct {
	Tag    string `json:"tag"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Bytes  int    `json:"bytes"`
}

// Update is the build an exit says a client should be running: a version, where the package lives and
// what it must hash to.
//
// It is the most dangerous field in this record, because acting on it means installing code. Four
// things have to hold before anything is installed, and the manifest is only the first:
//
//  1. this manifest travelled inside the sealed offer, so only the holder of the group key wrote it;
//  2. the package is verified against SHA256 after download - the URL is untrusted, exactly as it is
//     for a rule-set, and a mirror serving something else fails here;
//  3. Android refuses a package whose signing key differs from the installed one, which no attacker
//     without the release key can satisfy;
//  4. the person taps "install" in the system dialog, because nothing here installs silently.
//
// VersionCode is what decides whether an update exists at all: it is Android's own monotonic counter,
// and a manifest offering a code at or below the installed one is not an update but a downgrade.
type Update struct {
	V           int    `json:"v"`
	VersionCode int    `json:"vc"`
	VersionName string `json:"vn"`
	URL         string `json:"url"`
	SHA256      string `json:"sha256"`
	Bytes       int    `json:"bytes"`
}

// MaxUpdateBytes caps what a device may be asked to download for an update. The release is some 85 MB;
// a manifest claiming much more than that is not describing this application.
const MaxUpdateBytes = 256 << 20

// Valid reports whether an update manifest is usable at all. It does not say the update should be
// installed - that needs the installed version, which only the client knows.
func (u *Update) Valid() bool {
	if u == nil || u.V < 1 || u.VersionCode < 1 || u.VersionName == "" {
		return false
	}
	// https is preferred and http is allowed, which deserves saying out loud. What protects this
	// download is not the transport: it is the digest, which travelled sealed under the group key, and
	// Android's refusal to install a package signed with another key. TLS would add confidentiality
	// only - and the request already travels inside this client's own tunnel, so the only stretch it
	// would cover is between the exit and the host. The nodes that serve these packages have no domain
	// and therefore no certificate anyone would trust; refusing http would mean no updates at all,
	// which is the worse answer. With a domain, this becomes https-only again by deleting one branch.
	scheme := strings.HasPrefix(u.URL, "https://") || strings.HasPrefix(u.URL, "http://")
	if !scheme || u.Bytes <= 0 || u.Bytes > MaxUpdateBytes {
		return false
	}
	if len(u.SHA256) != 64 {
		return false
	}
	for _, c := range u.SHA256 {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// MaxRuleSetBytes caps what a device may be asked to download. A rule-set is a compact binary; anything
// larger is not one, whatever the manifest claims.
const MaxRuleSetBytes = 8 << 20

// Valid reports whether a manifest is usable: a generation, at least one entry, and every entry naming
// an https source with a real digest and a plausible size.
func (r *RuleSets) Valid() bool {
	if r == nil || r.V < 1 || len(r.Sets) == 0 {
		return false
	}
	for _, s := range r.Sets {
		if s.Tag == "" || !strings.HasPrefix(s.URL, "https://") || s.Bytes <= 0 || s.Bytes > MaxRuleSetBytes {
			return false
		}
		if len(s.SHA256) != 64 {
			return false
		}
		for _, c := range s.SHA256 {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				return false
			}
		}
	}
	return true
}

type Offer struct {
	V       int               `json:"v"`
	TS      int64             `json:"ts"`
	Slot    *int              `json:"slot,omitempty"`
	Node    string            `json:"node,omitempty"`
	Country string            `json:"country,omitempty"`
	Peers   []Peer            `json:"peers,omitempty"`
	DP      []json.RawMessage `json:"dp"`
	// RuleSets: which routing lists a client should be using, and what each must hash to. It travels on
	// the Nostr view only, like the pinned hysteria2 certificate, because it does not fit a BEP44
	// record. Nothing here is a list - only the operator's signed decision about which ones are current.
	RuleSets *RuleSets `json:"rs,omitempty"`
	// Update is the build this exit says clients should be running; see Update.
	Update *Update `json:"up,omitempty"`
	// Reports is where a client may send a report when it breaks, or empty. One string and nothing
	// else: what may go into a report is decided by the client, not by whoever publishes this.
	Reports string `json:"rep,omitempty"`
}

// Valid mirrors the validation mergeOffer() performs: a usable v3 offer carrying a timestamp and a
// data-plane list. A zero timestamp is rejected because a real offer always has one (milliseconds).
func (o *Offer) Valid() bool {
	return o != nil && o.V == Schema && o.TS > 0 && o.DP != nil
}

// TypeOf is the data-plane type of a raw entry ("reality", "hy2", "mgt"), or "" when unreadable.
func TypeOf(raw json.RawMessage) string {
	var head struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return ""
	}
	return head.T
}

// Types lists the data-plane types the offer carries, in order.
func (o *Offer) Types() []string {
	if o == nil {
		return nil
	}
	out := make([]string, 0, len(o.DP))
	for _, raw := range o.DP {
		if t := TypeOf(raw); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// Pick returns the most preferred data-plane entry this client can use, in `pref` order.
func (o *Offer) Pick(pref []string) json.RawMessage {
	if o == nil {
		return nil
	}
	for _, want := range pref {
		for _, raw := range o.DP {
			if TypeOf(raw) == want {
				return raw
			}
		}
	}
	return nil
}

// Merge folds an incoming offer into the one currently held:
//   - a newer generation (larger ts) replaces outright;
//   - the same generation unions the data planes by type, so the hysteria2 entry that only the Nostr
//     channel carries survives the compact DHT offer (and vice versa) instead of being clobbered by
//     whichever channel happens to arrive last;
//   - an older generation is kept as-is.
//
// Returns the offer to hold, or nil when `incoming` is not a usable offer (the caller keeps `prev`).
func Merge(prev, incoming *Offer) *Offer {
	if !incoming.Valid() {
		return nil
	}
	if prev == nil || !prev.Valid() || incoming.TS > prev.TS {
		merged := *incoming
		merged.DP = append([]json.RawMessage(nil), incoming.DP...)
		return &merged
	}
	if incoming.TS < prev.TS {
		return prev
	}
	byType := make(map[string]json.RawMessage, len(prev.DP)+len(incoming.DP))
	order := make([]string, 0, len(prev.DP)+len(incoming.DP))
	for _, raw := range prev.DP {
		t := TypeOf(raw)
		if _, seen := byType[t]; !seen {
			order = append(order, t)
		}
		byType[t] = raw
	}
	for _, raw := range incoming.DP {
		t := TypeOf(raw)
		if _, seen := byType[t]; !seen {
			order = append(order, t)
		}
		byType[t] = raw
	}
	merged := *prev
	merged.DP = make([]json.RawMessage, 0, len(order))
	for _, t := range order {
		merged.DP = append(merged.DP, byType[t])
	}
	// The rule-set manifest travels on the Nostr view alone, exactly like the pinned hysteria2 endpoint
	// two lines above. Starting the merge from prev would therefore drop it whenever the DHT view of the
	// same generation arrived first - which is the ordinary case, since DHT is polled and Nostr pushed.
	// Whichever side of this generation actually carries one wins.
	if incoming.RuleSets.Valid() {
		merged.RuleSets = incoming.RuleSets
	} else if prev.RuleSets.Valid() {
		merged.RuleSets = prev.RuleSets
	} else {
		merged.RuleSets = nil
	}
	// The report sink travels the same way and needs the same rule.
	if incoming.Reports != "" {
		merged.Reports = incoming.Reports
	} else if prev.Reports != "" {
		merged.Reports = prev.Reports
	} else {
		merged.Reports = ""
	}
	// And the update manifest, for exactly the same reason and by exactly the same rule. It was added
	// without this and the phone saw no update at all: the DHT view of a generation arrives first, the
	// merge started from it, and the field the Nostr view carried was dropped in silence. The comment
	// above was already there; copying the field without copying the rule is how this trap catches you
	// twice.
	if incoming.Update.Valid() {
		merged.Update = incoming.Update
	} else if prev.Update.Valid() {
		merged.Update = prev.Update
	} else {
		merged.Update = nil
	}
	return &merged
}

// ParsePeers decodes the `peers` list of an offer.
//
// An entry is honoured only when it carries a real integer slot: a missing or null slot is skipped
// rather than read as 0 — `Number(null)` is 0 in JavaScript, and silently opting into "slot 0" is
// exactly the silent default the slot validation exists to prevent. The Node side follows the same
// rule (src/offer.mjs). A non-integer value makes the whole list invalid, and the caller logs and
// ignores it rather than trusting a list it only partly understood.
func ParsePeers(raw json.RawMessage) ([]Peer, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var entries []struct {
		Slot json.RawMessage `json:"slot"`
		TS   int64           `json:"ts"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, err
	}
	out := make([]Peer, 0, len(entries))
	for _, entry := range entries {
		slotJSON := strings.TrimSpace(string(entry.Slot))
		if slotJSON == "" || slotJSON == "null" {
			continue // missing or null: skipped, never read as 0
		}
		// only a JSON number counts: a quoted number, bool, object or array is a malformed list, and a
		// list only partly understood is worse than no list at all
		if slotJSON[0] != '-' && (slotJSON[0] < '0' || slotJSON[0] > '9') {
			return nil, fmt.Errorf("peer slot is not a number: %s", slotJSON)
		}
		slot, err := json.Number(slotJSON).Int64()
		if err != nil {
			return nil, fmt.Errorf("peer slot is not an integer: %s", slotJSON)
		}
		out = append(out, Peer{Slot: int(slot), TS: entry.TS})
	}
	return out, nil
}

// NewPeerSlots answers which slots a client should start polling because a node advertised them in
// `peers`: in range, not already known, sorted and deduplicated. A node holding the PSK can advertise
// any slot, so the caller decides what to do with the answer and logs it.
func NewPeerSlots(known []int, peers []Peer, maxSlots int) []int {
	seen := make(map[int]bool, len(known)+len(peers))
	for _, slot := range known {
		seen[slot] = true
	}
	found := make([]int, 0, len(peers))
	for _, peer := range peers {
		if peer.Slot < 0 || peer.Slot >= maxSlots || seen[peer.Slot] {
			continue
		}
		seen[peer.Slot] = true
		found = append(found, peer.Slot)
	}
	sort.Ints(found)
	return found
}
