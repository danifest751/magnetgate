// Optional browser regression suite. Uses only fixture IPC; never starts Electron or a VPN.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation. Requires Edge on Windows.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const fs = require('node:fs')
const { DEFAULT_CONFIG, validateConfig } = require('../../src/config.cjs')
const url = pathToFileURL(path.resolve(__dirname, '../renderer/index.html')).href
const output = path.resolve(__dirname, '../../tools/verification/ui-0.3.0')
const baseConfig = {
  ...DEFAULT_CONFIG,
  exits: [{ name: 'Основной', psk: 'fixture-only', salt: 'a'.repeat(40) }],
  directDomains: ['example.org']
}
const idle = { vpnOn: false, phase: 'idle', engineReady: false }
const connected = {
  vpnOn: true,
  phase: 'connected',
  vpnHealthy: true,
  engineReady: true,
  activeMode: 'full',
  clientRunning: true,
  rvReady: true,
  proxyEgress: '203.0.113.20',
  egress: '203.0.113.20'
}
let browser,
  checks = 0
const errors = []
async function fixture(options = {}) {
  const page = await browser.newPage({
    viewport: { width: 940, height: 730 },
    colorScheme: 'dark'
  })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.exposeFunction('validateFixture', validateConfig)
  await page.addInitScript(
    ({ config, state, configError, logError }) => {
      const clone = (v) => structuredClone(v)
      const f = (window.fixture = {
        config,
        state,
        saveDelay: 0,
        saves: [],
        attempts: 0,
        connect: 0,
        disconnect: 0,
        apply: 0,
        failSave: false,
        holdApply: false
      })
      let onStatus, onLog
      f.emit = (changes) => {
        Object.assign(f.state, changes)
        onStatus?.(clone(f.state))
      }
      f.log = (line) => onLog?.(line)
      window.mg = {
        getConfig: async () => {
          if (configError) throw new Error('fixture config error')
          return clone(f.config)
        },
        getState: async () => clone(f.state),
        getLog: async () => {
          if (logError) throw new Error('fixture log error')
          return ['fixture log']
        },
        getLogPath: async () => 'fixture/logs/magnetgate.log',
        saveConfig: async (config) => {
          f.attempts++
          if (f.saveDelay) await new Promise((resolve) => setTimeout(resolve, f.saveDelay))
          if (f.failSave) throw new Error('fixture save error')
          f.config = await window.validateFixture(config)
          f.saves.push(clone(f.config))
          return clone(f.config)
        },
        connect: async () => {
          f.connect++
          f.emit({ vpnOn: true, phase: 'starting', vpnHealthy: false })
        },
        disconnect: async () => {
          f.disconnect++
          f.emit({
            vpnOn: false,
            phase: 'idle',
            engineReady: false,
            guardRecoveryRequired: false,
            stopRecoveryRequired: false,
            otherTunnel: null
          })
        },
        vpnOn: async () => {
          f.apply++
          if (!f.holdApply)
            f.emit({
              activeMode: f.config.vpnMode,
              phase: 'connected',
              vpnHealthy: true,
              engineReady: true,
              modePending: false
            })
        },
        genPsk: async () => 'fixture-generated-key',
        openConfigDir: async () => {
          f.openDir = true
        },
        openLogs: async () => {
          f.openLogs = true
        },
        onStatus: (cb) => {
          onStatus = cb
        },
        onLog: (cb) => {
          onLog = cb
        }
      }
    },
    { config: options.config || baseConfig, state: options.state || idle, ...options }
  )
  await page.goto(url)
  await page.waitForFunction(() => !document.querySelector('#btnConnect').disabled)
  return page
}
async function nav(page, name) {
  await page.locator(`[data-page="${name}"]`).click()
}
async function has(page, selector, text) {
  await page.waitForFunction(
    ({ selector, text }) => document.querySelector(selector)?.textContent.includes(text),
    { selector, text }
  )
  checks++
}
async function checkValue(page, expression, expected) {
  assert.deepEqual(await page.evaluate(expression), expected)
  checks++
}
async function noOverflow(page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false
  )
  checks++
}
async function settings(page) {
  await nav(page, 'settings')
  await page.locator('#serverSettings').evaluate((el) => (el.open = true))
  await page.locator('#localPort').evaluate((el) => (el.closest('details').open = true))
}
async function run() {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  fs.mkdirSync(output, { recursive: true })
  let page = await fixture({ state: connected })
  await has(page, '#phase', 'Подключено')
  await page.screenshot({ path: path.join(output, 'connection-dark.png'), fullPage: true })
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const width of [940, 620]) {
      await page.setViewportSize({ width, height: 600 })
      for (const name of ['connection', 'sites', 'settings', 'diagnostics']) {
        await nav(page, name)
        if (name === 'settings') await settings(page)
        await noOverflow(page)
        await page.screenshot({
          path: path.join(output, `${name}-${scheme}-${width}.png`),
          fullPage: true
        })
      }
    }
  }
  await checkValue(page, () => window.fixture.connect, 0)
  await nav(page, 'connection')
  await page.evaluate(() => {
    fixture.saveDelay = 180
    fixture.holdApply = true
  })
  await page.locator('#btnModeSplit').click()
  await page.locator('#btnModeFull').click()
  await page.waitForFunction(() => fixture.saves.length === 2)
  await checkValue(page, () => fixture.saves.map((s) => s.vpnMode), ['split', 'full'])
  await page.locator('#btnModeSplit').click()
  await has(page, '#phase', 'Применяем режим')
  await page.evaluate(() => fixture.emit({ activeMode: 'split', modePending: false }))
  await has(page, '#phase', 'Подключено')
  await page.close()

  page = await fixture()
  await settings(page)
  await page.locator('#localPort').fill('0')
  await nav(page, 'sites')
  await page.locator('#domain').fill('https://Example.COM/path')
  await page.locator('#btnAddSite').click()
  await has(page, '#siteList', 'example.com')
  await checkValue(page, () => fixture.config.localPort, 1080)
  await page.locator('[data-list="tunnelDomains"]').click()
  await page.locator('#domain').fill('selected.example')
  await page.locator('#btnAddSite').click()
  await has(page, '#siteList', 'selected.example')
  await checkValue(
    page,
    () => ({
      mode: fixture.config.vpnMode,
      direct: fixture.config.directDomains,
      tunnel: fixture.config.tunnelDomains
    }),
    { mode: 'full', direct: ['example.org', 'example.com'], tunnel: ['selected.example'] }
  )
  await page.locator('#domain').fill('selected.example')
  await page.locator('#btnAddSite').click()
  await has(page, '#siteMessage', 'уже есть')
  await page.locator('#domain').fill('<script>alert(1)</script>')
  await page.locator('#btnAddSite').click()
  await checkValue(page, () => fixture.saves.length, 2)
  await page.evaluate(() => (fixture.failSave = true))
  await page.getByRole('button', { name: 'Убрать selected.example', exact: true }).click()
  await has(page, '#siteMessage', 'Не сохранено')
  await has(page, '#siteList', 'selected.example')
  await page.evaluate(() => (fixture.failSave = false))
  await page.getByRole('button', { name: 'Убрать selected.example', exact: true }).click()
  await has(page, '#siteList', 'пока нет сайтов')
  await settings(page)
  await page.locator('#btnSaveAdvanced').click()
  await has(page, '#advancedMessage', 'от 1024 до 65535')
  await checkValue(page, () => fixture.saves.length, 3)
  await page.locator('#localPort').fill('12080')
  await page.evaluate(() => (fixture.saveDelay = 400))
  await page.locator('#btnSaveAdvanced').click()
  await page.locator('#localPort').fill('12081')
  await has(page, '#advancedMessage', 'Есть новые несохранённые')
  assert.equal(await page.locator('#localPort').inputValue(), '12081')
  checks++
  await checkValue(page, () => fixture.config.localPort, 12080)
  const name = page.getByRole('textbox', { name: 'Название · сервер 1', exact: true })
  await name.fill('Сохранённое имя')
  await page.locator('#btnSaveServers').click()
  await name.fill('Новый черновик')
  await has(page, '#serversMessage', 'Есть новые несохранённые')
  assert.equal(await name.inputValue(), 'Новый черновик')
  checks++
  await checkValue(page, () => fixture.config.exits[0], {
    name: 'Сохранённое имя',
    psk: 'fixture-only',
    salt: 'a'.repeat(40)
  })
  assert.equal(
    await page.locator('input[aria-label="Ключ доступа · сервер 1"]').getAttribute('type'),
    'password'
  )
  checks++
  await page.locator('#killSwitch').check()
  await has(page, '#guardNote', 'Закрытие приложения')
  await nav(page, 'sites')
  await page.locator('[data-list="directDomains"]').click()
  await page.waitForFunction(() => !document.querySelector('#listWarning').hidden)
  await page.evaluate(() => {
    for (let i = 0; i < 550; i++) fixture.log('line ' + i)
    fixture.log('<img src=x onerror="window.injected=true">')
  })
  await checkValue(
    page,
    () => document.querySelector('#log').textContent.split('\n').length,
    500
  )
  await checkValue(
    page,
    () => document.querySelector('#log img') === null && !window.injected,
    true
  )
  await page.close()

  for (const recovery of ['stopRecoveryRequired', 'guardRecoveryRequired']) {
    page = await fixture({
      config: { ...baseConfig, exits: [] },
      state: { ...idle, [recovery]: true, otherTunnel: 'WireGuard' }
    })
    await has(
      page,
      '#btnConnect',
      recovery === 'stopRecoveryRequired' ? 'Повторить отключение' : 'Восстановить интернет'
    )
    await page.locator('#btnConnect').click()
    await checkValue(page, () => [fixture.disconnect, fixture.connect], [1, 0])
    await page.close()
  }
  page = await fixture({ configError: true, state: { ...idle, guardRecoveryRequired: true } })
  await has(page, '#btnConnect', 'Восстановить интернет')
  await page.locator('#btnConnect').click()
  await checkValue(page, () => fixture.disconnect, 1)
  await page.close()
  page = await fixture({ logError: true })
  await page.locator('#btnConnect').click()
  await checkValue(page, () => fixture.connect, 1)
  await page.close()
  page = await fixture({ config: { ...baseConfig, exits: [] } })
  await page.locator('#btnConnect').click()
  await page.waitForFunction(() => document.querySelector('#serverSettings').open)
  await page.locator('#btnSaveServers').click()
  await has(page, '#serversMessage', 'Укажите ключ')
  await checkValue(page, () => [fixture.connect, fixture.saves.length], [0, 0])
  await page.close()
  page = await fixture({ state: { ...idle, phase: 'blocked', otherTunnel: 'WireGuard' } })
  await has(page, '#btnConnect', 'Повторить')
  await page.locator('#btnConnect').click()
  await checkValue(page, () => fixture.connect, 1)
  await page.close()
  assert.deepEqual(errors, [])
  checks++
  console.log(
    JSON.stringify(
      { checks, pageErrors: errors, screenshots: output, vpnStarted: false },
      null,
      2
    )
  )
}
run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await browser?.close()
  })
