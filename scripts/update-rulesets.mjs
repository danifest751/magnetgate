#!/usr/bin/env node
// scripts/update-rulesets.mjs — publish the routing rule-sets a phone should be using.
//
//   node scripts/update-rulesets.mjs [--accept] [manifest.json]
//
// A rule-set decides which destinations bypass the tunnel, so it is not something a client may pick
// up unseen. The desktop solves that with a checksum pinned in git: the URL is `latest`, but a changed
// artifact stops the fetch instead of silently retuning routes, and a human decides. A phone cannot
// read git, so the same decision is moved one step: this script downloads the lists, and when a
// checksum differs from the published manifest it REFUSES to write and prints what changed. Only
// `--accept` records the new checksums, which is the operator making that decision explicitly.
//
// The manifest it writes is what src/exit.js advertises (MAGNETGATE_RULESETS_FILE). It carries no list
// contents - only where each one lives, how large it is and what it must hash to. A client downloads
// through its own tunnel and verifies against these checksums, so a compromised mirror cannot retune
// anyone's routing: the manifest itself is sealed with the key derived from the PSK, like every other
// field of the offer.
//
// Exit codes: 0 wrote or already current, 1 a checksum changed and --accept was not given, 2 failed.
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { atomicWrite } from '../src/state-file.mjs'

const accept = process.argv.includes('--accept')
const outPath = path.resolve(
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
    process.env.MAGNETGATE_RULESETS_FILE ??
    '/etc/magnetgate-rulesets.json'
)

// The same three the desktop routes by, from the same upstream. `tunnel-userlist.srs` is deliberately
// absent: it is the operator's own file, not a published artifact, and it ships inside the app.
const SETS = [
  {
    tag: 'blocked-domains',
    url: 'https://github.com/1andrevich/Re-filter-lists/releases/latest/download/ruleset-domain-refilter_domains.srs',
    role: 'blocked domains routed through the exit'
  },
  {
    tag: 'blocked-ip',
    url: 'https://github.com/1andrevich/Re-filter-lists/releases/latest/download/ruleset-ip-refilter_ipsum.srs',
    role: 'blocked IP summaries routed through the exit'
  }
]

// A rule-set is a compact binary; anything much larger is not one, and a client should never be asked
// to download it. The cap is checked here and again on the device.
const MAX_BYTES = 8 * 1024 * 1024

async function download(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const body = Buffer.from(await res.arrayBuffer())
  if (!body.length) throw new Error(`${url}: empty response`)
  if (body.length > MAX_BYTES) throw new Error(`${url}: ${body.length}B exceeds the ${MAX_BYTES}B cap`)
  // sing-box rule-set binaries start with "SRS"; an HTML error page served with 200 does not.
  if (body.subarray(0, 3).toString('latin1') !== 'SRS')
    throw new Error(`${url}: not a sing-box rule-set (no SRS magic) - a redirect or an error page?`)
  return body
}

function readPrevious() {
  try {
    return JSON.parse(fs.readFileSync(outPath, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

const previous = readPrevious()
const sets = []
const changed = []

for (const set of SETS) {
  let body
  try {
    body = await download(set.url)
  } catch (err) {
    console.error(`[fatal] ${set.tag}: ${err.message}`)
    process.exit(2)
  }
  const sha256 = crypto.createHash('sha256').update(body).digest('hex')
  const before = previous?.sets?.find((s) => s.tag === set.tag)
  if (before && before.sha256 !== sha256)
    changed.push({ tag: set.tag, from: before.sha256, to: sha256, bytes: body.length })
  sets.push({ tag: set.tag, url: set.url, sha256, bytes: body.length })
  console.log(`${set.tag}: ${body.length}B sha256=${sha256.slice(0, 16)}… (${set.role})`)
}

if (changed.length && !accept) {
  console.error('')
  console.error('[stop] upstream changed and --accept was not given. A rule-set decides what bypasses')
  console.error('       the tunnel, so this is a decision, not an update:')
  for (const c of changed)
    console.error(`       ${c.tag}: ${c.from.slice(0, 16)}… -> ${c.to.slice(0, 16)}… (${c.bytes}B)`)
  console.error('       Re-run with --accept to publish these checksums.')
  process.exit(1)
}

const unchanged = previous && !changed.length && previous.sets?.length === sets.length
if (unchanged) {
  console.log(`already current (generation ${previous.v}) - ${outPath} not rewritten`)
  process.exit(0)
}

const manifest = { v: Number(previous?.v ?? 0) + 1, ts: Date.now(), sets }
atomicWrite(outPath, JSON.stringify(manifest, null, 2))
// Readable by everyone on purpose. The exit runs as an unprivileged user (it executes code from the
// repository, so it must not be root), while this script is run by an operator who is - and atomicWrite
// leaves a file only its owner can read. Nothing here is secret: public URLs, sizes and checksums, the
// same three things scripts/pins.json has carried in git all along.
try {
  fs.chmodSync(outPath, 0o644)
} catch (err) {
  console.error(`[warn] could not make ${outPath} readable by the exit user: ${err.message}`)
}
console.log(`wrote ${outPath}: generation ${manifest.v}, ${sets.length} set(s)`)
