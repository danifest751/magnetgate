// Настройки раздачи сохраняет отдельное Go-ядро.
;(function (root) {
  const $ = id => document.getElementById(id)
  let current, busy = false
  const labels = { READY: 'Ваше соединение доступно другим пользователям', BUSY: 'Все места заняты',
    PAUSED: 'Раздача приостановлена', PREPARING: 'Подготавливаем соединение', OFFLINE: 'Раздача выключена' }
  function render(state) {
    current = state.peer || {}
    const policy = current.policy || {}
    $('peerShare').checked = !!policy.enabled
    $('peerShare').disabled = busy || !current.configured || current.canShare === false
    $('peerState').textContent = current.error || (!current.configured
      ? 'Сервис соединений пользователей пока не настроен.' : current.canShare === false
      ? 'Раздача на этом устройстве пока недоступна.' : !current.connected
      ? 'Нет связи с каталогом. Раздача приостановлена.' : policy.enabled && state.vpnOn
      ? 'Раздача приостановлена, пока включён ваш VPN.' : labels[current.state] || 'Ожидаем готовности соединения')
    $('peerTcpNote').hidden = state.connectionSource !== 'peers'
    $('peerAutomatic').disabled = busy || !current.configured
    $('peerSaveLimits').disabled = busy || !current.configured
    if (!$('peerLimits').dataset.dirty) {
      $('peerAutomatic').checked = policy.automatic !== false
      $('peerMaxMbps').value = policy.maxMbps || 5
      $('peerMaxGuests').value = policy.maxGuests || 2
      $('peerDaily').value = (policy.dailyBytes || 1073741824) / 1073741824
      $('peerMonthly').value = (policy.monthlyBytes || 21474836480) / 1073741824
    }
  }
  function bind(onError) {
    async function save(policy) {
      busy = true; $('peerShare').disabled = true; $('peerSaveLimits').disabled = true
      try {
        current = await window.mg.setPeerPolicy(policy)
        $('peerLimits').dataset.dirty = ''
        $('peerMessage').textContent = 'Сохранено.'
      } catch (error) {
        $('peerMessage').textContent = error.message
        $('peerShare').checked = !!current?.policy?.enabled
        onError(error)
      } finally { busy = false; $('peerShare').disabled = !current?.configured || current?.canShare === false; $('peerSaveLimits').disabled = !current?.configured }
    }
    $('peerShare').onchange = () => save({ ...current.policy, enabled: $('peerShare').checked })
    for (const id of ['peerAutomatic','peerMaxMbps','peerMaxGuests','peerDaily','peerMonthly'])
      $(id).oninput = () => { $('peerLimits').dataset.dirty = 'true'; $('peerMessage').textContent = 'Есть несохранённые изменения.' }
    $('peerSaveLimits').onclick = () => save({ ...current.policy, automatic: $('peerAutomatic').checked,
      maxMbps: Number($('peerMaxMbps').value), maxGuests: Number($('peerMaxGuests').value),
      dailyBytes: Math.floor(Number($('peerDaily').value)*1073741824),
      monthlyBytes: Math.floor(Number($('peerMonthly').value)*1073741824) })
  }
  root.MGPeer = { render, bind }
})(globalThis)
