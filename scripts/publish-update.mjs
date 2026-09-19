#!/usr/bin/env node
// Publishes the build clients should be running.
//
// It writes one small document - version, URL, digest, size - which the exit seals into its Nostr
// offer (src/exit.js, readUpdate). A client compares the version with its own, downloads the package
// from that URL **through its tunnel**, and installs nothing unless the digest matches.
//
// The URL is not trusted and does not have to be. The digest is the control, exactly as it is for the
// routing lists: a mirror that serves something else fails verification. That is why the package may
// live wherever is convenient - a release page, a bucket, a node - without that host becoming able to
// install code on anyone's phone.
//
// What this script will not do:
//
//   - publish a version code that is not higher than the one already published. Android refuses a
//     downgrade anyway, so a manifest offering one is a manifest that does nothing but confuse;
//   - publish a digest it did not compute itself. The APK is read here, in full, and hashed here;
//   - publish a debuggable package, unless asked in as many words with --allow-debuggable.
//
// That last one has a legitimate use and it is worth spelling out, because the flag looks like a way
// around a safety check and is not. Android only accepts an update signed with the same key as the
// installed app. A phone running builds signed with the debug key can therefore be updated by debug
// builds and by nothing else - and while a client is being developed on a real phone, that is exactly
// what is wanted: every change reaches the device the way a user would get it, and the diagnostics the
// work depends on (`run-as`, the engine's log, the acceptance script) keep working, which they do not
// on a release. What it costs is real and belongs to whoever types the flag: a debuggable build lets
// anything on that phone stop the tunnel, kill the process, or hand this application an update
// manifest of its own. That last one is still bounded by the signature check, but it is not nothing.
//
// Usage:
//   node scripts/publish-update.mjs --apk <path> --url <http[s]://...> [--out ...] [--allow-debuggable]
//   node scripts/publish-update.mjs --show [--out ...]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const MAX_BYTES = 256 * 1024 * 1024
const DEFAULT_OUT = process.env.MAGNETGATE_UPDATE_FILE ?? '/etc/magnetgate-update.json'

function arg(name, fallback = null) {
  const at = process.argv.indexOf('--' + name)
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--')
    ? process.argv[at + 1]
    : fallback
}
const has = (name) => process.argv.includes('--' + name)

function die(message) {
  console.error('publish-update: ' + message)
  process.exit(1)
}

function readCurrent(out) {
  try {
    return JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

// What the package says about itself. aapt is part of the build tools the release was built with, so
// asking it is cheaper and far more honest than trusting the file name or a flag on the command line.
function badging(apk) {
  const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME
  if (!sdk) die('set ANDROID_SDK_ROOT so the package can be read with aapt')
  const tools = path.join(sdk, 'build-tools')
  const versions = fs.existsSync(tools) ? fs.readdirSync(tools).sort() : []
  if (!versions.length) die('no build-tools under ' + tools)
  const aapt = path.join(tools, versions[versions.length - 1], process.platform === 'win32' ? 'aapt2.exe' : 'aapt2')
  const text = execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8', maxBuffer: 16 << 20 })
  const code = Number(/versionCode='(\d+)'/.exec(text)?.[1])
  const name = /versionName='([^']+)'/.exec(text)?.[1]
  const debuggable = /application-debuggable/.test(text)
  if (!Number.isInteger(code) || code < 1 || !name) die('the package does not name a version')
  return { code, name, debuggable }
}

const out = arg('out', DEFAULT_OUT)

if (has('show')) {
  const current = readCurrent(out)
  console.log(current ? JSON.stringify(current, null, 2) : 'nothing published at ' + out)
  process.exit(0)
}

const apk = arg('apk')
const url = arg('url')
if (!apk || !url) die('need --apk <path> and --url <https://...> (or --show)')
// https or http: the digest is the control here, not the transport (see core/offer.Update), and the
// nodes that serve these packages have no domain and therefore no certificate. Anything else - a file
// path, an ftp URL - is a mistake worth catching now rather than on a phone.
if (!/^https?:\/\//.test(url)) die('the URL must be http or https')
if (!fs.existsSync(apk)) die('no such package: ' + apk)

const bytes = fs.statSync(apk).size
if (bytes <= 0 || bytes > MAX_BYTES) die(`${bytes} B is not a plausible package size`)

const { code, name, debuggable } = badging(apk)
if (debuggable && !has('allow-debuggable')) {
  die('this is a debuggable build; pass --allow-debuggable if the phones it reaches are your own')
}
if (debuggable) {
  console.warn('publish-update: publishing a DEBUGGABLE build. Anything on those phones can stop the')
  console.warn('publish-update: tunnel, kill the process, or inject an update manifest. Development only.')
}

const current = readCurrent(out)
if (current && Number(current.vc) >= code) {
  die(`version code ${code} is not newer than the published ${current.vc}: Android would refuse it`)
}

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex')
const manifest = { v: 1, vc: code, vn: name, url, sha256, bytes }
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n')

console.log(`published build ${code} (${name})`)
console.log(`  ${bytes} B, sha256 ${sha256}`)
console.log(`  from ${url}`)
console.log(`  written to ${out}`)
console.log('')
console.log('Now make sure the package is actually reachable at that URL, and that it is the very file')
console.log('hashed above: clients verify the digest and will refuse anything else, which is the point.')
