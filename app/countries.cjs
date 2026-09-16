// Country selection for the desktop client.
//
// A node advertises a two-letter country code in its offer (MAGNETGATE_NODE_COUNTRY); the app lists
// the codes it can actually see and, when the user picks one, builds its engine configuration from
// that country's endpoints only. Addresses are never shown — the list is a code plus how many nodes
// stand behind it.
//
// Choosing a country is a *preference*: if the selected one has nothing live right now, everything is
// used instead and the caller is told, because refusing to connect is worse than connecting through
// the wrong country. If neither the selection nor any country is known (a single old exit, say), the
// list is empty and the UI hides the control.
//
// Pure and side-effect-free so the choice can be unit-tested without Electron.
const CODE = /^[A-Z]{2}$/
const codeOf = (value) => {
  const s = String(value ?? '')
    .trim()
    .toUpperCase()
  return CODE.test(s) ? s : ''
}

function summarize(endpoints) {
  const seen = new Map()
  for (const e of Array.isArray(endpoints) ? endpoints : []) {
    const cc = codeOf(e?.country)
    if (!cc) continue
    const entry = seen.get(cc) ?? { cc, nodes: new Set(), endpoints: 0 }
    entry.nodes.add(String(e.exitName ?? e.node ?? ''))
    entry.endpoints++
    seen.set(cc, entry)
  }
  return [...seen.values()]
    .map((e) => ({ cc: e.cc, nodes: e.nodes.size, endpoints: e.endpoints }))
    .sort((a, b) => a.cc.localeCompare(b.cc))
}

function select(endpoints, country) {
  const list = Array.isArray(endpoints) ? endpoints : []
  const want = codeOf(country)
  const available = summarize(list)
  if (!want) return { endpoints: list, country: '', fallback: false, available }
  const picked = list.filter((e) => codeOf(e?.country) === want)
  if (picked.length) return { endpoints: picked, country: want, fallback: false, available }
  return { endpoints: list, country: want, fallback: true, available }
}

// One row per node for the diagnostics table: what it is, which planes it offers and which of them the
// client is currently sitting out. Built from the same endpoint list as the country list, so the two
// can never disagree about what exists. Addresses are never included.
function summarizeNodes(endpoints) {
  const nodes = new Map()
  for (const e of Array.isArray(endpoints) ? endpoints : []) {
    const key = String(e?.exitName ?? e?.node ?? '')
    if (!key) continue
    const entry = nodes.get(key) ?? {
      key,
      node: String(e?.node ?? ''),
      country: codeOf(e?.country),
      planes: new Set(),
      cooling: new Set()
    }
    if (e?.node) entry.node = String(e.node)
    if (!entry.country) entry.country = codeOf(e?.country)
    if (e?.t) entry.planes.add(String(e.t))
    for (const type of Array.isArray(e?.cooling) ? e.cooling : []) entry.cooling.add(String(type))
    nodes.set(key, entry)
  }
  return [...nodes.values()]
    .map((n) => ({
      key: n.key,
      node: n.node,
      country: n.country,
      planes: [...n.planes].sort(),
      cooling: [...n.cooling].sort()
    }))
    .sort((a, b) => (a.country + a.key).localeCompare(b.country + b.key))
}

module.exports = { summarize, summarizeNodes, select }
