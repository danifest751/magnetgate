import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, '..', 'scripts', 'healthcheck.mjs')

function run(contents) {
  const file = path.join(os.tmpdir(), `mg-health-${process.pid}-${Math.random().toString(16).slice(2)}.json`)
  if (contents !== undefined) fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents))
  try {
    const out = execFileSync(process.execPath, [script, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status ?? -1, out: String(err.stderr ?? '') + String(err.stdout ?? '') }
  } finally {
    fs.rmSync(file, { force: true })
  }
}

test('S9: healthcheck passes on a fresh successful publication', () => {
  const r = run({
    publishedAt: new Date().toISOString(),
    ok: true,
    nodes: 7,
    dhtNodes: 120,
    dhtReady: true,
    seq: 1234,
    failures: 0,
    nostr: 'enabled',
    error: null
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /healthy/)
})

test('S9: healthcheck fails when publications reach no node', () => {
  const r = run({
    publishedAt: new Date().toISOString(),
    ok: false,
    nodes: 0,
    dhtReady: true,
    failures: 6,
    error: null
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /UNHEALTHY/)
  assert.match(r.out, /no DHT node/)
})

test('S9: healthcheck fails on a stale or missing health file', () => {
  const stale = run({
    publishedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ok: true,
    nodes: 3,
    dhtReady: true,
    failures: 0
  })
  assert.equal(stale.code, 1, stale.out)
  assert.match(stale.out, /last publication was/)

  const missing = run(undefined)
  assert.equal(missing.code, 2, missing.out)
})
