// Представление состояния не управляет VPN и не принимает решений за основной процесс.
;(function (root) {
  // the UI strings: required in Node (tests), loaded before this file in the window
  const I18n = typeof module !== 'undefined' && module.exports ? require('./i18n.js') : root.MGI18n
  const t = (key, vars) => I18n.t(key, vars)
  function needsDisconnect(state) {
    return !!(state.vpnOn || state.guardRecoveryRequired || state.stopRecoveryRequired)
  }
  function connectionView(config, state) {
    const recovery = !state.vpnOn && (state.guardRecoveryRequired || state.stopRecoveryRequired)
    const pending =
      state.vpnOn &&
      (state.modePending || (state.activeMode && state.activeMode !== config.vpnMode))
    const busy = !!pending || ['rendezvous', 'starting', 'switching', 'authorizing'].includes(state.phase)
    const connected = !!(
      state.vpnOn &&
      state.vpnHealthy &&
      state.phase === 'connected' &&
      state.engineReady !== false &&
      !pending
    )
    const empty = !['peers', 'public'].includes(config.connectionSource) && !config.exits?.length && !needsDisconnect(state)
    let title = t('view.notConnected'),
      detail = t('view.directInUse')
    if (connected) {
      title = t('view.connected')
      detail =
        state.activeMode === 'split'
          ? t('view.splitActive')
          : state.trafficProtected
            ? t('view.fullProtected')
            : t('view.fullActive')
    } else if (recovery) {
      title = t('view.recoveryTitle')
      detail = t('view.recoveryDetail')
    } else if (pending) {
      title = t('view.applyingTitle')
      detail = t('view.applyingDetail')
    } else if (state.phase === 'rendezvous') {
      title = t('view.searchingTitle')
      detail = t('view.searchingDetail')
    } else if (state.phase === 'authorizing') {
      title = t('view.authorizeTitle')
      detail = t('view.authorizeDetail')
    } else if (state.phase === 'starting') {
      title = t('view.checkingTitle')
      detail = t('view.checkingDetail')
    } else if (empty) {
      title = t('view.addServerTitle')
      detail = t('view.addServerDetail')
    } else if (state.otherTunnel) {
      title = t('view.otherVpnTitle')
      detail = t('view.otherVpnDetail')
    }
    let button = t('button.connect')
    if (recovery)
      button = state.guardRecoveryRequired ? t('button.restoreInternet') : t('button.disconnectAgain')
    else if (needsDisconnect(state)) button = busy ? t('button.cancel') : t('button.disconnect')
    else if (empty) button = t('button.addServer')
    else if (state.lastError || state.otherTunnel) button = t('button.retry')
    return { connected, busy, empty, recovery, pending, title, detail, button }
  }
  // Country selector: the list is built from what the nodes advertise — a two-letter code plus how
  // many nodes stand behind it, never an address. Kept here (and returned as plain pairs) so the DOM
  // code stays trivial and this is testable without a browser.
  function countryOptions(countries, selected = '', search = '') {
    const list = Array.isArray(countries) ? countries : []
    const lang = I18n.language()
    const names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([lang], { type: 'region' }) : null
    const query = String(search).trim().toLocaleLowerCase(lang)
    const rows = list.filter(c => c && /^[A-Z]{2}$/.test(String(c.cc || '').toUpperCase()))
      .map(c => { const cc = String(c.cc).toUpperCase(); return [cc, t('country.available', { name: names?.of(cc) || cc, count: Number(c.nodes) || 0 })] })
      .filter(([cc,label]) => cc === selected || !query || `${cc} ${label}`.toLocaleLowerCase(lang).includes(query))
    if (selected && /^[A-Z]{2}$/.test(selected) && !list.some(c => c && String(c.cc).toUpperCase() === selected))
      rows.push([selected, t('country.unavailableNow', { name: names?.of(selected) || selected })])
    return [
      ['', t('country.auto')], ...rows
    ]
  }
  function countryMessage(country, fallback) {
    const cc = String(country || '').toUpperCase()
    if (!/^[A-Z]{2}$/.test(cc)) return t('country.any')
    return fallback ? t('country.fallback', { country: cc }) : t('country.exitVia', { country: cc })
  }
  // Diagnostics rows for the discovered nodes: name and country, the planes the node offers, and
  // which of those the client is currently sitting out after failures. Never an address.
  function nodeRows(nodes) {
    const list = Array.isArray(nodes) ? nodes : []
    return list.map((n) => {
      const label = [String(n.key || n.node || ''), String(n.country || '')]
        .filter(Boolean)
        .join(' · ')
      const planes = Array.isArray(n.planes) ? n.planes.join(', ') : ''
      const cooling = Array.isArray(n.cooling) ? n.cooling.filter(Boolean) : []
      return {
        label,
        value: cooling.length ? t('nodes.paused', { planes, cooling: cooling.join(', ') }) : planes,
        cooling: cooling.length > 0
      }
    })
  }
  // RQT from atoms (10^8 per RQT), without trailing zeros
  function formatRqt(atoms) {
    const whole = Math.floor(atoms / 1e8)
    const part = String(atoms % 1e8).padStart(8, '0').replace(/0+$/, '')
    return part ? whole + '.' + part : String(whole)
  }
  // The payment block: tier, deposit address and the price of the discount steps.
  function paymentView(p, now = Date.now()) {
    if (!p) return null
    const full = p.tier === 'full' && p.paidUntil * 1000 > now
    const date = (s) => new Date(s * 1000).toLocaleDateString(I18n.language() === 'ru' ? 'ru-RU' : 'en-GB')
    const cost = (days) => {
      const off = Math.max(0, ...p.discounts.filter((d) => days >= d[0]).map((d) => d[1]))
      return { days, off, atoms: Math.ceil((p.priceAtomsPerDay * days * (100 - off)) / 100) }
    }
    const steps = [1, ...p.discounts.map((d) => d[0])].filter((d, i, a) => a.indexOf(d) === i).sort((a, b) => a - b)
    return {
      status: full ? t('payment.fullUntil', { date: date(p.paidUntil) }) : t('payment.free'),
      full,
      address: p.address,
      network: p.network === 'main' ? '' : t('payment.testNetwork'),
      prices: steps.map(cost).map((c) => c.off
        ? t('payment.priceOff', { days: c.days, amount: formatRqt(c.atoms), off: c.off })
        : t('payment.price', { days: c.days, amount: formatRqt(c.atoms) })),
      balance: p.balanceAtoms ? t('payment.balance', { amount: formatRqt(p.balanceAtoms) }) : '',
      note: t('payment.note', { confirmations: p.confirmations }),
      expires: t('payment.codeExpires', { date: date(p.expires) })
    }
  }
  const api = { needsDisconnect, connectionView, countryOptions, countryMessage, nodeRows, formatRqt, paymentView }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.MGView = api
})(globalThis)
