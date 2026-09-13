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
  const api = { needsDisconnect, connectionView }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.MGView = api
})(globalThis)
