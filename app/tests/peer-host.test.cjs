const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { PeerHost } = require('../peer-host.cjs')

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  const host = new PeerHost({ root: '.', profile: 'fixture', spawnChild: () => {
    queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'status', status: { configured: true } }) + '\n'))
    return child
  } })
  host.executable = process.execPath
  return { host, child }
}

test('a broken peer pipe rejects requests without an uncaught Electron error and retains ownership', async () => {
  const { host, child } = fixture()
  await host.start()
  const request = host.request('status')
  await new Promise(resolve => setImmediate(resolve))
  child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
  await assert.rejects(request, /broken pipe/)
  assert.equal(host.child, child)
  child.emit('exit', 1)
  assert.equal(host.child, null)
  assert.equal(host.state.guestConnected, false)
})

test('Disconnect falls back to EOF and waits for peer exit when the child rejects its RPC', async () => {
  const { host, child } = fixture()
  child.stdin.on('data', buffer => {
    const request = JSON.parse(String(buffer))
    child.stdout.write(JSON.stringify({ type: 'reply', id: request.id, error: 'fixture RPC failure' }) + '\n')
  })
  child.stdin.on('finish', () => setImmediate(() => child.emit('exit', 0)))
  await host.start()
  await host.disconnect()
  assert.equal(host.child, null)
  assert.equal(host.endpoint, null)
})

test('peer endpoint credentials never appear in status and malformed endpoint is rejected', async () => {
  const { host, child } = fixture()
  child.stdin.on('data', buffer => {
    const request = JSON.parse(String(buffer))
    child.stdout.write(JSON.stringify({ type: 'reply', id: request.id, endpoint: { port: 1080, country: 'DE', username: 'x', password: 'short' } }) + '\n')
  })
  await host.start()
  await assert.rejects(host.connect('DE', 1080), /Invalid peer endpoint/)
  assert.equal(host.endpoint, null)
  child.emit('exit', 0)
})
