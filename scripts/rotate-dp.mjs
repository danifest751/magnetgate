#!/usr/bin/env node
// Rotates the Reality/hysteria2 credentials on the exit, keeping the previous generation valid for
// a grace window (one rotation interval) so clients that have not rediscovered yet keep working.
//
// Stable identity (kept across rotations): the Reality x25519 keypair, the hy2 obfs password and the
// hy2 TLS cert. Rotated each run: the Reality shortId + uuid and the hy2 auth password.
//
// Writes /etc/sing-box/config.json (users/short_id = [new, previous]) and /etc/magnetgate-dp.json
// (advertising only the NEW generation), validates the config, and restarts sing-box. The magnetgate
// exit picks up the new dp file on its next publish; the client's supervisor restarts sing-box with
// the new params when it sees the changed offer. A rotation restarts sing-box, so in-flight
// connections blip and reconnect — keep the interval coarse (hours/daily).
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'

const DIR = '/etc/sing-box'
const CFG = `${DIR}/config.json`
const KEEP = `${DIR}/keep.json`
const STATE = `${DIR}/rotation-state.json`
const DP = '/etc/magnetgate-dp.json'
const EXIT_IP = process.env.MAGNETGATE_PUBLIC_HOST || '<exit-ip>'
const SNI = process.env.MAGNETGATE_REALITY_SNI || 'www.microsoft.com'
const HY2_CRT = `${DIR}/hy2.crt`
// the hy2 self-signed cert's SAN (see setup-singbox.sh); clients pin the cert and verify this name
const HY2_SNI = process.env.MAGNETGATE_HY2_SNI || 'magnetgate'

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2))
const chmodGrp = (p, grp) => { try { execSync(`chgrp ${grp} ${p} && chmod 640 ${p}`) } catch {} }

// stable identity — migrate from the existing config/dp on first run so the Reality public key
// (which clients pin) does not change
let keep
if (fs.existsSync(KEEP)) {
  keep = readJson(KEEP)
} else {
  const cfg = readJson(CFG)
  const dp = readJson(DP).dp
  const realIn = cfg.inbounds.find((i) => i.tag === 'reality-in')
  const hy2In = cfg.inbounds.find((i) => i.tag === 'hy2-in')
  keep = { rpriv: realIn.tls.reality.private_key, rpub: dp.find((d) => d.t === 'reality').pbk, hy2obfs: hy2In.obfs.password }
  writeJson(KEEP, keep); chmodGrp(KEEP, 'sing-box')
}

let prev = fs.existsSync(STATE) ? readJson(STATE) : null
// first run (no state): seed the grace slot from the currently-advertised generation so the
// pre-existing credentials keep working through the first rotation too
if (!prev) {
  try {
    const dpNow = readJson(DP).dp
    const r = dpNow.find((d) => d.t === 'reality'); const h = dpNow.find((d) => d.t === 'hy2')
    if (r && h) prev = { uuid: r.uuid, sid: r.sid, pw: h.pw }
  } catch {}
}
const gen = { uuid: crypto.randomUUID(), sid: crypto.randomBytes(8).toString('hex'), pw: crypto.randomBytes(16).toString('hex') }

const uuids = [gen.uuid, ...(prev ? [prev.uuid] : [])]
const sids = [gen.sid, ...(prev ? [prev.sid] : [])]
const pws = [gen.pw, ...(prev ? [prev.pw] : [])]

const config = {
  log: { level: 'warn' },
  inbounds: [
    {
      type: 'vless', tag: 'reality-in', listen: '::', listen_port: 443,
      users: uuids.map((u) => ({ uuid: u, flow: 'xtls-rprx-vision' })),
      tls: {
        enabled: true, server_name: SNI,
        reality: { enabled: true, handshake: { server: SNI, server_port: 443 }, private_key: keep.rpriv, short_id: sids },
      },
    },
    {
      type: 'hysteria2', tag: 'hy2-in', listen: '::', listen_port: 443,
      users: pws.map((p) => ({ password: p })),
      obfs: { type: 'salamander', password: keep.hy2obfs },
      tls: { enabled: true, alpn: ['h3'], certificate_path: `${DIR}/hy2.crt`, key_path: `${DIR}/hy2.key` },
    },
  ],
  outbounds: [{ type: 'direct', tag: 'direct' }, { type: 'block', tag: 'block' }],
  route: { rules: [{ ip_is_private: true, outbound: 'block' }], final: 'direct' },
}
writeJson(CFG, config); chmodGrp(CFG, 'sing-box')

// hy2 is advertised with its pinned self-signed cert (carried to clients over the Nostr channel,
// which has no size limit) instead of `insecure`; the cert is stable across rotations.
const hy2ca = fs.readFileSync(HY2_CRT, 'utf8').trim()
writeJson(DP, {
  dp: [
    { t: 'reality', host: EXIT_IP, port: 443, uuid: gen.uuid, pbk: keep.rpub, sni: SNI, sid: gen.sid, fp: 'chrome' },
    { t: 'hy2', host: EXIT_IP, port: 443, pw: gen.pw, obfs: keep.hy2obfs, sni: HY2_SNI, ca: hy2ca },
  ],
})
chmodGrp(DP, 'magnetgate')

writeJson(STATE, gen); chmodGrp(STATE, 'sing-box')

// validate before restarting; if invalid, execSync throws and the running config is left untouched
execSync(`sing-box check -c ${CFG}`)
execSync('systemctl restart sing-box')
console.log(`${new Date().toISOString()} rotated dp: sid=${gen.sid} uuid=${gen.uuid.slice(0, 8)}… (grace: ${prev ? 'previous kept' : 'none'})`)
