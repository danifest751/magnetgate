// Интерфейс обращается только к явно разрешённым методам preload.
const $ = (id) => document.getElementById(id)
const all = (selector) => [...document.querySelectorAll(selector)]
let cfg = {
  exits: [],
  directDomains: [],
  tunnelDomains: [],
  vpnMode: 'full',
  killSwitch: false
}
let st = { vpnOn: false, phase: 'idle' }
let loaded = false,
  list = 'directDomains',
  saveQueue = Promise.resolve(),
  applyTimer
let applying = false,
  disconnectRequested = false,
  uiError = '',
  statusVersion = 0
let serverDraft = []
let serverRevision = 0,
  advancedRevision = 0
const names = { full: 'Весь интернет', split: 'Только выбранное' }

function showPage(page) {
  all('[data-view]').forEach((el) => (el.hidden = el.dataset.view !== page))
  all('[data-page]').forEach((el) => {
    if (el.dataset.page === page) el.setAttribute('aria-current', 'page')
    else el.removeAttribute('aria-current')
  })
}
function showError(err) {
  uiError = String(err?.message || err)
  renderStatus()
}
function text(id, value) {
  $(id).textContent = value
}
function renderStatus() {
  const view = MGView.connectionView(cfg, st)
  all(
    '[data-mode], #btnAddSite, #domain, #killSwitch, #btnAddExit, #btnSaveServers, #btnSaveAdvanced, #localPort, #singboxPort, #probePort, #bootstrap'
  ).forEach((el) => (el.disabled = !loaded))
  $('mg-app').dataset.state = view.connected ? 'connected' : 'idle'
  text('phase', view.title)
  text('statusDetail', view.detail)
  text(
    'windowStatus',
    view.connected ? 'Подключено' : view.recovery ? 'Нужно восстановление' : ''
  )
  text('btnConnect', view.button)
  $('btnConnect').disabled = !loaded && !MGView.needsDisconnect(st)
  $('progress').hidden = !view.busy
  text('activeMode', st.vpnOn && st.activeMode ? 'Сейчас: ' + names[st.activeMode] : '')
  text('modeMsg', applying || view.pending ? 'Применяем…' : '')
  const error = uiError || (!view.connected ? st.lastError : '')
  $('globalError').hidden = !error
  text(
    'errorSummary',
    view.recovery
      ? 'Отключение не завершено. Повторите его на экране подключения.'
      : 'Не удалось выполнить действие. Подробности доступны ниже.'
  )
  text('errorDetail', error || '')
  $('tunWarn').hidden = !st.otherTunnel
  text(
    'tunWarn',
    st.otherTunnel
      ? 'Включён ' + st.otherTunnel + '. Отключите его, затем нажмите «Повторить».'
      : ''
  )
  text(
    'serverName',
    cfg.exits.length === 1
      ? 'Сервер ' + cfg.exits[0].name
      : cfg.exits.length
        ? 'Серверов настроено: ' + cfg.exits.length
        : 'Сервер не настроен'
  )
  text('proxyIp', st.vpnOn ? st.proxyEgress || '—' : '—')
  const protection = st.trafficProtected
    ? 'Строгая защита проверена'
    : st.guardRecoveryRequired
      ? 'Нужно восстановить правила защиты'
      : st.vpnOn && cfg.killSwitch && cfg.vpnMode === 'full'
        ? 'Строгая защита ещё не подтверждена'
        : 'Блокировка при обрыве не активна'
  text('protection', protection)
  text(
    'diagDiscovery',
    st.clientRunning ? (st.rvReady ? 'Сервер найден' : 'Поиск сервера') : 'Остановлено'
  )
  text(
    'diagTunnel',
    st.stopRecoveryRequired
      ? 'Ожидает остановки'
      : st.engineReady
        ? 'Готов'
        : st.vpnOn
          ? 'Подготавливается'
          : 'Не запущен'
  )
  text(
    'diagHealth',
    view.connected ? 'Проверен' : st.vpnOn ? 'Ещё не подтверждён' : 'Не проверяется'
  )
  text('diagMode', st.vpnOn ? names[st.activeMode] || 'Ещё не применён' : '—')
  text('diagSystem', st.vpnOn ? st.egress || '—' : '—')
  text('diagProxy', st.vpnOn ? st.proxyEgress || '—' : '—')
  text('diagGuard', protection)
  $('traffic').hidden = !view.connected
  const stats = st.stats || {}
  text(
    'traffic',
    `Получение ${bytes(stats.downBps)}/с · Отправка ${bytes(stats.upBps)}/с · Соединений: ${stats.conns || 0}`
  )
}
function bytes(value = 0) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return value.toFixed(index ? 1 : 0) + ' ' + units[index]
}
function renderRules() {
  all('[data-mode]').forEach((el) =>
    el.setAttribute('aria-pressed', el.dataset.mode === cfg.vpnMode)
  )
  all('[data-list]').forEach((el) => el.setAttribute('aria-pressed', el.dataset.list === list))
  text(
    'fullDescription',
    cfg.killSwitch ? 'Все сайты, без прямых исключений' : 'Кроме сайтов в исключениях'
  )
  const preview = cfg.vpnMode === 'full' ? 'directDomains' : 'tunnelDomains'
  text('previewTitle', cfg.vpnMode === 'full' ? 'Исключения из VPN' : 'Сайты через VPN')
  const domains = cfg[preview] || []
  text(
    'previewSites',
    cfg.vpnMode === 'full' && cfg.killSwitch
      ? 'Не действуют при строгой защите'
      : domains.length
        ? domains.slice(0, 3).join(', ') +
          (domains.length > 3 ? ' и ещё ' + (domains.length - 3) : '')
        : 'Пользовательский список пока пуст'
  )
  text(
    'listHint',
    list === 'directDomains'
      ? 'Исключения для режима «Весь интернет».'
      : 'Сайты для режима «Только выбранное».'
  )
  $('listWarning').hidden = list !== 'directDomains' || !cfg.killSwitch
  text(
    'builtInNote',
    list === 'directDomains'
      ? 'В режиме «Весь интернет» сайты для прямого доступа добавляете вы. Изменения сохраняются автоматически.'
      : 'Встроенные списки дополняют выбранные сайты в режиме «Только выбранное». Изменения сохраняются автоматически.'
  )
  $('killSwitch').checked = cfg.killSwitch
  $('guardNote').hidden = !cfg.killSwitch
  const box = $('siteList')
  box.replaceChildren()
  if (!cfg[list]?.length) {
    const empty = document.createElement('p')
    empty.className = 'mg-empty'
    empty.textContent = 'В этом списке пока нет сайтов. Добавьте первый выше.'
    box.append(empty)
  }
  for (const domain of cfg[list] || []) {
    const row = document.createElement('div')
    row.className = 'mg-list-row'
    const label = document.createElement('span')
    label.className = 'mg-domain'
    label.textContent = domain
    const remove = document.createElement('button')
    remove.className = 'mg-remove'
    remove.textContent = 'Убрать'
    remove.setAttribute('aria-label', 'Убрать ' + domain)
    const key = list
    remove.onclick = () =>
      saveChange(
        (current) => ({ ...current, [key]: current[key].filter((d) => d !== domain) }),
        'siteMessage'
      ).catch(() => {})
    row.append(label, remove)
    box.append(row)
  }
}
function scheduleApply() {
  clearTimeout(applyTimer)
  if (!st.vpnOn || disconnectRequested) return
  applying = true
  renderStatus()
  applyTimer = setTimeout(async () => {
    try {
      if (st.vpnOn && !disconnectRequested) await window.mg.vpnOn()
    } catch (err) {
      showError(err)
    } finally {
      applying = false
      renderStatus()
    }
  }, 350)
}
function saveChange(update, messageId) {
  if (!loaded) return Promise.reject(new Error('Сначала дождитесь загрузки настроек.'))
  const result = saveQueue.then(async () => {
    try {
      const candidate = update(structuredClone(cfg))
      cfg = await window.mg.saveConfig(candidate)
      uiError = ''
      renderRules()
      renderStatus()
      if (messageId)
        text(messageId, 'Сохранено' + (st.vpnOn ? ' · применяем к подключению' : '') + '.')
      scheduleApply()
      return cfg
    } catch (err) {
      if (messageId) text(messageId, 'Не сохранено. Проверьте введённые значения.')
      showError(err)
      renderRules()
      throw err
    }
  })
  saveQueue = result.catch(() => {})
  return result
}
function renderServers() {
  const box = $('exits')
  box.replaceChildren()
  if (!serverDraft.length) {
    const p = document.createElement('p')
    p.className = 'mg-empty'
    p.textContent = 'Добавьте сервер и вставьте его ключ доступа.'
    box.append(p)
  }
  serverDraft.forEach((server, index) => {
    const row = document.createElement('div')
    row.className = 'mg-exit'
    function field(labelText, value, type, key) {
      const label = document.createElement('label')
      label.textContent = labelText
      const input = document.createElement('input')
      input.type = type
      input.value = value
      input.autocomplete = 'off'
      input.spellcheck = false
      input.setAttribute('aria-label', labelText + ' · сервер ' + (index + 1))
      input.oninput = () => {
        serverDraft[index][key] = input.value
        serverRevision++
        text('serversMessage', 'Есть несохранённые изменения.')
      }
      label.append(input)
      return label
    }
    const buttons = document.createElement('div')
    buttons.className = 'mg-actions'
    const generate = document.createElement('button')
    generate.className = 'mg-secondary'
    generate.textContent = 'Создать ключ'
    generate.onclick = async () => {
      try {
        const key = await window.mg.genPsk()
        if (!serverDraft.includes(server)) return
        server.psk = key
        serverRevision++
        renderServers()
        text(
          'serversMessage',
          'Новый ключ нужно также настроить на сервере. Сохраните изменения.'
        )
      } catch (err) {
        showError(err)
      }
    }
    const remove = document.createElement('button')
    remove.className = 'mg-remove'
    remove.textContent = 'Удалить сервер'
    remove.onclick = () => {
      serverDraft.splice(index, 1)
      serverRevision++
      renderServers()
      text('serversMessage', 'Удаление применится после сохранения.')
    }
    buttons.append(generate, remove)
    row.append(
      field('Название', server.name || '', 'text', 'name'),
      field('Ключ доступа', server.psk || '', 'password', 'psk'),
      buttons
    )
    box.append(row)
  })
}
function fillAdvanced() {
  for (const name of ['localPort', 'singboxPort', 'probePort']) $(name).value = cfg[name]
  $('bootstrap').value = cfg.bootstrap.join('\n')
}
function appendLog(line) {
  const el = $('log'),
    atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
  el.textContent = (el.textContent + '\n' + line).split('\n').slice(-500).join('\n')
  if (atBottom) el.scrollTop = el.scrollHeight
}
async function addSite() {
  const raw = $('domain').value.trim()
  try {
    if (!raw) throw new Error('Введите адрес сайта.')
    const url = new URL(raw.includes('://') ? raw : 'https://' + raw.replace(/^\*\./, ''))
    const domain = url.hostname.toLowerCase().replace(/\.$/, '')
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !domain.includes('.') ||
      !/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(domain)
    )
      throw new Error('Введите домен, например example.com.')
    const key = list
    await saveChange((current) => {
      if (current[key].includes(domain)) throw new Error('Этот сайт уже есть в списке.')
      return { ...current, [key]: [...current[key], domain] }
    }, 'siteMessage')
    $('domain').value = ''
  } catch (err) {
    text('siteMessage', err.message)
  }
}
window.addEventListener('DOMContentLoaded', async () => {
  all('[data-page]').forEach((el) => (el.onclick = () => showPage(el.dataset.page)))
  all('[data-go]').forEach((el) => (el.onclick = () => showPage(el.dataset.go)))
  all('[data-list]').forEach(
    (el) =>
      (el.onclick = () => {
        list = el.dataset.list
        text('siteMessage', '')
        renderRules()
      })
  )
  all('[data-mode]').forEach(
    (el) =>
      (el.onclick = () => {
        if (loaded)
          saveChange((current) => ({ ...current, vpnMode: el.dataset.mode })).catch(() => {})
      })
  )
  $('btnEditSites').onclick = () => {
    list = cfg.vpnMode === 'full' ? 'directDomains' : 'tunnelDomains'
    renderRules()
    showPage('sites')
  }
  $('btnConnect').onclick = async () => {
    if (!loaded && !MGView.needsDisconnect(st)) return
    uiError = ''
    if (MGView.needsDisconnect(st)) {
      disconnectRequested = true
      clearTimeout(applyTimer)
      applying = false
      try {
        await window.mg.disconnect()
      } catch (err) {
        showError(err)
      } finally {
        renderStatus()
      }
    } else if (!cfg.exits.length) {
      showPage('settings')
      $('serverSettings').open = true
      if (!serverDraft.length) {
        serverDraft.push({ name: '', psk: '' })
        renderServers()
      }
      $('exits').querySelector('input')?.focus()
    } else {
      disconnectRequested = false
      try {
        await saveQueue
        await window.mg.connect()
      } catch (err) {
        showError(err)
      }
    }
  }
  $('btnAddSite').onclick = addSite
  $('domain').onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void addSite()
    }
  }
  $('killSwitch').onchange = () => {
    const value = $('killSwitch').checked
    saveChange((current) => ({ ...current, killSwitch: value })).catch(() => {})
  }
  $('btnAddExit').onclick = () => {
    serverDraft.push({ name: '', psk: '' })
    serverRevision++
    renderServers()
    text('serversMessage', 'Есть несохранённые изменения.')
  }
  $('btnSaveServers').onclick = async () => {
    const exits = structuredClone(serverDraft)
    const revision = serverRevision
    if (exits.some((e) => !e.psk.trim())) {
      text('serversMessage', 'Укажите ключ для каждого сервера.')
      return
    }
    try {
      text('serversMessage', 'Сохраняем…')
      await saveChange((current) => ({ ...current, exits }))
      if (revision === serverRevision) {
        serverDraft = structuredClone(cfg.exits)
        renderServers()
      }
      text(
        'serversMessage',
        revision === serverRevision
          ? 'Серверы сохранены.'
          : 'Предыдущие изменения сохранены. Есть новые несохранённые изменения.'
      )
    } catch {
      text('serversMessage', 'Серверы не сохранены. Проверьте значения и повторите.')
    }
  }
  for (const id of ['localPort', 'singboxPort', 'probePort', 'bootstrap'])
    $(id).oninput = () => {
      advancedRevision++
      text('advancedMessage', 'Есть несохранённые изменения.')
    }
  $('btnSaveAdvanced').onclick = async () => {
    const fields = {}
    const revision = advancedRevision
    for (const name of ['localPort', 'singboxPort', 'probePort']) {
      fields[name] = Number($(name).value)
      if (!Number.isInteger(fields[name]) || fields[name] < 1024 || fields[name] > 65535) {
        text('advancedMessage', 'Порты должны быть целыми числами от 1024 до 65535.')
        return
      }
    }
    fields.bootstrap = $('bootstrap')
      .value.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    try {
      text('advancedMessage', 'Сохраняем…')
      await saveChange((current) => ({ ...current, ...fields }))
      if (revision === advancedRevision) fillAdvanced()
      text(
        'advancedMessage',
        revision === advancedRevision
          ? 'Параметры сохранены.'
          : 'Предыдущие изменения сохранены. Есть новые несохранённые изменения.'
      )
    } catch {
      text('advancedMessage', 'Параметры не сохранены. Проверьте значения и повторите.')
    }
  }
  $('btnOpenDir').onclick = () => window.mg.openConfigDir().catch(showError)
  $('btnLogs').onclick = () => window.mg.openLogs().catch(showError)
  // two-step confirm instead of a modal: the first click only arms the button
  let clearArmed = false
  const clearBtn = $('btnClearLog')
  clearBtn.onclick = async () => {
    if (!clearArmed) {
      clearArmed = true
      clearBtn.textContent = 'Точно очистить? Нажмите ещё раз'
      setTimeout(() => {
        clearArmed = false
        clearBtn.textContent = 'Очистить журнал'
      }, 5000)
      return
    }
    clearArmed = false
    clearBtn.textContent = 'Очистить журнал'
    try {
      await window.mg.clearLog()
      const box = $('log')
      if (box) box.textContent = ''
      text('diagMessage', 'Журнал очищен.')
    } catch (err) {
      showError(err)
    }
  }
  $('btnRefresh').onclick = async () => {
    try {
      const version = statusVersion
      const snapshot = await window.mg.getState()
      if (version === statusVersion) st = snapshot
      renderStatus()
      text('diagMessage', 'Состояние обновлено.')
    } catch (err) {
      showError(err)
    }
  }
  window.mg.onStatus((value) => {
    statusVersion++
    st = value
    renderStatus()
  })
  window.mg.onLog(appendLog)
  try {
    const version = statusVersion
    const [config, snapshot] = await Promise.all([
      window.mg.getConfig(),
      window.mg.getState().then((snapshot) => {
        if (version === statusVersion) {
          st = snapshot
          renderStatus()
        }
        return snapshot
      })
    ])
    cfg = config
    if (version === statusVersion) st = snapshot
    serverDraft = structuredClone(cfg.exits)
    fillAdvanced()
    renderServers()
    renderRules()
    loaded = true
    renderStatus()
  } catch (err) {
    showError(err)
    if (!MGView.needsDisconnect(st)) text('phase', 'Не удалось загрузить настройки')
    text('windowStatus', 'Ошибка настроек')
  }
  try {
    for (const line of await window.mg.getLog()) appendLog(line)
  } catch (err) {
    text('diagMessage', 'Не удалось прочитать журнал: ' + err.message)
  }
  try {
    text('logPath', await window.mg.getLogPath())
  } catch {}
})
