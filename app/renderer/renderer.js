/* renderer: talks to the main process only through window.mg (see preload.js). */
const $ = (id) => document.getElementById(id)
const fmtBytes = (n) => {
  n = n || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}
const fmtSpeed = (bps) => `${fmtBytes(bps)}/s`
let cfg = { exits: [], localPort: 1080, singboxPort: 1081, bootstrap: [] }
let st = { clientRunning: false, route: null, egress: null, vpnOn: false, lastError: null }

// ---------- config form ----------
function renderExits() {
  const box = $('exits')
  box.innerHTML = ''
  if (!cfg.exits.length) {
    const p = document.createElement('p')
    p.className = 'muted'
    p.textContent = 'No exits yet — add one and paste or generate a PSK (≥128-bit).'
    box.appendChild(p)
  }
  cfg.exits.forEach((ex, i) => {
    const row = document.createElement('div')
    row.className = 'exit'
    row.innerHTML = `
      <div class="field"><label>Name</label><input data-i="${i}" data-k="name" value="${escapeHtml(ex.name || '')}" placeholder="nl" /></div>
      <div class="field"><label>PSK</label><input data-i="${i}" data-k="psk" value="${escapeHtml(ex.psk || '')}" placeholder="shared secret" /></div>
      <div class="field"><label>&nbsp;</label><div class="row">
        <button data-gen="${i}">Gen</button>
        <button data-del="${i}" class="danger">✕</button>
      </div></div>`
    box.appendChild(row)
  })
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }

function readForm() {
  cfg.localPort = parseInt($('localPort').value, 10) || 1080
  cfg.singboxPort = parseInt($('singboxPort').value, 10) || 1081
  cfg.bootstrap = $('bootstrap').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

function fillForm() {
  $('localPort').value = cfg.localPort ?? 1080
  $('singboxPort').value = cfg.singboxPort ?? 1081
  $('bootstrap').value = (cfg.bootstrap || []).join('\n')
  renderExits()
}

// ---------- status ----------
function renderStatus() {
  $('sClient').textContent = st.clientRunning ? 'running' : 'stopped'
  $('sRoute').textContent = st.route || '—'
  $('sEgress').textContent = st.egress || '—'
  $('dot').classList.toggle('on', !!(st.clientRunning && st.egress))
  $('btnClient').textContent = st.clientRunning ? 'Stop client' : 'Start client'
  $('btnClient').classList.toggle('primary', !st.clientRunning)
  $('btnClient').classList.toggle('danger', st.clientRunning)
  const other = st.otherTunnel
  const vpnBtn = $('btnVpn')
  if (st.vpnOn) { vpnBtn.textContent = 'Disable system VPN'; vpnBtn.disabled = false }
  else if (other) { vpnBtn.textContent = `Turn off ${other} first`; vpnBtn.disabled = true }
  else { vpnBtn.textContent = 'Enable system VPN'; vpnBtn.disabled = false }
  const pill = $('vpnPill')
  pill.textContent = st.vpnOn ? (st.vpnHealthy ? 'VPN on' : 'VPN starting…') : (other ? `${other} active` : 'VPN off')
  pill.classList.toggle('on', st.vpnOn && st.vpnHealthy)
  $('err').textContent = st.lastError || ''
  const warn = $('tunWarn')
  if (warn) { warn.hidden = !other; warn.textContent = other ? `Another full tunnel is active (${other}). Turn it off to use the system VPN — they can't share Wintun.` : '' }
  const s = st.stats || {}
  const statsEl = $('stats')
  const showStats = st.vpnOn && st.vpnHealthy
  if (statsEl) {
    statsEl.hidden = !showStats
    if (showStats) statsEl.innerHTML = `↓ <b>${fmtSpeed(s.downBps)}</b>&nbsp;&nbsp; ↑ <b>${fmtSpeed(s.upBps)}</b>&nbsp;&nbsp; · &nbsp;<b>${s.conns || 0}</b> conns &nbsp; · &nbsp; ${fmtBytes(s.down)} down / ${fmtBytes(s.up)} up`
  }
}

function appendLog(line) {
  const el = $('log')
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20
  el.textContent += (el.textContent ? '\n' : '') + line
  if (atBottom) el.scrollTop = el.scrollHeight
}

// ---------- wire up ----------
window.addEventListener('DOMContentLoaded', async () => {
  cfg = await window.mg.getConfig()
  fillForm()
  st = await window.mg.getState()
  renderStatus()
  for (const l of await window.mg.getLog()) appendLog(l)

  window.mg.onStatus((s) => { st = s; renderStatus() })
  window.mg.onLog((l) => appendLog(l))

  $('btnClient').addEventListener('click', async () => {
    if (st.clientRunning) await window.mg.stopClient()
    else { readForm(); await window.mg.saveConfig(cfg); await window.mg.startClient() }
  })
  $('btnVpn').addEventListener('click', async () => {
    if (st.vpnOn) await window.mg.vpnOff(); else await window.mg.vpnOn()
  })
  $('btnAddExit').addEventListener('click', () => { cfg.exits.push({ name: '', psk: '' }); renderExits() })
  $('btnSave').addEventListener('click', async () => {
    readForm(); cfg = await window.mg.saveConfig(cfg)
    $('saved').textContent = 'saved ✓'; setTimeout(() => { $('saved').textContent = '' }, 2000)
  })
  $('btnOpenDir').addEventListener('click', () => window.mg.openConfigDir())
  $('btnLogs').addEventListener('click', () => window.mg.openLogs())
  try { $('logPath').textContent = 'log file: ' + await window.mg.getLogPath() } catch {}

  // delegated handlers for the dynamic exit rows
  $('exits').addEventListener('input', (e) => {
    const t = e.target
    if (t.dataset.k !== undefined) cfg.exits[+t.dataset.i][t.dataset.k] = t.value
  })
  $('exits').addEventListener('click', async (e) => {
    const t = e.target
    if (t.dataset.del !== undefined) { cfg.exits.splice(+t.dataset.del, 1); renderExits() }
    else if (t.dataset.gen !== undefined) { cfg.exits[+t.dataset.gen].psk = await window.mg.genPsk(); renderExits() }
  })
})
