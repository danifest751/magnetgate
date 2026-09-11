// Client-side data-plane supervisor: runs a bundled sing-box as the Reality/hysteria2 engine.
// Given a data-plane endpoint from the offer, it writes a sing-box config (a local SOCKS inbound +
// the matching camouflaged outbound) and manages the subprocess; magnetgate then routes proxied
// connections through that local SOCKS. The native "mgt" channel stays as the fallback.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS = path.join(REPO, 'tools', 'sing-box')
const BIN = path.join(TOOLS, process.platform === 'win32' ? 'sing-box.exe' : 'sing-box')

function buildConfig(dp, socksPort) {
  const inbounds = [{ type: 'socks', listen: '127.0.0.1', listen_port: socksPort }]
  let out
  if (dp.t === 'reality') {
    out = {
      type: 'vless', server: dp.host, server_port: dp.port, uuid: dp.uuid, flow: 'xtls-rprx-vision',
      tls: {
        enabled: true, server_name: dp.sni,
        utls: { enabled: true, fingerprint: dp.fp || 'chrome' },
        reality: { enabled: true, public_key: dp.pbk, short_id: dp.sid },
      },
    }
  } else if (dp.t === 'hy2') {
    out = {
      type: 'hysteria2', server: dp.host, server_port: dp.port, password: dp.pw,
      obfs: { type: 'salamander', password: dp.obfs },
      tls: { enabled: true, insecure: !!dp.insecure, alpn: ['h3'] },
    }
  } else throw new Error(`unsupported data-plane type: ${dp.t}`)
  return { log: { level: 'warn' }, inbounds, outbounds: [out] }
}

const dpKey = (dp) => JSON.stringify(dp)

function waitPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tryOnce = () => {
      const s = net.connect(port, host)
      s.on('connect', () => { s.destroy(); resolve(true) })
      s.on('error', () => { s.destroy(); if (Date.now() > deadline) resolve(false); else setTimeout(tryOnce, 250) })
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
    this.cfgPath = path.join(TOOLS, 'client-config.json')
  }

  available() { return fs.existsSync(BIN) }

  // ensure sing-box is running for this dp; resolves true when the local SOCKS accepts connections.
  // All ensure/stop operations are serialized on one chain so overlapping offers (e.g. rapid
  // rotations) can't spawn two sing-box that fight over the SOCKS port.
  ensure(dp) {
    if (!this.available()) return Promise.resolve(false)
    const key = dpKey(dp)
    this.chain = (this.chain || Promise.resolve()).then(() => this._ensure(key, dp)).catch(() => false)
    return this.chain
  }

  async _ensure(key, dp) {
    if (this.proc && this.ready && this.curKey === key) return true
    if (this.proc) await this._stop() // different endpoint or a dead proc: tear down and wait for exit first
    try { fs.mkdirSync(TOOLS, { recursive: true }) } catch {}
    try { fs.writeFileSync(this.cfgPath, JSON.stringify(buildConfig(dp, this.socksPort))) } catch (e) { this.log(`[dp] config write failed: ${e.message}`); return false }
    this.curKey = key
    this.ready = false
    const proc = spawn(BIN, ['run', '-c', this.cfgPath], { stdio: 'ignore', windowsHide: true })
    this.proc = proc
    proc.on('exit', (code) => { if (this.proc === proc) { this.proc = null; this.ready = false; this.curKey = null } this.log(`[dp] sing-box exited (code=${code})`) })
    proc.on('error', (e) => { this.log(`[dp] sing-box spawn error: ${e.message}`) })
    this.ready = await waitPort('127.0.0.1', this.socksPort, 8000)
    if (this.ready) this.log(`[dp] ${dp.t} data plane up (sing-box socks 127.0.0.1:${this.socksPort})`)
    else { this.log(`[dp] ${dp.t} data plane failed to come up`); await this._stop() }
    return this.ready
  }

  // kill the current sing-box and wait for it to exit + a short grace for the OS to release the port
  _stop() {
    return new Promise((resolve) => {
      const proc = this.proc
      this.proc = null; this.ready = false; this.curKey = null
      if (!proc) return resolve()
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      proc.once('exit', () => setTimeout(finish, 300))
      try { proc.kill() } catch { finish() }
      setTimeout(finish, 3000)
    })
  }

  stop() { this.chain = (this.chain || Promise.resolve()).then(() => this._stop()); return this.chain }
}

// Minimal SOCKS5 (no-auth) client: connect through a local SOCKS proxy to host:port.
// Resolves { sock, leftover } once the tunnel is established (sock is a raw duplex to the target).
export function socks5Connect(socksPort, host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(socksPort, '127.0.0.1')
    let stage = 0, buf = Buffer.alloc(0)
    const fail = (m) => { try { s.destroy() } catch {}; reject(new Error(m)) }
    s.on('error', (e) => fail(e.message))
    s.on('connect', () => { try { s.write(Buffer.from([5, 1, 0])) } catch (e) { fail(e.message) } })
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      if (stage === 0) {
        if (buf.length < 2) return
        if (buf[0] !== 5 || buf[1] !== 0x00) return fail('socks method rejected')
        buf = buf.subarray(2); stage = 1
        const hb = Buffer.from(String(host), 'latin1')
        const req = Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb, Buffer.from([(port >> 8) & 0xff, port & 0xff])])
        try { s.write(req) } catch (e) { return fail(e.message) }
      }
      if (stage === 1) {
        if (buf.length < 5) return
        const atyp = buf[3]
        const need = atyp === 1 ? 10 : atyp === 4 ? 22 : (5 + buf[4] + 2)
        if (buf.length < need) return
        if (buf[1] !== 0x00) return fail(`socks connect failed (rep=${buf[1]})`)
        const leftover = buf.subarray(need)
        stage = 2
        s.removeAllListeners('data')
        s.removeAllListeners('error')
        resolve({ sock: s, leftover })
      }
    })
  })
}
