// Client-side data-plane supervisor: runs a bundled sing-box as the Reality/hysteria2 engine.
// Given a data-plane endpoint from the offer, it writes a sing-box config (a local SOCKS inbound +
// the matching camouflaged outbound) and manages the subprocess; magnetgate then routes proxied
// connections through that local SOCKS. The native "mgt" channel stays as the fallback.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { transportOutbound } from './transport-config.cjs'
import { encodeAddress } from './address.mjs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS = path.join(REPO, 'tools', 'sing-box')
const BIN = path.join(TOOLS, process.platform === 'win32' ? 'sing-box.exe' : 'sing-box')

function buildConfig(dp, socksPort) {
  return {
    log: { level: 'warn' },
    inbounds: [{ type: 'socks', listen: '127.0.0.1', listen_port: socksPort }],
    outbounds: [transportOutbound(dp)]
  }
}

const dpKey = (dp) => JSON.stringify(dp)

// --- temp-config housekeeping ---------------------------------------------------------------------
// Each engine writes a sing-box config holding Reality/hysteria2 credentials into the temp dir. A hard
// kill (crash, kill -9, power loss) leaves it behind, so clean up after dead processes at startup and
// remove our own file on a clean exit.
const liveConfigs = new Set()
process.on('exit', () => {
  for (const p of liveConfigs) {
    try {
      fs.unlinkSync(p)
    } catch {}
  }
})

export function sweepStaleConfigs() {
  const dir = os.tmpdir()
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const m = /^magnetgate-dp-(\d+)-[0-9a-f]+\.json$/.exec(name)
    if (!m) continue
    const pid = Number(m[1])
    if (pid === process.pid) continue
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch (err) {
      alive = err && err.code === 'EPERM' // exists but owned by someone else
    }
    if (alive) continue
    try {
      fs.unlinkSync(path.join(dir, name))
      removed++
    } catch {}
  }
  return removed
}

let swept = false

function waitPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tryOnce = () => {
      const s = net.connect(port, host)
      s.on('connect', () => {
        s.destroy()
        resolve(true)
      })
      s.on('error', () => {
        s.destroy()
        if (Date.now() > deadline) resolve(false)
        else setTimeout(tryOnce, 250)
      })
    }
    tryOnce()
  })
}

export class DpSupervisor {
  constructor({ socksPort = 1081, log = () => {} } = {}) {
    this.socksPort = socksPort
    this.log = log
    this.proc = null
    this.curKey = null
    this.ready = false
    this.starting = null
    this.cfgPath = path.join(
      os.tmpdir(),
      'magnetgate-dp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.json'
    )
    liveConfigs.add(this.cfgPath)
  }

  available() {
    return fs.existsSync(BIN)
  }

  // ensure sing-box is running for this dp; resolves true when the local SOCKS accepts connections.
  // All ensure/stop operations are serialized on one chain so overlapping offers (e.g. rapid
  // rotations) can't spawn two sing-box that fight over the SOCKS port.
  ensure(dp) {
    if (!this.available()) return Promise.resolve(false)
    if (!swept) {
      swept = true
      const removed = sweepStaleConfigs()
      if (removed) this.log(`[dp] removed ${removed} stale engine config(s) from the temp dir`)
    }
    const key = dpKey(dp)
    this.chain = (this.chain || Promise.resolve())
      .then(() => this._ensure(key, dp))
      .catch(() => false)
    return this.chain
  }

  async _ensure(key, dp) {
    if (this.proc && this.ready && this.curKey === key) return true
    if (this.proc) await this._stop() // different endpoint or a dead proc: tear down and wait for exit first
    try {
      fs.mkdirSync(TOOLS, { recursive: true })
    } catch {}
    try {
      fs.writeFileSync(this.cfgPath, JSON.stringify(buildConfig(dp, this.socksPort)), {
        mode: 0o600
      })
    } catch (e) {
      this.log(`[dp] config write failed: ${e.message}`)
      return false
    }
    this.curKey = key
    this.ready = false
    const proc = spawn(BIN, ['run', '-c', this.cfgPath], { stdio: 'ignore', windowsHide: true })
    this.proc = proc
    proc.on('exit', (code) => {
      if (this.proc === proc) {
        this.proc = null
        this.ready = false
        this.curKey = null
      }
      this.log(`[dp] sing-box exited (code=${code})`)
    })
    proc.on('error', (e) => {
      this.log(`[dp] sing-box spawn error: ${e.message}`)
    })
    this.ready =
      (await waitPort('127.0.0.1', this.socksPort, 8000)) &&
      this.proc === proc &&
      proc.exitCode === null
    if (this.ready)
      this.log(`[dp] ${dp.t} data plane up (sing-box socks 127.0.0.1:${this.socksPort})`)
    else {
      this.log(`[dp] ${dp.t} data plane failed to come up`)
      await this._stop()
    }
    return this.ready
  }

