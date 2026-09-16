// Представление состояния не управляет VPN и не принимает решений за основной процесс.
;(function (root) {
  function needsDisconnect(state) {
    return !!(state.vpnOn || state.guardRecoveryRequired || state.stopRecoveryRequired)
  }
  function connectionView(config, state) {
    const recovery = !state.vpnOn && (state.guardRecoveryRequired || state.stopRecoveryRequired)
    const pending =
      state.vpnOn &&
      (state.modePending || (state.activeMode && state.activeMode !== config.vpnMode))
    const busy = !!pending || ['rendezvous', 'starting', 'switching'].includes(state.phase)
    const connected = !!(
      state.vpnOn &&
      state.vpnHealthy &&
      state.phase === 'connected' &&
      state.engineReady !== false &&
      !pending
    )
    const empty = !config.exits?.length && !needsDisconnect(state)
    let title = 'Не подключено',
      detail = 'Сейчас используется обычное подключение.'
    if (connected) {
      title = 'Подключено'
      detail =
        state.activeMode === 'split'
          ? 'Через VPN идут выбранные сайты и встроенные списки.'
          : state.trafficProtected
            ? 'Интернет работает через VPN. Прямые исключения отключены.'
            : 'Интернет работает через VPN, кроме исключений.'
    } else if (recovery) {
      title = 'Нужно завершить отключение'
      detail = 'Повторите отключение, чтобы остановить туннель и восстановить интернет.'
    } else if (pending) {
      title = 'Применяем режим…'
      detail = 'Ожидаем применения правил и проверки соединения.'
    } else if (state.phase === 'rendezvous') {
      title = 'Ищем сервер…'
      detail = 'Ожидаем параметры подключения.'
    } else if (state.phase === 'starting') {
      title = 'Проверяем соединение…'
      detail = 'Ожидаем готовности туннеля и проверки интернета.'
    } else if (empty) {
      title = 'Добавьте сервер'
      detail = 'Для начала нужен ключ вашего сервера.'
    } else if (state.otherTunnel) {
      title = 'Другой VPN включён'
      detail = 'Отключите другой VPN и повторите подключение.'
    }
    let button = 'Подключить'
    if (recovery)
      button = state.guardRecoveryRequired ? 'Восстановить интернет' : 'Повторить отключение'
    else if (needsDisconnect(state)) button = busy ? 'Отменить' : 'Отключить'
    else if (empty) button = 'Добавить сервер'
    else if (state.lastError || state.otherTunnel) button = 'Повторить'
    return { connected, busy, empty, recovery, pending, title, detail, button }
  }
  // Country selector: the list is built from what the nodes advertise — a two-letter code plus how
  // many nodes stand behind it, never an address. Kept here (and returned as plain pairs) so the DOM
  // code stays trivial and this is testable without a browser.
  function countryOptions(countries) {
    const list = Array.isArray(countries) ? countries : []
    return [
      ['', 'Любая'],
      ...list
        .filter((c) => c && /^[A-Z]{2}$/.test(String(c.cc || '').toUpperCase()))
        .map((c) => {
          const cc = String(c.cc).toUpperCase()
          const nodes = Number(c.nodes) || 0
          return [cc, `${cc} · ${nodes} ${nodes === 1 ? 'нода' : 'нод'}`]
        })
    ]
  }
  function countryMessage(country, fallback) {
    const cc = String(country || '').toUpperCase()
    if (!/^[A-Z]{2}$/.test(cc)) return 'Любая страна с живой нодой'
    return fallback ? `В ${cc} нет живых нод — используется любая` : `Выход через ${cc}`
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
        value: cooling.length ? `${planes} · пауза: ${cooling.join(', ')}` : planes,
        cooling: cooling.length > 0
      }
    })
  }
  const api = { needsDisconnect, connectionView, countryOptions, countryMessage, nodeRows }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.MGView = api
})(globalThis)
