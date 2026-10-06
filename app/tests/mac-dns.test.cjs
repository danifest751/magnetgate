const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { MacDnsLease, DNS_ADDRESS } = require('../mac-dns.cjs')

function fixture({ ready = true, fail = false } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 42, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
  })
  let commands = '', flushed = 0, lost = 0, launched
  child.stdin.on('data', data => { commands += data.toString() })
  const exit = () => { child.exitCode = 0; child.emit('exit', 0, null) }
  child.stdin.on('finish', exit)
  child.kill = exit
  const lease = new MacDnsLease({ timeoutMs: 20,
    launch: (...args) => {
      launched = args
      queueMicrotask(() => {
        if (fail) child.stdout.write('add: Permission denied\n')
        else if (ready) child.stdout.write(`ServerAddresses : ${DNS_ADDRESS}\nSupplementalMatchDomainsNoSearch : 1\n`)
      })
      return child
    }, flush: async () => { flushed++ }, onLost: () => { lost++ }
  })
  return { child, lease, exit, get commands() { return commands },
    get flushed() { return flushed }, get lost() { return lost }, get launched() { return launched } }
}

test('macOS DNS leases a temporary catch-all resolver without changing network preferences', async () => {
  const f = fixture()
  await f.lease.start()
  assert.equal(f.launched[0], '/usr/sbin/scutil')
  assert.deepEqual(f.launched[2].env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })
  assert.match(f.commands, /add State:\/Network\/Service\/org\.magnetgate\.tun-\d+\/DNS temporary/)
  assert.match(f.commands, /SupplementalMatchDomains \* ""/)
  assert.match(f.commands, /ServerAddresses \* 172\.19\.0\.2/)
  assert.doesNotMatch(f.commands, /Setup:|networksetup|quit/)
  assert.equal(f.flushed, 1)
  const stopping = f.lease.stop()
  assert.equal(f.lease.stop(), stopping)
  await stopping
  assert.match(f.commands, /quit\n$/)
  assert.equal(f.flushed, 2)
  assert.equal(f.lost, 0)
})

test('macOS DNS fails closed and closes its session if configuration is denied', async () => {
  const f = fixture({ fail: true })
  await assert.rejects(f.lease.start(), /DNS setup failed/)
  assert.equal(f.child.exitCode, 0)
  assert.equal(f.lease.child, null)
})

test('macOS DNS setup is bounded and cannot leave a resolver lease on timeout', async () => {
  const f = fixture({ ready: false })
  await assert.rejects(f.lease.start(), /timed out/)
  assert.equal(f.child.exitCode, 0)
})

test('macOS DNS resolver loss tells the engine to stop, but normal disconnect does not', async () => {
  const f = fixture()
  await f.lease.start()
  f.exit()
  assert.equal(f.lost, 1)
  await f.lease.stop()
  assert.equal(f.lost, 1)
})

test('a stopped macOS DNS lease cannot activate later and each engine gets its own session', async () => {
  const old = fixture(), next = fixture()
  await old.lease.stop()
  await assert.rejects(old.lease.start(), /already used/)
  await next.lease.start()
  await old.lease.stop()
  assert.equal(next.child.exitCode, null)
  await next.lease.stop()
})

test('a DNS utility spawn error is reported without waiting for a nonexistent process', async () => {
  const f = fixture({ ready: false })
  f.child.pid = undefined
  queueMicrotask(() => f.child.emit('error', new Error('spawn ENOENT')))
  await assert.rejects(f.lease.start(), /DNS setup failed/)
  assert.equal(f.lease.child, null)
})
