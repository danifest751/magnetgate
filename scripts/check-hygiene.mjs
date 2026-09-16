// Hygiene gate: rejects secrets, private keys and real host addresses before they reach a commit.
//
// Usage:
//   node scripts/check-hygiene.mjs            # scan every tracked file
//   node scripts/check-hygiene.mjs --staged   # scan only what is staged (used by .githooks/pre-commit)
//
// Exit code 0 = clean, 1 = at least one violation.
//
// Why: this repository is public. It must not carry live exit/home addresses, private keys, tokens or
// field test reports. See docs/audit-2026-09-16.md (S2) for the incident this gate exists to prevent.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

// --- forbidden paths -----------------------------------------------------------------------------
const BAD_PATHS = [
  { re: /^tests\/results(\.[a-z]{2})?\.md$/i, why: 'field test reports are internal (S2)' },
  { re: /^key\//i, why: 'secret material directory' },
  { re: /\.(pem|ppk|p12|pfx|key)$/i, why: 'key material' },
  { re: /(^|\/)\.env(\.|$)/i, why: 'environment files may hold the PSK' },
  { re: /(^|\/)(access|secrets?|credentials)\.txt$/i, why: 'plaintext credentials' },
  { re: /(^|\/)id_(rsa|ed25519|ecdsa)/i, why: 'private key' }
]

// --- forbidden content ---------------------------------------------------------------------------
const BAD_CONTENT = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'private key block' },
  { re: /\b\d{8,10}:[A-Za-z0-9_-]{33,}\b/, why: 'Telegram bot token' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, why: 'GitHub token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS access key id' },
  { re: /\bsk-[A-Za-z0-9]{32,}\b/, why: 'API key' }
]

// --- IPv4 literals: only well-known / documentation / private ranges may be committed -------------
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g
// Public resolvers that legitimately appear in code and docs.
const ALLOWED_IPS = new Set([
  '0.0.0.0',
  '1.1.1.1',
  '1.0.0.1',
  '1.2.3.4',
  '8.8.8.8',
  '8.8.4.4',
  '9.9.9.9',
  '149.112.112.112',
  '208.67.222.222',
  '208.67.220.220',
  '94.140.14.14',
  '255.255.255.255'
])
// RFC 5737 documentation ranges, RFC 1918 private space, loopback, link-local, CGNAT.
const ALLOWED_CIDRS = [
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 0, 2, 0, 24],
  [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15],
  [198, 51, 100, 0, 24],
  [203, 0, 113, 0, 24]
]

function ipToInt(ip) {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0)
}
function inCidr(ip, [a, b, c, d, bits]) {
  const base = ipToInt([a, b, c, d].join('.'))
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ipToInt(ip) & mask) === (base & mask)
}
function isAllowedIp(ip) {
  if (ALLOWED_IPS.has(ip)) return true
  const parts = ip.split('.').map(Number)
  if (parts.some((n) => Number.isNaN(n) || n > 255)) return true // malformed: not a real address
  return ALLOWED_CIDRS.some((cidr) => inCidr(ip, cidr))
}

function isProbablyText(buffer) {
  return !buffer.subarray(0, 8192).includes(0)
}

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
    encoding: 'utf8'
  })
  return out.split('\0').filter(Boolean)
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  return out.split('\0').filter(Boolean)
}

function contentOf(file, staged) {
  if (!staged) return fs.readFileSync(file)
  return execFileSync('git', ['show', `:${file}`], { maxBuffer: 64 * 1024 * 1024 })
}

const staged = process.argv.includes('--staged')
const files = staged ? stagedFiles() : trackedFiles()
const problems = []

for (const file of files) {
  for (const { re, why } of BAD_PATHS) {
    if (re.test(file)) problems.push(`${file}: forbidden path (${why})`)
  }
  let buffer
  try {
    buffer = contentOf(file, staged)
  } catch {
    continue
  }
  if (!isProbablyText(buffer)) continue
  const text = buffer.toString('utf8')
  const lines = text.split(/\r?\n/)

  for (const { re, why } of BAD_CONTENT) {
    lines.forEach((line, i) => {
      if (re.test(line)) problems.push(`${file}:${i + 1}: ${why}`)
    })
  }
  lines.forEach((line, i) => {
    for (const match of line.match(IPV4) ?? []) {
      if (!isAllowedIp(match)) {
        problems.push(
          `${file}:${i + 1}: public address ${match} (use a placeholder such as <exit-ip>)`
        )
      }
    }
  })
}

if (problems.length) {
  console.error('hygiene check failed — nothing was committed:')
  for (const problem of [...new Set(problems)]) console.error('  ' + problem)
  console.error(
    '\nFix the finding, or move the value to an untracked file. Real addresses never belong in this repo.'
  )
  process.exit(1)
}

console.log(`hygiene check: clean (${files.length} ${staged ? 'staged' : 'tracked'} files)`)
