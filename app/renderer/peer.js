// Настройки раздачи сохраняет отдельное Go-ядро.
;(function (root) {
  const $ = id => document.getElementById(id)
  let current, busy = false
  const t = (key) => root.MGI18n.t(key)
  const labels = { READY: 'peer.ready', BUSY: 'peer.busy', PAUSED: 'peer.paused', PREPARING: 'peer.preparing',
    OFFLINE: 'peer.offline' }
  function render(state) {
    current = state.peer || {}
    const policy = current.policy || {}
    $('peerShare').checked = !!policy.enabled
    $('peerShare').disabled = busy || !current.configured || current.canShare === false
    $('peerState').textContent = current.error || (!current.configured
      ? t('peer.notSetUp') : current.canShare === false
      ? t('peer.cannotShare') : !current.connected
      ? t('peer.noCatalogue') : policy.enabled && state.vpnOn
      ? t('peer.pausedVpn') : labels[current.state] ? t(labels[current.state]) : t('peer.waiting'))
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
        $('peerMessage').textContent = t('save.saved')
      } catch (error) {
        $('peerMessage').textContent = error.message
        $('peerShare').checked = !!current?.policy?.enabled
        onError(error)
      } finally { busy = false; $('peerShare').disabled = !current?.configured || current?.canShare === false; $('peerSaveLimits').disabled = !current?.configured }
    }
    $('peerShare').onchange = () => save({ ...current.policy, enabled: $('peerShare').checked })
    for (const id of ['peerAutomatic','peerMaxMbps','peerMaxGuests','peerDaily','peerMonthly'])
      $(id).oninput = () => { $('peerLimits').dataset.dirty = 'true'; $('peerMessage').textContent = t('save.unsaved') }
    $('peerSaveLimits').onclick = () => save({ ...current.policy, automatic: $('peerAutomatic').checked,
      maxMbps: Number($('peerMaxMbps').value), maxGuests: Number($('peerMaxGuests').value),
      dailyBytes: Math.floor(Number($('peerDaily').value)*1073741824),
      monthlyBytes: Math.floor(Number($('peerMonthly').value)*1073741824) })
  }
  root.MGPeer = { render, bind }
})(globalThis)
