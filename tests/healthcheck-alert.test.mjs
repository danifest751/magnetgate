// The alert channel must fire once when the exit breaks, repeat only after the cooldown, and announce
// recovery once. A local HTTP endpoint stands in for the webhook, so the test never leaves the host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, '..', 'scripts', 'healthcheck.mjs')
const execFileAsync = promisify(execFile)

function fixture(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-alert-'))
  const file = path.join(dir, 'health.json')
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents))
  return { dir, file, state: path.join(dir, 'health.json.alert') }
}

// async on purpose: execFileSync would block this process, and the webhook endpoint lives in it
async function run(file, state, webhook, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, file], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MAGNETGATE_ALERT_WEBHOOK: webhook ?? '',
        MAGNETGATE_ALERT_STATE: state,
        MAGNETGATE_ALERT_COOLDOWN_MIN: '30',
        ...extraEnv
      }
    })
    return { code: 0, out: String(stdout) + String(stderr) }
  } catch (err) {
    return { code: err.code ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

const broken = { publishedAt: new Date().toISOString(), ok: false, nodes: 0, failures: 9 }
const fine = { publishedAt: new Date().toISOString(), ok: true, nodes: 20, failures: 0 }

test('unhealthy exit alerts once, stays quiet inside the cooldown, and announces recovery', async () => {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push(body)
      res.writeHead(204).end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const webhook = `http://127.0.0.1:${server.address().port}/alert`
  const f = fixture(broken)
  try {
    const first = await run(f.file, f.state, webhook)
    assert.equal(first.code, 1, first.out)
    assert.equal(received.length, 1, 'the first failure must be reported')
    assert.match(received[0], /UNHEALTHY/)
    assert.match(received[0], /no DHT node|publication/, 'the reason must be in the message')

    const second = await run(f.file, f.state, webhook)
    assert.equal(second.code, 1, second.out)
    assert.equal(received.length, 1, 'a repeat inside the cooldown must not be sent')

    fs.writeFileSync(f.file, JSON.stringify(fine))
    const recovered = await run(f.file, f.state, webhook)
    assert.equal(recovered.code, 0, recovered.out)
    assert.equal(received.length, 2, 'recovery is announced once')
    assert.match(received[1], /recovered/)

    const stillFine = await run(f.file, f.state, webhook)
    assert.equal(stillFine.code, 0, stillFine.out)
    assert.equal(received.length, 2, 'staying healthy is not announced again')
  } finally {
    server.close()
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('a broken alert channel does not change the exit code', async () => {
  const f = fixture(broken)
  try {
    // nothing listens on this port: the webhook fails, the check must still report unhealthy
    const result = await run(f.file, f.state, 'http://127.0.0.1:1/alert')
    assert.equal(result.code, 1, result.out)
    assert.match(result.out, /alert not delivered|UNHEALTHY/)
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

test('without a webhook nothing is sent and no state file is written', async () => {
  const f = fixture(broken)
  try {
    const result = await run(f.file, f.state, '')
    assert.equal(result.code, 1, 'an unhealthy exit must exit non-zero')
    assert.equal(fs.existsSync(f.state), false, 'no alert state without an alert channel')
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true })
  }
})

