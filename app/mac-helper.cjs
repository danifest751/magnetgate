// Runs as root with ELECTRON_RUN_AS_NODE, never as an elevated Electron GUI.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { peer } = require('./mac-protocol.cjs')
const { buildVpnConfig } = require('./vpn-config.cjs')

function safeConfig(root, input, clientPath = process.execPath, ruleSetRoot = root) {
  const { validateConfig, freshEndpoints } = require(path.join(root, 'src', 'config.cjs'))
  if (!input || !/^[a-f0-9]{32}$/.test(input.clashSecret || '') ||
      !Number.isInteger(input.clashPort) || input.clashPort < 1024 || input.clashPort > 65535)
    throw new Error('Invalid macOS engine request')
  const cfg = validateConfig(input.cfg)
  if ([cfg.localPort, cfg.probePort, cfg.singboxPort].some(port => port < 1024))
    throw new Error('macOS engine ports must be unprivileged')
  const dp = freshEndpoints(input.snapshot)
  const bypass = [...new Set((input.bypass || []).filter(net.isIPv4))]
  // Rebuild from validated preferences/endpoints, never accept a root-level sing-box config,
  // executable, output path or arbitrary command from the unprivileged application.
  return buildVpnConfig({ root, ruleSetRoot, cfg: { ...cfg, killSwitch: false }, dp, bypass,
    clashPort: input.clashPort, clashSecret: input.clashSecret, clientPath, platform: 'darwin' })
}

async function serve(bootstrapPath) {
  if (process.platform !== 'darwin' || process.getuid() !== 0) throw new Error('macOS root helper only')
  const fd = fs.openSync(bootstrapPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  const stat = fs.fstatSync(fd)
  if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 4096) {
    fs.closeSync(fd); throw new Error('Unsafe helper bootstrap')
  }
  let bootstrap
  try { bootstrap = JSON.parse(fs.readFileSync(fd, 'utf8')) } finally { fs.closeSync(fd) }
  if (!/^[a-f0-9]{64}$/.test(bootstrap.token || '') ||
      bootstrap.socket !== path.join(path.dirname(bootstrapPath), 'channel.sock'))
    throw new Error('Invalid helper bootstrap')
  const root = path.resolve(__dirname, '..')
  // Load trusted code before announcing readiness; later restarts use the captured modules.
  require(path.join(root, 'src', 'config.cjs'))
  require(path.join(root, 'src', 'transport-config.cjs'))
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'magnetgate-root-'))
  fs.chmodSync(runtime, 0o700)
  const exe = path.join(runtime, 'sing-box')
  // Freeze the authorized executable for this helper's lifetime. Later user-data/bundle
  // edits must not replace a binary that is restarted without another administrator prompt.
  const binaryFd = fs.openSync(path.join(root, 'tools', 'sing-box', 'sing-box'),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const binaryStat = fs.fstatSync(binaryFd)
    if (!binaryStat.isFile() || binaryStat.size > 256 * 1024 * 1024)
      throw new Error('Unsafe macOS engine file')
    const binary = fs.readFileSync(binaryFd)
    const pins = require(path.join(root, 'scripts', 'pins.json'))
    const pin = pins.singBox.darwin[
      process.arch === 'x64' ? 'amd64' : process.arch]
    if (!pin || crypto.createHash('sha256').update(binary).digest('hex') !== pin.binarySha256)
      throw new Error('Unpinned macOS engine')
    fs.writeFileSync(exe, binary, { mode: 0o700 })
    const ruleDir = path.join(runtime, 'tools', 'sing-box')
    fs.mkdirSync(ruleDir, { recursive: true, mode: 0o700 })
    for (const name of ['refilter-domains.srs', 'refilter-ip.srs', 'tunnel-userlist.srs']) {
      const source = path.join(root, 'tools', 'sing-box', name)
      if (name === 'tunnel-userlist.srs' && !fs.existsSync(source)) continue
      const ruleFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      try {
        const ruleStat = fs.fstatSync(ruleFd)
        if (!ruleStat.isFile() || ruleStat.size > 64 * 1024 * 1024)
          throw new Error('Unsafe macOS rule file')
        const rules = fs.readFileSync(ruleFd)
        const expected = (pins.ruleSets[name] || pins.localAssets[name]).sha256
        if (crypto.createHash('sha256').update(rules).digest('hex') !== expected)
          throw new Error('Unpinned macOS rules')
        fs.writeFileSync(path.join(ruleDir, name), rules, { mode: 0o600 })
      } finally { fs.closeSync(ruleFd) }
    }
  } catch (err) {
    fs.rmSync(runtime, { recursive: true, force: true }); throw err
  } finally { fs.closeSync(binaryFd) }
  const configPath = path.join(runtime, 'vpn.json')
  const socket = net.createConnection(bootstrap.socket)
  let child = null, chain = Promise.resolve(), closing = false, lastPing = Date.now()
  async function stop() {
    const old = child
    if (!old) { fs.rmSync(configPath, { force: true }); return }
    await new Promise(resolve => {
      if (old.exitCode !== null || old.signalCode !== null) return resolve()
      const timer = setTimeout(() => old.kill('SIGKILL'), 5000)
      old.once('exit', () => { clearTimeout(timer); resolve() })
      old.kill('SIGTERM')
    })
    if (child === old) child = null
    fs.rmSync(configPath, { force: true })
  }
  async function close() {
    if (closing) return
    closing = true
    clearInterval(watchdog)
    socket.destroy()
    await chain.catch(() => {})
    await stop()
    fs.rmSync(runtime, { recursive: true, force: true })
  }
  const channel = peer(socket, bootstrap.token, (op, input) => {
    if (op === 'ping') { lastPing = Date.now(); return true }
    if (!['start', 'stop'].includes(op)) throw new Error('Unsupported helper operation')
    const operation = async () => {
      if (closing) throw new Error('Helper is closing')
      if (op === 'stop') { await stop(); return true }
      const conf = safeConfig(root, input, process.execPath, runtime)
      await stop()
      if (closing) throw new Error('Helper is closing')
      fs.writeFileSync(configPath, JSON.stringify(conf), { mode: 0o600 })
      child = spawn(exe, ['run', '-c', configPath], { cwd: path.dirname(exe), env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } })
      const owned = child
      for (const [name, stream] of [['stdout', owned.stdout], ['stderr', owned.stderr]])
        stream.on('data', data => {
          try { channel.send(name, String(data).slice(0, 8192)) } catch { void close() }
        })
      owned.on('error', () => {
        if (child === owned) child = null
        try { channel.send('exit', { code: 1, signal: null }) } catch {}
      })
      owned.once('exit', (code, signal) => {
        if (child === owned) child = null
        try { channel.send('exit', { code, signal }) } catch {}
      })
      return { pid: owned.pid }
    }
    const result = chain.then(operation)
    chain = result.catch(() => {})
    return result
  })
  socket.once('connect', () => channel.send('hello', { pid: process.pid }))
  socket.once('close', () => { void close() })
  const watchdog = setInterval(() => {
    if (Date.now() - lastPing > 15000) void close()
  }, 2000)
  process.on('SIGTERM', () => { void close() })
  process.on('SIGINT', () => { void close() })
}

if (require.main === module) serve(process.argv[2]).catch(() => { process.exitCode = 1 })
module.exports = { safeConfig }
