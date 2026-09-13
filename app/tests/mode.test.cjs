const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const { switchMode, engineSignature } = require('../mode.cjs')

async function server(t, respond) {
  const requests = []
  const instance = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture')
    let body = ''
    req.on('data', (b) => (body += b))
    req.on('end', () => {
      requests.push([req.method, req.url, body])
      respond(req, res, body)
    })
  })
  instance.listen(0, '127.0.0.1')
  await once(instance, 'listening')
  t.after(() => {
    instance.closeAllConnections()
    instance.close()
  })
  return { api: { port: instance.address().port, secret: 'fixture' }, requests }
}
test('switch confirms mode before closing old flows', async (t) => {
  const { api, requests } = await server(t, (req, res) => {
    if (req.method === 'GET') res.end(JSON.stringify({ mode: 'rule' }))
    else {
      res.writeHead(204)
      res.end()
    }
  })
  await switchMode(api, 'split', new AbortController().signal)
  assert.deepEqual(requests, [
    ['PATCH', '/configs', '{"mode":"Rule"}'],
    ['GET', '/configs', ''],
    ['DELETE', '/connections', '']
  ])
})
test('an ignored mode change does not report success or close flows', async (t) => {
  const { api, requests } = await server(t, (req, res) => {
    if (req.method === 'GET') res.end('{"mode":"Global"}')
    else {
      res.writeHead(204)
      res.end()
    }
  })
  await assert.rejects(switchMode(api, 'split', new AbortController().signal), /did not apply/)
  assert.equal(requests.length, 2)
})
test('failed connection cleanup is a failed switch', async (t) => {
  const { api } = await server(t, (req, res) => {
    if (req.method === 'GET') res.end('{"mode":"Global"}')
    else {
      res.writeHead(req.method === 'DELETE' ? 500 : 204)
      res.end()
    }
  })
  await assert.rejects(switchMode(api, 'full', new AbortController().signal), /DELETE.*500/)
})
test('switch deadline covers an unfinished control response', async (t) => {
  const { api } = await server(t, (_req, res) => {
    res.writeHead(200)
    res.write(' ')
  })
  await assert.rejects(switchMode(api, 'full', new AbortController().signal, 30), {
    name: 'AbortError'
  })
})
test('Disconnect aborts a pending mode request', async (t) => {
  let entered
  const waiting = new Promise((r) => (entered = r))
  const { api } = await server(t, () => entered())
  const abort = new AbortController()
  const switching = switchMode(api, 'full', abort.signal)
  await waiting
  abort.abort()
  await assert.rejects(switching, { name: 'AbortError' })
})
test('only ordinary mode differences share an engine signature', () => {
  const cfg = { vpnMode: 'full', killSwitch: false, directDomains: [] },
    dp = []
  assert.equal(engineSignature(cfg, dp), engineSignature({ ...cfg, vpnMode: 'split' }, dp))
  assert.notEqual(
    engineSignature({ ...cfg, killSwitch: true }, dp),
    engineSignature({ ...cfg, killSwitch: true, vpnMode: 'split' }, dp)
  )
  assert.notEqual(
    engineSignature(cfg, dp),
    engineSignature({ ...cfg, directDomains: ['changed.test'] }, dp)
  )
  assert.notEqual(engineSignature(cfg, dp), engineSignature(cfg, [{ host: '203.0.113.1' }]))
})
