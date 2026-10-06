const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { peer } = require('./mac-protocol.cjs')

const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'"
function authorizationScript(exe, helper, bootstrap) {
  const command = '/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin ELECTRON_RUN_AS_NODE=1 ' +
    [exe, helper, bootstrap].map(shellQuote).join(' ')
  return 'do shell script ' + JSON.stringify(command) + ' with administrator privileges'
}

class MacEngine {
  constructor({ authorize = spawn, onAuthorizing = () => {} } = {}) {
    this.authorize = authorize
    this.onAuthorizing = onAuthorizing
    this.session = null
    this.sessions = new Set()
    this.child = null
  }
  async prepare(signal) {
    signal?.throwIfAborted()
    if (this.session && !this.session.socket.destroyed) return
    if (this.child) throw new Error('Previous macOS engine is still stopping; retry Disconnect')
    this.onAuthorizing(true)
    // Keep below Darwin's sockaddr_un path limit, including on hosts with long TMPDIR values.
    const dir = fs.mkdtempSync('/tmp/mg-')
    fs.chmodSync(dir, 0o700)
    const bootstrap = path.join(dir, 'bootstrap.json')
    const socketPath = path.join(dir, 'channel.sock')
    const token = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(bootstrap, JSON.stringify({ socket: socketPath, token }), { mode: 0o600 })
    const server = net.createServer()
    let launcher, socket, channel, heartbeat, accepted = false, session
    const cleanup = () => {
      clearInterval(heartbeat)
      socket?.destroy()
      for (const candidate of candidates) candidate.destroy()
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
      if (this.session?.server === server) this.session = null
    }
    const candidates = new Set()
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      fs.chmodSync(socketPath, 0o600)
      await new Promise((resolve, reject) => {
        const abort = () => {
          finish(signal?.reason || new Error('macOS authorization cancelled'))
          cleanup(); launcher?.kill()
        }
        const timer = setTimeout(() => {
          finish(new Error('macOS authorization timed out')); cleanup(); launcher?.kill()
        }, 120000)
        const finish = err => {
          clearTimeout(timer); signal?.removeEventListener('abort', abort)
          err ? reject(err) : resolve()
        }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) { abort(); finish(signal.reason); return }
        server.on('connection', candidate => {
          if (accepted) { candidate.destroy(); return }
          candidates.add(candidate)
          candidate.once('close', () => candidates.delete(candidate))
          const candidateChannel = peer(candidate, token, undefined, (op, value) => {
            if (op === 'hello' && !accepted && Number.isInteger(value?.pid)) {
              accepted = true; socket = candidate; channel = candidateChannel
              for (const other of candidates) if (other !== socket) other.destroy()
              session = { server, socket, channel, launcher, cleanup, child: null }
              this.session = session
              this.sessions.add(session)
              session.finished = new Promise(done => { session.finish = done })
              heartbeat = setInterval(() => channel.request('ping').catch(() => socket.destroy()), 2000)
              socket.once('close', cleanup)
              finish()
            } else if (candidate === socket) this.notify(op, value, session)
          })
        })
        launcher = this.authorize('/usr/bin/osascript', ['-e', authorizationScript(
          process.execPath, path.join(__dirname, 'mac-helper.cjs'), bootstrap
        )], { stdio: ['ignore', 'ignore', 'pipe'] })
        launcher.stderr.on('data', () => {}) // AppleScript errors may include bootstrap paths.
        launcher.once('error', err => { finish(err); cleanup() })
        launcher.once('exit', code => {
          if (!accepted) finish(new Error('macOS authorization declined or helper could not start'))
          // Successful helper termination happens only after its owned engine has stopped.
          if (code === 0 && session?.child)
            this.notify('exit', { code: 0, signal: null }, session)
          session?.finish(code)
          if (!session?.child) this.sessions.delete(session)
          cleanup()
        })
      })
      signal?.throwIfAborted()
    } catch (err) {
      cleanup(); launcher?.kill()
      if (!signal?.aborted) err.code = 'MAC_AUTH_REQUIRED'
      throw err
    }
    finally { this.onAuthorizing(false) }
  }
  notify(op, value, session) {
    const child = session?.child
    if (!child) return
    if (op === 'stdout' || op === 'stderr') child[op].emit('data', Buffer.from(value))
    else if (op === 'exit') {
      child.exitCode = value.code
      child.signalCode = value.signal
      session.child = null
      if (this.child === child) this.child = null
      child.emit('exit', value.code, value.signal)
    }
  }
  start(input) {
    if (!this.session || this.session.socket.destroyed) throw new Error('macOS helper is not ready')
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.exitCode = null; child.signalCode = null
    const session = this.session
    session.child = child
    this.child = child
    session.channel.request('start', input).then(result => {
      if (!Number.isInteger(result?.pid)) throw new Error('macOS engine did not start')
      child.pid = result.pid
    }).catch(async () => {
      // Expose the handle immediately to EngineController, even if the start reply is lost.
      // Only a confirmed stop reply or successful helper exit may clear ownership.
      try {
        await session.channel.request('stop')
        if (session.child === child) this.notify('exit', { code: 1, signal: null }, session)
      } catch {}
    })
    child.kill = () => { session.channel.request('stop').catch(() => {}); return true }
    return child
  }
  async close() {
    for (const session of this.sessions) {
      if (!session.socket.destroyed) await session.channel.request('stop')
      session.cleanup()
      let timer
      try {
        await Promise.race([session.finished, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('macOS helper is still stopping')), 10000)
        })])
        if (session.child) throw new Error('macOS engine stop is unconfirmed; retry Disconnect')
        this.sessions.delete(session)
      } finally { clearTimeout(timer) }
    }
  }
}
module.exports = { MacEngine, shellQuote, authorizationScript }
