// Build our own Go host; no downloaded opaque peer executable is packaged.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '..')
const out = path.join(root, 'tools', 'peer')
fs.mkdirSync(out, { recursive: true })
const result = spawnSync('go', ['build', '-trimpath', '-o', path.join(out,
  process.platform === 'win32' ? 'peer-node.exe' : 'peer-node'), './cmd/peer-node'], {
  cwd: path.join(root, 'app-android', 'core'), stdio: 'inherit', windowsHide: true
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
const executable = process.platform === 'win32' ? 'peer-node.exe' : 'peer-node'
for (const module of ['github.com/hashicorp/yamux', 'github.com/gorilla/websocket']) {
  const lookup = spawnSync('go', ['list', '-m', '-f', '{{.Dir}}', module], {
    cwd: path.join(root, 'app-android', 'core'), encoding: 'utf8', windowsHide: true
  })
  if (lookup.error || lookup.status !== 0) throw new Error(`Cannot locate license for ${module}`)
  const license = path.join(out, module.split('/').at(-1) + '-LICENSE')
  if (fs.existsSync(license)) fs.chmodSync(license, 0o600)
  fs.writeFileSync(license, fs.readFileSync(path.join(lookup.stdout.trim(), 'LICENSE')))
}
fs.copyFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), path.join(out, 'THIRD-PARTY-NOTICES.md'))
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify({
  platform: process.platform, arch: process.arch,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(out, executable))).digest('hex')
}, null, 2))
