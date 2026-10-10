const { spawn } = require('node:child_process')
const I18n = require('./renderer/i18n.js')
const { createInterface } = require('node:readline')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

class PeerHost {
  constructor({ root, profile, platform = process.platform, onStatus = () => {}, spawnChild = spawn }) {
    this.executable = path.join(root, 'tools', 'peer', platform === 'win32' ? 'peer-node.exe' : 'peer-node')
    this.profile = profile
    this.onStatus = onStatus
    this.spawnChild = spawnChild
    this.pending = new Map()
    this.state = { configured: false, state: 'OFFLINE', countries: [], policy: {
      enabled: false, automatic: true, maxMbps: 5, maxGuests: 2,
      dailyBytes: 1073741824, monthlyBytes: 21474836480
    } }
    this.endpoint = null
  }
  async start() {
    if (this.starting) return this.starting
    if (this.child) return this.state
    if (!fs.existsSync(this.executable)) throw new Error(I18n.t('peerHost.notBuilt'))
    this.starting = new Promise((resolve, reject) => {
      const child = this.spawnChild(this.executable, ['--profile', this.profile], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      })
      this.child = child
      let first = true
      const timer = setTimeout(() => {
        reject(new Error(I18n.t('peerHost.noAnswer')))
        child.stdin.destroy()
      }, 12000)
      const lines = createInterface({ input: child.stdout })
      lines.on('line', line => {
        if (this.child !== child) return
        if (line.length > 65536) { child.stdin.destroy(); return }
        let message
        try { message = JSON.parse(line) } catch { child.stdin.destroy(); return }
        if (message.status) {
          this.state = message.status
          this.onStatus(this.state)
          if (first) { first = false; clearTimeout(timer); resolve(this.state) }
        }
        if (message.type === 'reply') {
          const request = this.pending.get(message.id)
          if (!request) return
          this.pending.delete(message.id)
          clearTimeout(request.timer)
          if (message.error) request.reject(new Error(message.error))
          else request.resolve(message)
        }
      })
      // Diagnostics are bounded and never copy configuration or endpoint secrets.
      let error = ''
      child.stderr.on('data', b => { error = (error + String(b)).slice(-2048) })
      const ended = err => {
        clearTimeout(timer)
        lines.close()
        if (this.child !== child) return
        this.child = null
        this.endpoint = null
        this.state = { ...this.state, connected: false, sharing: false,
          guestConnected: false, countries: [], state: 'OFFLINE', error: err.message }
        this.onStatus(this.state)
        for (const request of this.pending.values()) {
          clearTimeout(request.timer); request.reject(err)
        }
        this.pending.clear()
        if (first) reject(err)
      }
      child.once('error', ended)
      child.stdin.on('error', err => {
        // A broken administration pipe makes the child unavailable, but its
        // process remains owned until exit so shutdown can still wait for it.
        for (const request of this.pending.values()) {
          clearTimeout(request.timer); request.reject(err)
        }
        this.pending.clear()
        child.stdin.destroy()
      })
      child.once('exit', code => ended(new Error(error.trim() || `Peer host stopped (${code})`)))
    }).finally(() => { this.starting = null })
    return this.starting
  }
  async request(command, fields = {}) {
    await this.start()
    if (!this.child || this.pending.size >= 16) throw new Error('Peer host unavailable')
    const id = crypto.randomBytes(16).toString('hex')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Peer request timed out')) }, 10000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ ...fields, id, command }) + '\n', err => {
        if (!err) return
        clearTimeout(timer); this.pending.delete(id); reject(err)
      })
    })
  }
  async connect(country, port) {
    const reply = await this.request('connect', { country, port })
    if (!reply.endpoint || reply.endpoint.port !== port || !/^[A-Z]{2}$/.test(reply.endpoint.country) ||
      !/^[a-f0-9]{48}$/.test(reply.endpoint.username) || !/^[a-f0-9]{48}$/.test(reply.endpoint.password))
      throw new Error('Invalid peer endpoint')
    this.endpoint = reply.endpoint
    return this.endpoint
  }
  async disconnect() {
    if (this.child) {
      try { await this.request('disconnect') } catch { await this.close() }
    }
    this.endpoint = null
  }
  async suspend(suspended) { if (this.child) await this.request('suspend', { suspended }) }
  async policy(policy) { return (await this.request('policy', { policy })).status }
  async close() {
    if (this.starting) await this.starting.catch(() => {})
    const child = this.child
    if (!child) return
    const exited = new Promise(resolve => child.once('exit', resolve))
    // EOF is also a shutdown command. A lost RPC reply must not keep a child
    // alive or prevent native VPN cleanup; wait for actual exit below.
    try { await this.request('stop') } catch {}
    child.stdin.end()
    let timer
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Peer host has not stopped')), 5000)
      })])
    } finally { clearTimeout(timer) }
  }
}
module.exports = { PeerHost }
