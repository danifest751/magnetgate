#!/usr/bin/env node
// scripts/update-rules.mjs — downloads a community blocklist and converts it to a magnetgate
// split-tunnel rules file (the proxy list of domains).
// Usage: node scripts/update-rules.mjs [output.json] [source-url]
// Default list: antifilter community list (domains + CIDRs; CIDRs are skipped — the SOCKS client
// routes by domain via socks5h, not by IP).
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'

const outPath = path.resolve(process.argv[2] ?? 'magnetgate.rules.json')
const url =
  process.argv[3] ??
  process.env.MAGNETGATE_RULES_URL ??
  'https://community.antifilter.download/list/community.lst'
const direct = ['ru', 'by'] // domestic zones stay direct
const MAX_REDIRECTS = 5

// The old version used a bare https.get with no status check: a 301/404 returned HTML that was
// parsed as a (usually empty) domain list and written out as a valid-looking rules file.
function fetch(url, redirectsLeft, done) {
  https
    .get(url, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) return done(new Error(`too many redirects (last: ${url})`))
        return fetch(new URL(res.headers.location, url).toString(), redirectsLeft - 1, done)
      }
      if (status !== 200) {
        res.resume()
        return done(new Error(`unexpected HTTP ${status} from ${url}`))
      }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        data += c
      })
      res.on('end', () => done(null, data))
      res.on('error', done)
    })
    .on('error', done)
}

fetch(url, MAX_REDIRECTS, (err, data) => {
  if (err) {
    console.error(`rules download failed: ${err.message}`)
    process.exit(1)
  }
  const domains = new Set()
  for (const raw of data.split('\n')) {
    const line = raw.trim().toLowerCase()
    if (!line || line.startsWith('#')) continue
    if (line.includes('/') || /^\d+\.\d+\.\d+\.\d+$/.test(line)) continue // skip CIDRs / bare IPs
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(line)) continue
    domains.add(line)
  }
  if (!domains.size) {
    console.error(`no domains parsed from ${url} — refusing to overwrite ${outPath}`)
    process.exit(1)
  }
  const rules = { direct, proxy: [...domains].sort() }
  // write via a temp file so a failure cannot leave a half-written rules file behind
  const temp = `${outPath}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(rules, null, 1))
  fs.renameSync(temp, outPath)
  console.log(`rules written: ${rules.proxy.length} domains → ${outPath} (point MAGNETGATE_RULES at it)`)
})
