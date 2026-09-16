// A minimal NIP-01 relay for hermetic stands.
//
// It keeps the newest parameterised replaceable event per (kind, pubkey, d tag) and serves matching
// events to subscribers — which is exactly what the client's second rendezvous channel needs and all
// this relay is for. It does not verify signatures: a stand must stay small, and the client verifies
// both the event and, more importantly, the sealed envelope the event carries.
//
//   node scripts/dev/nostr-relay.mjs [port]
import { WebSocketServer } from 'ws'

const port = Number(process.argv[2] ?? 29603)
const log = (...args) => console.log(new Date().toISOString(), ...args)

const events = new Map() // "kind:pubkey:d" -> event
const subscriptions = new Map() // socket -> Map(subId -> filter)

const tagOf = (ev, name) => (ev.tags ?? []).find((t) => t[0] === name)?.[1]
const keyOf = (ev) => `${ev.kind}:${ev.pubkey}:${tagOf(ev, 'd') ?? ''}`

function matches(ev, filter) {
  if (!filter) return true
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false
  if (filter.authors && !filter.authors.includes(ev.pubkey)) return false
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue
    if (!values.includes(tagOf(ev, key.slice(1)))) return false
  }
  return true
}

const server = new WebSocketServer({ port })
log(`[relay] listening on ws://127.0.0.1:${port}`)

server.on('connection', (socket) => {
  subscriptions.set(socket, new Map())

  socket.on('message', (data) => {
    let message
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }
    const [verb, ...rest] = message

    if (verb === 'EVENT') {
      const ev = rest[0]
      if (!ev || typeof ev.id !== 'string') return
      const key = keyOf(ev)
      const previous = events.get(key)
      if (previous && previous.created_at >= ev.created_at) return
      events.set(key, ev)
      log(`[relay] stored kind ${ev.kind} d=${(tagOf(ev, 'd') ?? '').slice(0, 8)} slot=${ev.tags?.length ?? 0}`)
      socket.send(JSON.stringify(['OK', ev.id, true, '']))
      // push it to everyone already subscribed, which is what makes this channel instant
      for (const [client, map] of subscriptions) {
        if (client === socket) continue
        for (const [subId, filter] of map) {
          if (matches(ev, filter)) client.send(JSON.stringify(['EVENT', subId, ev]))
        }
      }
      return
    }

    if (verb === 'REQ') {
      const [subId, filter] = rest
      subscriptions.get(socket).set(subId, filter ?? {})
      const limit = Number(filter?.limit ?? 0)
      const found = [...events.values()]
        .filter((ev) => matches(ev, filter))
        .sort((a, b) => b.created_at - a.created_at)
      const served = limit > 0 ? found.slice(0, limit) : found
      for (const ev of served) socket.send(JSON.stringify(['EVENT', subId, ev]))
      socket.send(JSON.stringify(['EOSE', subId]))
      log(`[relay] sub ${subId}: served ${served.length} stored event(s)`)
      return
    }

    if (verb === 'CLOSE') {
      subscriptions.get(socket)?.delete(rest[0])
    }
  })

  socket.on('close', () => subscriptions.delete(socket))
  socket.on('error', () => {})
})
