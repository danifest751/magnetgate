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

  // ensure sing-box is running for this dp; resolves true when the local SOCKS accepts connections
  ensure(dp) {
    if (!this.available()) return Promise.resolve(false)
    const key = dpKey(dp)
    if (this.proc && this.ready && this.curKey === key) return Promise.resolve(true)
    if (this.starting && this.curKey === key) return this.starting
    if (this.proc && this.curKey !== key) this.stop() // endpoint changed (e.g. rotation) -> restart
    this.curKey = key
    this.starting = (async () => {
      try { fs.mkdirSync(TOOLS, { recursive: true }) } catch {}
      try { fs.writeFileSync(this.cfgPath, JSON.stringify(buildConfig(dp, this.socksPort))) } catch (e) { this.log(`[dp] config write failed: ${e.message}`); return false }
      this.proc = spawn(BIN, ['run', '-c', this.cfgPath], { stdio: 'ignore', windowsHide: true })
      this.proc.on('exit', (code) => { this.log(`[dp] sing-box exited (code=${code})`); this.proc = null; this.ready = false; this.curKey = null })
      this.proc.on('error', (e) => { this.log(`[dp] sing-box spawn error: ${e.message}`); this.proc = null; this.ready = false })
      this.ready = await waitPort('127.0.0.1', this.socksPort, 8000)
      if (this.ready) this.log(`[dp] ${dp.t} data plane up (sing-box socks 127.0.0.1:${this.socksPort})`)
      else { this.log(`[dp] ${dp.t} data plane failed to come up`); this.stop() }
      this.starting = null
      return this.ready
    })()
    return this.starting
  }

  stop() {
    if (this.proc) { try { this.proc.kill() } catch {} }
    this.proc = null; this.ready = false; this.curKey = null; this.starting = null
  }
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
