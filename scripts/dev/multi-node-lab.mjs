#!/usr/bin/env node
// Multi-node lab (docs/design-multi-node.md): runs a whole two-node setup on loopback and checks the
// two properties Phase 0 must deliver — a client finds BOTH nodes through one PSK, and a connection
// still succeeds after the node it used disappears.
//
//   node scripts/dev/multi-node-lab.mjs [--keep]
//
// Nothing here touches the system: no TUN, no routes, no firewall, no outside network. Exits dial a
// local HTTP target, the client is a plain SOCKS5 listener on 127.0.0.1, and the DHT is three local
// nodes. The data plane is forced to `mgt` (native) so sing-box is not involved.
//
// Exit codes: 0 all checks passed, 1 a check failed.
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PSK = 'lab-psk-0123456789abcdef0123456789abcdef'
const DHT_PORTS = [29501, 29502, 29503]
const NODES = [
  { name: 'lab-a', slot: 0, port: 29601 },
  { name: 'lab-b', slot: 1, port: 29602 }
]
const CLIENT_PORT = 29610
const TARGET_PORT = 29620
const KEEP = process.argv.includes('--keep')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-multi-node-'))

const children = []
const failures = []
const say = (msg) => console.log(`[lab] ${msg}`)
const check = (ok, msg) => {
  if (ok) say(`  PASS  ${msg}`)
  else {
    say(`  FAIL  ${msg}`)
    failures.push(msg)
  }
  return ok
}

function start(name, args, env, logFile) {
  const out = fs.createWriteStream(path.join(tmp, logFile))
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env } })
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  child.on('exit', (code, signal) => say(`${name} exited (code=${code} signal=${signal})`))
  children.push({ name, child, proc: child })
  return child
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(label, fn, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const value = await fn()
      if (value) return value
    } catch {}
    await sleep(250)
  }
  say(`timeout waiting for ${label}`)
  return null
}

// --- minimal SOCKS5 CONNECT client (the target is 127.0.0.1, so ATYP=1) ---------------------------
function socksGet(host, port, request) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(CLIENT_PORT, '127.0.0.1')
    let stage = 0
    let data = ''
    const done = (err, value) => {
      sock.destroy()
      err ? reject(err) : resolve(value)
    }
    sock.setTimeout(15000, () => done(new Error('socks timeout')))
    sock.on('error', (e) => done(e))
    sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])))
    sock.on('data', (buf) => {
      if (stage === 0) {
        if (buf[0] !== 5 || buf[1] !== 0) return done(new Error('socks greeting rejected'))
        stage = 1
        const ip = host.split('.').map(Number)
        sock.write(Buffer.from([5, 1, 0, 1, ...ip, port >> 8, port & 0xff]))
        return
      }
      if (stage === 1) {
        if (buf[0] !== 5 || buf[1] !== 0) return done(new Error(`socks connect failed (${buf[1]})`))
        stage = 2
        sock.write(Buffer.from(request))
        return
      }
      data += buf.toString('utf8')
    })
    sock.on('end', () => done(null, data))
  })
}

function logText(file) {
  try {
    return fs.readFileSync(path.join(tmp, file), 'utf8')
  } catch {
    return ''
  }
}
// the client logs which exit served each request:
//   "[socks] <hash> via mgt exit <label> node <name>"
function usedExit(clientLog) {
  const lines = clientLog.split('\n').filter((l) => l.includes('[socks]') && l.includes(' via '))
  const last = lines[lines.length - 1] ?? ''
  return (last.match(/node (lab-[ab])/)?.[1] ?? last.split('exit ')[1] ?? '').trim()
}

