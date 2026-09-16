// Offer helpers shared by the client. Kept pure and side-effect-free so they can be unit-tested
// without starting the DHT / Nostr stack.
import { OFFER_SCHEMA } from './common.mjs'
//
// Rendezvous split (Phase 3 — hy2 cert-pinning): the exit publishes ONE offer generation (same
// `ts`) on two channels but with different data-plane views. The DHT offer is compact and omits the
// hy2 endpoint, because pinning hy2 needs its self-signed cert (~hundreds of bytes) which does not
// fit under the ~1000 B BEP44 limit. The Nostr offer is a superset that carries the pinned hy2
// endpoint (cert in `dp.ca`). The two are sealed under different nonces (see exit.js: 'n'+seq vs
// seq) so the differing plaintexts never reuse a nonce. The client therefore MERGES the two
// same-generation offers by data-plane type instead of letting the last channel to arrive win —
// otherwise the DHT offer (polled every few seconds) would repeatedly clobber the hy2 entry that
// only the Nostr offer carries.

// Pick the most-preferred data-plane endpoint this client can use, in `pref` order.
export function pickDp(o, pref) {
  for (const t of pref) { const d = o?.dp?.find((x) => x.t === t); if (d) return d }
  return null
}

// Merge an incoming offer into the one currently held:
//  - newer generation (larger ts) replaces outright;
//  - same generation (equal ts) unions the dp lists by type, so the hy2 entry that only the Nostr
//    channel carries survives the compact DHT offer (and vice-versa);
//  - older generation is kept as-is.
// Returns the offer to hold, or null when `incoming` is not a valid v3 offer (caller keeps `prev`).
export function mergeOffer(prev, incoming) {
  if (!incoming || incoming.v !== OFFER_SCHEMA || typeof incoming.ts !== 'number' || !Array.isArray(incoming.dp)) return null
  if (!prev || incoming.ts > prev.ts) return { ...incoming, dp: [...incoming.dp] }
  if (incoming.ts < prev.ts) return prev
  // same generation: union by type; the incoming channel refreshes/adds its own entries
  const byType = new Map(prev.dp.map((d) => [d.t, d]))
  for (const d of incoming.dp) byType.set(d.t, d)
  return { ...prev, dp: [...byType.values()] }
}

// Multi-node Phase 1: which slots a client should start polling because a node advertised them in
// `peers`. Returns only slots that are in range and not already known. Pure, so the caller decides
// what to do with them — and logs it, because a node holding the PSK can advertise any slot.
export function newPeerSlots(known, peers, maxSlots = 16) {
  const seen = new Set((known ?? []).map(Number))
  const found = []
  for (const peer of Array.isArray(peers) ? peers : []) {
    const slot = Number(peer?.slot)
    if (!Number.isInteger(slot) || slot < 0 || slot >= maxSlots) continue
    if (seen.has(slot)) continue
    seen.add(slot)
    found.push(slot)
  }
  return found.sort((a, b) => a - b)
}
