import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChartBar, Key, HardDrives, ArrowsLeftRight, Pulse, ClockCounterClockwise, ArrowUpRight, ArrowLeft, ArrowClockwise, DownloadSimple, X, LockSimple, Sun, Moon } from '@phosphor-icons/react'
import './styles.css'

const views = [ ['overview', 'Обзор', ChartBar], ['access', 'Доступы', Key], ['nodes', 'Ноды', HardDrives], ['traffic', 'Трафик', ArrowsLeftRight], ['requests', 'Запросы API', Pulse], ['events', 'События', ClockCounterClockwise] ]
const statuses = { active: 'Активирован', unused: 'Не активирован', expired: 'Истёк', revoked: 'Отозван', quota: 'Дневная квота', valid: 'Действующий' }
const reasons = { ok: 'Успешно', denied: 'Доступ отклонён', no_capacity: 'Нет свободных нод', daily_limit: 'Лимит выдачи', network_limit: 'Лимит сети', device_limit: 'Лимит устройств', rate_limit: 'Частые запросы', challenge: 'Проверка человека', invalid: 'Некорректный запрос', internal: 'Ошибка сервиса', http_error: 'Ошибка HTTP' }
const events = { heartbeat_stale: 'Отчёт ноды просрочен', heartbeat_recovered: 'Отчёты ноды восстановлены', source_unavailable: 'Источник данных недоступен', source_recovered: 'Источник данных восстановлен' }
const today = () => new Date().toISOString().slice(0, 10)
const weekAgo = () => new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)
const number = n => new Intl.NumberFormat('ru-RU').format(n ?? 0)
const bytes = n => n == null ? '—' : n < 1024 ? `${number(n)} Б` : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n / 1024 ** Math.min(3, Math.floor(Math.log(n) / Math.log(1024))))} ${['Б', 'КиБ', 'МиБ', 'ГиБ'][Math.min(3, Math.floor(Math.log(n) / Math.log(1024)))]}`
const datetime = n => n == null ? 'Нет отчёта' : new Date(n * 1000).toLocaleString('ru-RU', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

function getFilters() {
  const p = new URLSearchParams(location.search)
  return { view: views.some(v => v[0] === p.get('view')) ? p.get('view') : 'overview', from: p.get('from') || weekAgo(), to: p.get('to') || today(), node: p.get('node') || '', status: p.get('status') || '', search: p.get('search') || '', route: p.get('route') || '', reason: p.get('reason') || '', page: p.get('page') || '1' }
}

function Empty({ children = 'За этот период данных пока нет.' }) { return <div className="empty"><ChartBar size={28} /><p>{children}</p></div> }
function Badge({ children, warning }) { return <span className={`badge ${warning ? 'warning' : ''}`}>{children}</span> }
function Metric({ title, value, detail, onClick }) { return <button className="metric" onClick={onClick}><span>{title}<ArrowUpRight size={17} /></span><strong>{value}</strong><small>{detail}</small></button> }
function Panel({ title, hint, children, action }) { return <section className="panel"><div className="panel-head"><div><h2>{title}</h2>{hint && <p>{hint}</p>}</div>{action}</div>{children}</section> }

function Bars({ rows, field, label, format, onClick }) {
  const max = Math.max(1, ...rows.map(r => r[field]))
  return rows.length ? <div className="chart" aria-label={label}>{rows.map(r => <button className="bar-column" key={r.day} onClick={() => onClick(r)} aria-label={`${r.day}: ${format(r[field])}. Открыть подробности`}><span className="bar-value">{format(r[field])}</span><span className="bar-track"><span className={`bar-fill height-${Math.max(0, Math.min(20, Math.ceil(r[field] / max * 20)))}`} /></span><span className="bar-label">{r.day.slice(5)}</span></button>)}</div> : <Empty />
}

function Table({ columns, rows }) {
  return rows.length ? <div className="table-wrap"><table><thead><tr>{columns.map(c => <th key={c[0]}>{c[0]}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={row.id || i}>{columns.map(c => <td key={c[0]}>{c[1](row)}</td>)}</tr>)}</tbody></table></div> : <Empty />
}
function Pages({ data, go }) { return <div className="pagination"><span>Всего строк: {number(data.total)} · страница {data.page} из {Math.max(1, Math.ceil(data.total / data.limit))}</span><div><button disabled={data.page <= 1} onClick={() => go({ page: String(data.page - 1) })}>Назад</button><button disabled={data.page * data.limit >= data.total} onClick={() => go({ page: String(data.page + 1) })}>Далее</button></div></div> }
function exportRows(rows) {
  if (!rows?.length) return
  const fields = Object.keys(rows[0]).filter(k => !['resources', 'probes'].includes(k))
  const cell = value => `"${String(value ?? '').replace(/^\s*[=+\-@\t\r]/, "'$&").replaceAll('"', '""')}"`
  const csv = '\uFEFF' + [fields, ...rows.map(row => fields.map(k => row[k]))].map(row => row.map(cell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = `magnetgate-${today()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function dialogKeys(event, close) {
  if (event.key === 'Escape') { close(); return }
  if (event.key !== 'Tab') return
  const controls = event.currentTarget.querySelectorAll('button:not(:disabled), a[href], input, select, [tabindex="0"]')
  const first = controls[0], last = controls[controls.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}

function App() {
  const [filters, setFilters] = useState(getFilters)
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0)
  const [knownNodes, setKnownNodes] = useState([]), [selected, setSelected] = useState(null)
  const [dark, setDark] = useState(() => localStorage.getItem('magnetgate-admin-theme') === 'dark')
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('magnetgate-admin-theme', dark ? 'dark' : 'light') }, [dark])
  useEffect(() => { const pop = () => { setData(null); setError(''); setFilters(getFilters()); setSelected(null) }; addEventListener('popstate', pop); return () => removeEventListener('popstate', pop) }, [])
  useEffect(() => { const id = setInterval(() => setRevision(n => n + 1), 15000); return () => clearInterval(id) }, [])
  function go(change, newView = filters.view) {
    const next = { ...filters, page: '1', ...change, view: newView }
    if (newView !== filters.view) Object.assign(next, { status: '', search: '', route: '', reason: '', ...change })
    if (!['nodes', 'traffic', 'events'].includes(newView)) next.node = ''
    history.pushState(null, '', `?${new URLSearchParams(Object.entries(next).filter(([, v]) => v !== ''))}`)
    setSelected(null); setData(null); setError(''); setFilters(next)
  }
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    const query = new URLSearchParams(Object.entries(filters).filter(([k, v]) => k !== 'view' && v !== ''))
    fetch(`/admin/api/${filters.view}?${query}`, { signal: controller.signal, cache: 'no-store' })
      .then(async r => { if (!r.ok) throw new Error(r.status === 400 ? 'Некорректный фильтр. Выберите не более 31 дня.' : 'Источник недоступен. Проверьте сервис и подключение через SSH.'); return r.json() })
      .then(result => { if (controller.signal.aborted) return; setData(result); setError(''); if (result.nodes) setKnownNodes(result.nodes); else if (filters.view === 'nodes' && !filters.node) setKnownNodes(result.rows) })
      .catch(e => { if (e.name !== 'AbortError') { setError(e.message); setData(null) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [filters, revision])
  useEffect(() => {
    if (filters.view === 'overview') return
    const controller = new AbortController()
    fetch('/admin/api/nodes', { signal: controller.signal, cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(r => { if (r) setKnownNodes(r.rows) }).catch(() => {})
    return () => controller.abort()
  }, [filters.view])
  const title = views.find(v => v[0] === filters.view)[1]
  const nodeLink = id => <button className="text-link" onClick={() => go({ node: id }, 'nodes')}>{id}<ArrowUpRight size={14} /></button>
  const rowExport = data?.rows
  return <div className="layout">
    <aside inert={Boolean(selected)}><a className="brand" href="/admin/"><span>m/</span> magnetgate</a><div className="workspace-label">Центр управления</div><nav>{views.map(([id, label, Icon]) => <button key={id} className={filters.view === id ? 'active' : ''} onClick={() => go({ node: '' }, id)}><Icon size={20} />{label}</button>)}</nav><div className="aside-bottom"><div><LockSimple size={17} />Приватный доступ</div><p>Только чтение<br />Без ключей и паролей</p><button onClick={() => setDark(!dark)}>{dark ? <Sun size={18} /> : <Moon size={18} />}{dark ? 'Светлая тема' : 'Тёмная тема'}</button></div></aside>
    <main inert={Boolean(selected)}><header><div><div className="eyebrow">MAGNETGATE / АНАЛИТИКА</div><h1>{title}</h1><p>Личный доступ · Hysteria 2</p></div><div className="header-actions"><Badge warning={!data?.source.healthy}>{data ? data.source.healthy ? 'Данные обновляются' : 'Источник недоступен' : 'Нет свежих данных'}</Badge><button className="icon-button" aria-label="Обновить данные" onClick={() => setRevision(n => n + 1)} disabled={loading}><ArrowClockwise size={20} className={loading ? 'spinning' : ''} /></button></div></header>
      <div className="filters"><label>С <input type="date" value={filters.from} max={filters.to} onChange={e => go({ from: e.target.value })} /></label><label>По <input type="date" value={filters.to} min={filters.from} max={today()} onChange={e => go({ to: e.target.value })} /></label><button onClick={() => go({ from: weekAgo(), to: today() })}>7 дней</button><button onClick={() => go({ from: today(), to: today() })}>Сегодня</button>{['nodes', 'traffic', 'events'].includes(filters.view) && <select aria-label="Фильтр ноды" value={filters.node} onChange={e => go({ node: e.target.value })}><option value="">Все ноды</option>{knownNodes.map(n => <option key={n.id} value={n.id}>{n.id}</option>)}</select>}<span className="filter-note">UTC · до 31 дня</span></div>
      {filters.view !== 'overview' && <button className="back-link" onClick={() => go({ node: '' }, 'overview')}><ArrowLeft size={15} />К обзору</button>}
      {error ? <div className="notice error" role="alert">{error} <button onClick={() => go({ from: weekAgo(), to: today(), node: '', status: '', search: '', route: '', reason: '' })}>Сбросить фильтры</button></div> : null}
      {data && !data.source.healthy && <div className="notice error">Источник временно недоступен. Ниже — последний снимок от {datetime(data.source.collectedAt)} UTC, не текущее состояние.</div>}
      {loading && !data && !error && <Empty>Загружаем данные…</Empty>}
      {data && <>
      {filters.view === 'overview' && <>
        <div className="metrics"><Metric title="Действующие доступы" value={number(data.validAccounts)} detail={`Из ${number(data.limits.accounts)} · открыть реестр`} onClick={() => go({ status: 'valid' }, 'access')} /><Metric title="Выдано сегодня" value={number(data.issuedToday)} detail={`Дневной лимит: ${number(data.limits.issued)} · UTC`} onClick={() => go({ from: today(), to: today(), route: '/api/access' }, 'requests')} /><Metric title="Трафик сегодня" value={bytes(data.bytesToday)} detail={`Общая квота: ${bytes(data.limits.traffic)}`} onClick={() => go({ from: today(), to: today() }, 'traffic')} /><Metric title="Соединения сейчас" value={number(data.connections)} detail="По свежим отчётам · не уникальные люди" onClick={() => go({}, 'nodes')} /><Metric title="Свежие отчёты нод" value={`${data.freshNodes} / ${data.totalNodes}`} detail="Последний отчёт младше 20 секунд" onClick={() => go({}, 'nodes')} /><Metric title="Устройства" value={number(data.registeredDevices)} detail="Зарегистрированные · не онлайн сейчас" onClick={() => go({}, 'access')} /></div>
        <div className="overview-grid"><Panel title="Выдача доступов" hint="Нажмите на день → запросы выдачи за этот день"><Bars rows={data.days} field="issued" label="Выдача доступов по дням" format={number} onClick={r => go({ from: r.day, to: r.day, route: '/api/access' }, 'requests')} /></Panel><Panel title="Трафик по дням" hint="Общий расход квоты · нажмите на день для разбивки"><Bars rows={data.days} field="bytes" label="Трафик по дням" format={bytes} onClick={r => go({ from: r.day, to: r.day }, 'traffic')} /></Panel></div>
        <Panel title="Ноды и свободные соединения" hint={data.issuanceAvailable ? 'Условия выдачи новых доступов выполнены.' : 'Выдача закрыта: нет ёмкости или достигнут лимит доступов.'}><Table rows={data.nodes} columns={[[ 'Нода', r => nodeLink(r.id) ], [ 'Отчёт', r => <Badge warning={!r.fresh}>{r.fresh ? 'Свежий' : 'Нет свежего'}</Badge> ], [ 'Соединения', r => `${r.connections ?? '—'} / ${r.capacity}` ], [ 'Свободно', r => r.free ?? '—' ], [ 'Возраст отчёта', r => r.age == null ? '—' : `${number(r.age)} с` ]]} /></Panel>
      </>}
      {filters.view === 'access' && <Panel title="Реестр личных доступов" hint="Текущее состояние, независимо от выбранного периода. ID не является кодом входа." action={<button disabled={!rowExport?.length} onClick={() => exportRows(rowExport)}><DownloadSimple size={16} />CSV страницы</button>}><div className="table-filters"><form onSubmit={e => { e.preventDefault(); go({ search: new FormData(e.currentTarget).get('search') }) }}><input key={filters.search} name="search" aria-label="Поиск по ID доступа" placeholder="Поиск по ID доступа" defaultValue={filters.search} maxLength={64} /><button>Найти</button></form><select aria-label="Статус доступа" value={filters.status} onChange={e => go({ status: e.target.value })}><option value="">Все статусы</option>{Object.entries(statuses).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div><Table rows={data.rows} columns={[[ 'ID доступа', r => <button className="text-link mono" onClick={() => setSelected(r)}>{r.id.slice(0, 12)}…<ArrowUpRight size={14} /></button> ], [ 'Статус', r => <Badge warning={['revoked', 'expired', 'quota'].includes(r.status)}>{statuses[r.status]}</Badge> ], [ 'Устройства', r => `${r.devices} / ${r.deviceLimit}` ], [ 'Расход сегодня', r => bytes(r.bytesToday) ], [ 'Истекает, UTC', r => datetime(r.expires) ]]} /><Pages data={data} go={go} /></Panel>}
      {filters.view === 'nodes' && <>
        <Panel title="Состояние нод" hint="Свежий отчёт означает связь с агентом, но не подтверждает доступность Google или всего интернета."><Table rows={data.rows} columns={[[ 'Нода', r => nodeLink(r.id) ], [ 'Страна', r => r.country || '—' ], [ 'Отчёт', r => <Badge warning={!r.fresh}>{r.fresh ? 'Свежий' : 'Просрочен / отсутствует'}</Badge> ], [ 'Соединения', r => `${r.connections ?? '—'} / ${r.capacity}` ], [ 'Последний отчёт, UTC', r => datetime(r.seen) ]]} /></Panel>
        <div className="notice">CPU, RAM и проверки сайтов пока не подключены. Панель не подменяет их состоянием «всё работает».</div>
        <Panel title={filters.node ? `История отчётов · ${filters.node}` : 'История отчётов всех нод'} hint="Минутные снимки выбранного периода. Для деталей выберите конкретную ноду."><Table rows={data.presence} columns={[[ 'Время, UTC', r => datetime(r.minute) ], [ 'Нода', r => nodeLink(r.node) ], [ 'Отчёт', r => r.fresh ? 'Свежий' : 'Просрочен' ], [ 'Соединения', r => r.fresh ? number(r.online) : 'Неизвестно' ]]} /><Pages data={data} go={go} /></Panel>
      </>}
      {filters.view === 'traffic' && <>
        <div className="notice">Почасовая разбивка собирается с {datetime(data.source.historyStarted)} UTC. Общий расход квоты за день может быть больше этой разбивки. Трафик = входящий + исходящий, не скорость канала.</div>
        <Panel title={`Расход по нодам · ${bytes(data.total)}`} hint={`${filters.from} → ${filters.to}${filters.node ? ' · ' + filters.node : ' · все ноды'}`} action={<button disabled={!rowExport?.length} onClick={() => exportRows(rowExport)}><DownloadSimple size={16} />CSV страницы</button>}><Table rows={data.rows} columns={[[ 'Час, UTC', r => datetime(r.hour) ], [ 'Нода', r => nodeLink(r.node) ], [ 'Трафик', r => bytes(r.bytes) ]]} /><Pages data={{ ...data, total: data.rowCount }} go={go} /></Panel>
        <Panel title="Дневная квота · все ноды" hint="Глобальные итоги из сервиса выдачи. Фильтр ноды к этим итогам не применяется."><Bars rows={data.days} field="bytes" label="Дневной трафик" format={bytes} onClick={r => go({ from: r.day, to: r.day })} /></Panel>
      </>}
      {filters.view === 'requests' && <>
        {!data.source.requestTelemetry && <div className="notice">Сбор запросов не подключён. После включения analyticsDatabase в приватных настройках сервиса выдачи здесь появится история. Старые запросы восстановить нельзя.</div>}
        <div className="metrics compact"><div className="metric static"><span>Запросов в периоде</span><strong>{number(data.count)}</strong><small>Агрегаты · сбор без IP и содержимого</small></div><div className="metric static"><span>Отказы и ошибки</span><strong>{number(data.errors)}</strong><small>Неуспешные результаты, включая лимиты</small></div><div className="metric static"><span>p95 · верхняя граница</span><strong>{data.p95UpperMs == null ? '—' : `≤ ${number(data.p95UpperMs)} мс`}</strong><small>Оценка по интервалам, не точный процентиль</small></div></div>
        <Panel title="Запросы сервиса выдачи" hint="Нажмите на маршрут или причину, чтобы отфильтровать все агрегаты. Сбор best effort; это не аудит всех HTTP-запросов." action={<button disabled={!rowExport?.length} onClick={() => exportRows(rowExport)}><DownloadSimple size={16} />CSV страницы</button>}><div className="table-filters"><select aria-label="Маршрут API" value={filters.route} onChange={e => go({ route: e.target.value })}><option value="">Все маршруты</option>{['info', 'access', 'profile', 'revoke', 'node-auth', 'node-report'].map(r => <option key={r} value={`/api/${r}`}>/api/{r}</option>)}<option value="other">Другие</option></select><select aria-label="Результат запроса" value={filters.reason} onChange={e => go({ reason: e.target.value })}><option value="">Все результаты</option>{Object.entries(reasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div><Table rows={data.rows} columns={[[ 'Минута, UTC', r => datetime(r.minute) ], [ 'Маршрут', r => <button className="text-link mono" onClick={() => go({ route: r.route })}>{r.route}</button> ], [ 'HTTP', r => r.status ], [ 'Результат', r => <button className="text-link" onClick={() => go({ reason: r.reason })}>{reasons[r.reason]}</button> ], [ 'Количество', r => number(r.count) ], [ 'Среднее, мс', r => Math.round(r.total_ms / r.count) ]]} /><Pages data={data} go={go} /></Panel>
      </>}
      {filters.view === 'events' && <Panel title="События наблюдения" hint="Смена состояния отчётов и источника, не журнал действий пользователей." action={<button disabled={!rowExport?.length} onClick={() => exportRows(rowExport)}><DownloadSimple size={16} />CSV страницы</button>}><Table rows={data.rows} columns={[[ 'Время, UTC', r => datetime(r.ts) ], [ 'Событие', r => events[r.kind] || r.kind ], [ 'Нода', r => r.node ? nodeLink(r.node) : 'Сервис выдачи' ]]} /><Pages data={data} go={go} /></Panel>}
      <footer>Снимок: {datetime(data.source.collectedAt)} UTC · обновление каждые 15 с · история до 31 дня · только чтение</footer>
      </>}
    </main>
    {selected && <div className="drawer-shade" onClick={() => setSelected(null)}><section className="drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title" onClick={e => e.stopPropagation()} onKeyDown={e => dialogKeys(e, () => setSelected(null))}><button autoFocus className="icon-button close" aria-label="Закрыть подробности" onClick={() => setSelected(null)}><X size={22} /></button><div className="eyebrow">ПОДРОБНОСТИ ДОСТУПА</div><h2 id="detail-title">Личный доступ</h2><Badge warning={!selected.valid}>{statuses[selected.status]}</Badge><dl><dt>ID, не код подключения</dt><dd className="mono">{selected.id}</dd><dt>Действует до, UTC</dt><dd>{datetime(selected.expires)}</dd><dt>Зарегистрировано устройств</dt><dd>{selected.devices} / {selected.deviceLimit}</dd><dt>Использовано сегодня, UTC</dt><dd>{bytes(selected.bytesToday)} из {bytes(selected.dailyLimit)}</dd></dl><div className="notice">Пароли, коды подключения, IP и история посещений не собираются в админке. Изменение и отзыв доступа отключены до подключения авторизации.</div></section></div>}
  </div>
}
createRoot(document.getElementById('root')).render(<App />)