  // kill the current sing-box and wait for it to exit + a short grace for the OS to release the port
  _stop() {
    return new Promise((resolve, reject) => {
      const proc = this.proc
      this.ready = false
      if (!proc) return resolve()
      const finish = () => {
        clearTimeout(timer)
        if (this.proc === proc) {
          this.proc = null
          this.curKey = null
        }
        try {
          fs.unlinkSync(this.cfgPath)
        } catch {}
        resolve()
      }
      const timer = setTimeout(() => {
        proc.removeListener('exit', finish)
        reject(new Error('data-plane process did not stop'))
      }, 5000)
      proc.once('exit', finish)
      if (proc.exitCode !== null || proc.signalCode !== null) return finish()
      try {
        proc.kill()
      } catch (err) {
        clearTimeout(timer)
        proc.removeListener('exit', finish)
        reject(err)
      }
    })
  }

  stop() {
    this.chain = (this.chain || Promise.resolve()).then(() => this._stop())
    return this.chain
  }
}

// Minimal SOCKS5 (no-auth) client: connect through a local SOCKS proxy to host:port.
// Resolves { sock, leftover } once the tunnel is established (sock is a raw duplex to the target).
export function socks5Connect(socksPort, host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socksPort, '127.0.0.1')
    let stage = 0,
      buf = Buffer.alloc(0),
      done = false
    const finish = (err, result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.removeListener('data', onData)
      sock.removeListener('error', fail)
      sock.removeListener('close', closed)
      if (err) {
        sock.destroy()
        reject(err)
      } else {
        sock.pause()
        resolve(result)
      }
    }
    const fail = (err) => finish(err),
      closed = () => finish(new Error('SOCKS closed'))
    const timer = setTimeout(() => finish(new Error('SOCKS timeout')), 10000)
    const onData = (data) => {
      buf = Buffer.concat([buf, data])
      if (buf.length > 128 * 1024) return finish(new Error('SOCKS reply too large'))
      if (stage === 0) {
        if (buf.length < 2) return
        if (buf[0] !== 5 || buf[1] !== 0) return finish(new Error('SOCKS auth rejected'))
        buf = buf.subarray(2)
        stage = 1
        try {
          sock.write(Buffer.concat([Buffer.from([5, 1, 0]), encodeAddress(host, port)]))
        } catch (e) {
          return finish(e)
        }
      }
      if (buf.length < 5) return
      if (buf[0] !== 5 || ![1, 3, 4].includes(buf[3]))
        return finish(new Error('invalid SOCKS reply'))
      const need = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4]
      if (buf.length < need) return
      if (buf[1] !== 0) return finish(new Error('SOCKS target rejected'))
      finish(null, { sock, leftover: buf.subarray(need) })
    }
    sock.once('connect', () => sock.write(Buffer.from([5, 1, 0])))
    sock.on('data', onData)
    sock.once('error', fail)
    sock.once('close', closed)
  })
}

// Engines are keyed by complete endpoint generation. Rotation never kills existing streams.
export class DpPool {
  constructor({ log = () => {}, engineFactory = (options) => new DpSupervisor(options) } = {}) {
    this.log = log
    this.engineFactory = engineFactory
    this.entries = new Map()
    this.stopped = false
  }
  available() {
    return fs.existsSync(BIN)
  }
  async connect(dp, target) {
    if (this.stopped) throw new Error('pool stopped')
    const key = dpKey(dp)
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= 32) throw new Error('data-plane engine limit')
      entry = { refs: 0, timer: null, promise: null }
      entry.promise = (async () => {
        const port = await new Promise((resolve, reject) => {
          const server = net.createServer()
          server.on('error', reject)
          server.listen(0, '127.0.0.1', () => {
            const p = server.address().port
            server.close(() => resolve(p))
          })
        })
        const engine = this.engineFactory({ socksPort: port, log: this.log })
        entry.engine = engine
        return engine
      })()
      this.entries.set(key, entry)
    }
    clearTimeout(entry.timer)
    entry.refs++
    const release = () => {
      entry.refs--
      if (!entry.refs && !this.stopped)
        entry.timer = setTimeout(async () => {
          try {
            await entry.engine?.stop()
            if (this.entries.get(key) === entry) this.entries.delete(key)
          } catch (err) {
            this.log('[dp] stop failed: ' + err.message)
          }
        }, 30000)
    }
    try {
      const engine = await entry.promise
      if (this.stopped) throw new Error('pool stopped')
      if (!(await engine.ensure(dp))) throw new Error('data-plane engine could not restart')
      const result = await socks5Connect(engine.socksPort, target.host, target.port)
      result.sock.once('close', release)
      return result
    } catch (e) {
      release()
      throw e
    }
  }
  async stop() {
    this.stopped = true
    await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        clearTimeout(entry.timer)
        try {
          await entry.promise
        } catch {}
        await entry.engine?.stop()
      })
    )
    this.entries.clear()
  }
}
