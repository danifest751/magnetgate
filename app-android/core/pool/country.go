package pool

import "strings"

// Country selection, mirroring app/countries.cjs, where the policy lives first.
//
// Choosing a country is a *preference*, never a restriction: if the chosen one has nothing live at this
// moment, everything is used instead and the caller is told. Refusing to carry traffic because the
// preferred country is temporarily gone would be a worse outcome than carrying it through the wrong
// one - the person asked for a tunnel, and they can see which exit answered.
//
// A code that is not two letters is no selection at all, which is how "any country" is spelled.

// CountryOf normalises a country code the way the desktop does: two letters, upper case, or empty.
func CountryOf(value string) string {
	code := strings.ToUpper(strings.TrimSpace(value))
	if len(code) != 2 {
		return ""
	}
	for i := 0; i < len(code); i++ {
		if code[i] < 'A' || code[i] > 'Z' {
			return ""
		}
	}
	return code
}

// CountrySelection is what a preference did to a candidate list.
type CountrySelection struct {
	Nodes []Node
	// Country is the preference that was applied, normalised; empty when there was none.
	Country string
	// Fallback says the preference was asked for and could not be honoured, so everything is in use.
	Fallback bool
}

// SelectCountry applies the preference to the nodes a pool would otherwise try.
func SelectCountry(nodes []Node, country string) CountrySelection {
	want := CountryOf(country)
	if want == "" {
		return CountrySelection{Nodes: nodes}
	}
	picked := make([]Node, 0, len(nodes))
	for _, node := range nodes {
		if node.Offer != nil && CountryOf(node.Offer.Country) == want {
			picked = append(picked, node)
		}
	}
	if len(picked) == 0 {
		return CountrySelection{Nodes: nodes, Country: want, Fallback: true}
	}
	return CountrySelection{Nodes: picked, Country: want}
}

// Countries is what the screens offer to choose from: the codes actually seen, with how many nodes
// stand behind each. Addresses are never part of it.
type Countries struct {
	Code  string `json:"cc"`
	Nodes int    `json:"nodes"`
}

// SeenCountries lists the countries of the nodes discovered so far, in code order.
func (p *Pool) SeenCountries() []Countries {
	counted := map[string]int{}
	for _, node := range p.Nodes() {
		if node.Offer == nil {
			continue
		}
		if code := CountryOf(node.Offer.Country); code != "" {
			counted[code]++
		}
	}
	out := make([]Countries, 0, len(counted))
	for code, nodes := range counted {
		out = append(out, Countries{Code: code, Nodes: nodes})
	}
	// sorted so that a list rendered twice never reorders itself under the user's finger
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Code < out[j-1].Code; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// SetCountry records which country the user prefers. Empty means any.
//
// It is a setter rather than a configuration field because changing it must not mean rebuilding the
// tunnel: the nodes are already discovered, the planes are already wired, and all that changes is which
// of them the next stream prefers.
func (p *Pool) SetCountry(country string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.country = CountryOf(country)
}

// Country is the preference in force, for diagnostics.
func (p *Pool) Country() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.country
}
