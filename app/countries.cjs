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

module.exports = { summarize, select }
