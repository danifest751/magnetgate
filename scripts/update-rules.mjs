#!/usr/bin/env node
// scripts/update-rules.mjs — downloads a community blocklist and converts it to
// a magnetgate split-tunnel rules file (proxy list of domains).
// Usage: node scripts/update-rules.mjs [output.json] [source-url]
// Default list: antifilter community list (domains + CIDRs; CIDRs are skipped —
// the SOCKS client routes by domain via socks5h, not by IP).
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'

const outPath = path.resolve(process.argv[2] ?? 'magnetgate.rules.json')
const url = process.env.MAGNETGATE_RULES_URL ?? 'https://community.antifilter.download/list/community.lst'
const direct = ['ru', 'by'] // domestic zones stay direct

https.get(url, (res) => {
  let data = ''
  res.on('data', (c) => { data += c })
  res.on('end', () => {
    const domains = new Set()
    for (const raw of data.split('\n')) {
      const line = raw.trim().toLowerCase()
      if (!line || line.startsWith('#')) continue
      if (line.includes('/') || /^\d+\.\d+\.\d+\.\d+$/.test(line)) continue // skip CIDRs / bare IPs
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(line)) continue
      domains.add(line)
    }
    const rules = { direct, proxy: [...domains].sort() }
    fs.writeFileSync(outPath, JSON.stringify(rules, null, 1))
    console.log(`rules written: ${rules.proxy.length} domains → ${outPath} (point MAGNETGATE_RULES at it)`)
  })
}).on('error', (e) => { console.error(e.message); process.exit(1) })