async function main() {
  say(`workdir ${tmp}`)
  check(fs.existsSync(path.join(root, 'src', 'dht-node.mjs')), 'dht-node.mjs exists')

  // 1. local HTTP target — the exit dials it, so the check stays hermetic
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('target-ok')
  })
  await new Promise((r) => target.listen(TARGET_PORT, '127.0.0.1', r))
  say(`target http on 127.0.0.1:${TARGET_PORT}`)

  // 2. local DHT (three nodes, like the testing guide's mini-DHT)
  const bootstrap = DHT_PORTS.map((p) => `127.0.0.1:${p}`).join(',')
  for (const [i, p] of DHT_PORTS.entries())
    start(`dht-${i}`, [path.join(root, 'src', 'dht-node.mjs'), String(p)], {}, `dht-${i}.log`)
  await sleep(1500)

  // 3. two exits, one PSK, different slots
  // Node B advertises a Reality endpoint that nothing listens on: the client must mark that plane as
  // cooling on that node and keep using the node through its native channel, instead of writing the
  // whole node off (that is what per-plane health is for).
  const brokenDp = path.join(tmp, 'dp-b.json')
  fs.writeFileSync(
    brokenDp,
    JSON.stringify({
      dp: [
        {
          t: 'reality',
          host: '127.0.0.1',
          port: 1,
          uuid: '11111111-2222-3333-4444-555555555555',
          pbk: 'pbk-not-used',
          sni: 'www.microsoft.com',
          sid: 'aabbccdd',
          fp: 'chrome'
        }
      ]
    })
  )
  for (const node of NODES) {
    start(
      node.name,
      [path.join(root, 'src', 'exit.js')],
      {
        MAGNETGATE_PSK: PSK,
        MAGNETGATE_PORT: String(node.port),
        MAGNETGATE_PUBLIC_HOST: '127.0.0.1',
        MAGNETGATE_NODE_SLOT: String(node.slot),
        MAGNETGATE_NODE_NAME: node.name,
        MAGNETGATE_ALLOW_PRIVATE: '1',
        MAGNETGATE_NOSTR: 'off',
        MAGNETGATE_TRANSPORT: 'tcp',
        // Phase 1: each node watches the other slot and advertises it in `peers`
        MAGNETGATE_PEER_SLOTS: NODES.map((n) => n.slot).join(','),
        MAGNETGATE_PUBLISH_MS: '5000',
        ...(node.slot === 1 ? { MAGNETGATE_DP_FILE: brokenDp } : {}),
        MAGNETGATE_SEQ_FILE: path.join(tmp, `seq-${node.slot}`),
        MAGNETGATE_HEALTH_FILE: path.join(tmp, `health-${node.slot}.json`),
        DHT_BOOTSTRAP: bootstrap
      },
      `${node.name}.log`
    )
  }

  const health = (slot) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(tmp, `health-${slot}.json`), 'utf8'))
    } catch {
      return null
    }
  }
  for (const node of NODES) {
    const h = await waitFor(`${node.name} to publish`, () => {
      const v = health(node.slot)
      return v && v.ok === true ? v : null
    })
    check(!!h, `${node.name} (slot ${node.slot}) published to the DHT (accepted by ${h?.nodes ?? 0} node(s))`)
    check(h?.slot === node.slot, `${node.name} reports its own slot`)
  }

  // nodes must find each other: each one scans the other slot and advertises it in `peers`
  for (const node of NODES) {
    const h = await waitFor(`${node.name} to see a peer`, () => {
      const v = health(node.slot)
      return v && v.peers >= 1 ? v : null
    })
    check(!!h, `${node.name} sees its peer and advertises it (peers=${h?.peers ?? 0})`)
  }

  // 4. client: one PSK expanded into both slots, native plane only
  const cfgPath = path.join(tmp, 'client.json')
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      exits: [{ name: 'lab', psk: PSK }],
      // ONLY the first slot: the second node must be learned from `peers`, not from config
      slots: [NODES[0].slot],
      bootstrap: DHT_PORTS.map((p) => `127.0.0.1:${p}`),
      rules: { direct: [], proxy: [] },
      // auto, so the client actually tries the (broken) reality plane of node B before its native one
      dataPlane: 'auto',
      localPort: CLIENT_PORT
    })
  )
  start(
    'client',
    [path.join(root, 'src', 'client.js'), cfgPath, String(CLIENT_PORT)],
    {
      MAGNETGATE_NOSTR: 'off',
      MAGNETGATE_DP_OUT: path.join(tmp, 'current-dp.json'),
      DHT_BOOTSTRAP: bootstrap
    },
    'client.log'
  )

  const firstSeen = await waitFor('the client to see its configured slot', () => {
    const text = logText('client.log')
    return text.includes(`=${NODES[0].name}`) ? text : null
  })
  check(!!firstSeen, 'the client found the node it was configured for')
  const discovery = await waitFor('the client to discover the peer slot', () => {
    const text = logText('client.log')
    return text.includes(`discovered slot ${NODES[1].slot}`) ? text : null
  })
  check(!!discovery, `the client discovered slot ${NODES[1].slot} from peers without config`)
  const bothSeen = await waitFor('offers from both nodes', () => {
    const text = logText('client.log')
    return NODES.every((n) => text.includes(`=${n.name}`)) ? text : null
  })
  check(!!bothSeen, 'both nodes are usable, one of them learned automatically')

  // 5. traffic flows, and we learn which node carried it
  const request = `GET / HTTP/1.0\r\nHost: target\r\n\r\n`
  const first = await socksGet('127.0.0.1', TARGET_PORT, request)
  check(first.includes('target-ok'), 'a request through the tunnel reached the target')
  const firstExit = usedExit(logText('client.log'))
  check(/lab-(a|b)/.test(firstExit), `the client reports which node served it (${firstExit || 'none'})`)

  // 6. per-plane health: node B advertises a Reality endpoint nothing listens on. A request routed to
  // it must fail over to that same node's native channel (not to the other node) and pause only the
  // broken plane, which the snapshot then reports to the app.
  let planeFailure = false
  for (let attempt = 0; attempt < 4 && !planeFailure; attempt++) {
    await socksGet('127.0.0.1', TARGET_PORT, request).catch(() => '')
    planeFailure = /\[socks\] transport failed: reality/.test(logText('client.log'))
  }
  check(planeFailure, 'a broken plane on a live node is reported as a plane failure')
  check(
    /paused \d+s after \d+ failure/.test(logText('client.log')),
    'the broken plane is paused with a backoff, not the whole node'
  )
  const cooling = await waitFor('the snapshot to report the paused plane', () => {
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(tmp, 'current-dp.json'), 'utf8'))
      const node = snapshot.exits.find((e) => e.node === 'lab-b')
      if (!node) {
        say(`snapshot has no lab-b entry (nodes: ${snapshot.exits.map((e) => e.node).join(',')})`)
        return null
      }
      const paused = (Array.isArray(node.cooling) ? node.cooling : []).some(
        (c) => (typeof c === 'string' ? c : c?.t) === 'reality'
      )
      if (!paused) {
        say(`lab-b cooling=${JSON.stringify(node.cooling)} planes=${node.dp.map((d) => d.t).join(',')}`)
        return null
      }
      return snapshot
    } catch (err) {
      say(`snapshot unreadable: ${err.message}`)
      return null
    }
  }, 20000)
  check(!!cooling, 'the snapshot carries per-node cooling state for the diagnostics table')
  check(
    !!cooling && cooling.exits.some((e) => e.node === 'lab-b' && e.dp.some((d) => d.t === 'mgt')),
    'the same node is still usable through its other plane'
  )

  // 7. failover: kill the node that served the request, a new request must use the other one
  const victim = NODES.find((n) => firstExit.includes(n.name))
  if (check(!!victim, 'the serving node is one of the two')) {
    say(`killing ${victim.name} (slot ${victim.slot})`)
    children.find((c) => c.name === victim.name).proc.kill()
    await sleep(1500)
    const second = await socksGet('127.0.0.1', TARGET_PORT, request)
    check(second.includes('target-ok'), 'a request still succeeds after that node died')
    const secondExit = usedExit(logText('client.log'))
    check(
      secondExit && !secondExit.includes(victim.name),
      `the client moved to the surviving node (${firstExit} -> ${secondExit || 'none'})`
    )
  }

  say('--- client log (rendezvous + routing) ---')
  for (const line of logText('client.log').split('\n').filter((l) => l.includes('[rv]') || l.includes('[socks]') || l.includes('[dp]')))
    say('  ' + line)
}

main()
  .catch((err) => {
    say(`error: ${err.message}`)
    failures.push(err.message)
  })
  .finally(async () => {
    if (KEEP) {
      say(`kept running processes and ${tmp} (--keep)`)
      return
    }
    for (const { child } of children) child.kill()
    await sleep(500)
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
    say(failures.length ? `FAILED: ${failures.length} check(s)` : 'ALL CHECKS PASSED')
    process.exit(failures.length ? 1 : 0)
  })
