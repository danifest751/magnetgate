const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const { waitForEngineReady } = require('./ready.cjs')

function command(exe, args, options = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, ...options })
    let output = '',
      done = false
    const finish = (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      err ? reject(err) : resolve(output)
    }
    child.stdout?.on('data', (b) => {
      if (output.length < 131072) output += b
    })
    child.stderr?.on('data', (b) => {
      if (output.length < 131072) output += b
    })
    child.once('error', finish)
    child.once('exit', (code) =>
      finish(code !== 0 ? new Error(output.trim() || `${exe} failed (${code})`) : null)
    )
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`${exe} timeout`))
    }, timeout)
  })
}
async function stopChild(
  child,
  { timeoutMs = 30000, execute = command, platform = process.platform } = {}
) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  let requestError
  if (platform === 'win32') {
    try {
      await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], {}, 5000)
    } catch (e) {
      requestError = e
    }
  } else child.kill('SIGTERM')
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer)
      clearInterval(poll)
      child.removeListener('exit', finish)
      resolve()
    }
    const timer = setTimeout(() => {
      clearInterval(poll)
      child.removeListener('exit', finish)
      reject(
        new Error(
          `Owned process ${child.pid} is still stopping; retry Disconnect${requestError ? ': ' + requestError.message : ''}`
        )
      )
    }, timeoutMs)
    const poll = setInterval(() => {
      if (child.exitCode !== null || child.signalCode !== null) finish()
    }, 100)
    child.once('exit', finish)
  })
}

class EngineController {
  constructor({
    exe,
    cwd,
    configPath,
    log,
    onExit,
    execute = command,
    spawnChild = spawn,
    terminate = stopChild,
    waitReady = waitForEngineReady
  }) {
    Object.assign(this, {
      exe,
      cwd,
      configPath,
      log,
      onExit,
      execute,
      spawnChild,
      terminate,
      waitReady
    })
    this.child = null
    this.stopping = new Set()
    this.generation = 0
    this.chain = Promise.resolve()
    this.wanted = false
    this.ready = false
    this.startAbort = null
  }
  get running() {
    return !!this.child
  }
  start(config, beforeStart = async () => {}) {
    this.cancelStart()
    this.wanted = true
    const generation = ++this.generation
    const abort = new AbortController()
    this.startAbort = abort
    const operation = async () => {
      if (generation !== this.generation || !this.wanted) return false
      const candidate = `${this.configPath}.${generation}.candidate`
      try {
        await fs.writeFile(candidate, JSON.stringify(config, null, 2), { mode: 0o600 })
        await this.execute(this.exe, ['check', '-c', candidate], { cwd: this.cwd })
        if (generation !== this.generation || !this.wanted) return false
        await beforeStart()
        if (generation !== this.generation || !this.wanted) return false
        await this.stopOwned()
        if (generation !== this.generation || !this.wanted) return false
        await fs.rename(candidate, this.configPath)
        if (generation !== this.generation || !this.wanted) return false
        const child = this.spawnChild(this.exe, ['run', '-c', this.configPath], {
          cwd: this.cwd,
          windowsHide: true
        })
        this.child = child
        this.ready = false
        this.log(
          `Starting owned VPN process ${child.pid}; TUN=${config.inbounds?.find((i) => i.type === 'tun')?.interface_name}`
        )
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', (b) => this.log(String(b).trim()))
        child.once('error', (err) => {
          if (this.child === child && !this.stopping.has(child)) {
            this.child = null
            this.ready = false
            abort.abort(err)
            this.onExit(err, generation)
          }
        })
        child.once('exit', (code) => {
          if (this.child === child) {
            this.child = null
            this.ready = false
            abort.abort(new Error(`VPN engine stopped (${code})`))
            if (!this.stopping.has(child))
              this.onExit(new Error(`VPN engine stopped (${code})`), generation)
          }
        })
        try {
          await this.waitReady(child, config, abort.signal)
          if (generation !== this.generation || !this.wanted) return false
          this.ready = true
          this.log(`Owned VPN process ${child.pid}: TUN and local endpoints ready`)
          return true
        } catch (err) {
          if (this.child === child) await this.stopOwned()
          if (generation !== this.generation || !this.wanted) return false
          throw err
        }
      } finally {
        await fs.unlink(candidate).catch(() => {})
      }
    }
    const result = this.chain.then(operation)
    this.chain = result.catch(() => {})
    return result
  }
  async stopOwned() {
    this.ready = false
    const old = this.child
    if (!old) return
    this.stopping.add(old)
    try {
      await this.terminate(old)
      if (this.child === old) this.child = null
    } finally {
      this.stopping.delete(old)
    }
  }
  stop() {
    this.cancelStart()
    this.wanted = false
    ++this.generation
    const result = this.chain.then(() => this.stopOwned())
    this.chain = result.catch(() => {})
    return result
  }
  cancelStart() {
    this.wanted = false
    ++this.generation
    this.startAbort?.abort()
    this.startAbort = null
  }
}
module.exports = { EngineController, command, stopChild }
