const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

function validateProfile(value) {
  if (value?.version !== 1 || !Number.isSafeInteger(value.expires) || value.expires * 1000 <= Date.now() ||
      !Array.isArray(value.endpoints) || !value.endpoints.length || value.endpoints.length > 4)
    throw new Error('Сервис вернул некорректный профиль.')
  for (const d of value.endpoints) {
    if (d.t !== 'hy2' || !net.isIPv4(d.host) || /^(0|10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(d.host) || d.port !== 4443 ||
        !/^[a-f0-9]{64}$/.test(d.pw) || !/^[a-f0-9]{64}$/.test(d.obfs) ||
        !['FI', 'NL'].includes(d.country) || d.sni !== 'magnet.norma.so' ||
        typeof d.ca !== 'string' || d.ca.length > 4096 || !d.ca.startsWith('-----BEGIN CERTIFICATE-----'))
      throw new Error('Не удалось проверить адреса сервиса.')
  }
  return value
}

async function requestProfile(code, device, fetcher = fetch) {
  if (typeof code !== 'string' || !/^MG1-[a-f0-9]{64}$/.test(code.trim()))
    throw new Error('Вставьте личный код с сайта magnet.norma.so. Он начинается с MG1-.')
  const reply = await fetcher('https://magnet.norma.so/api/profile', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim(), device })
  })
  const reader = reply.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 24000) throw new Error('Слишком большой ответ сервиса.')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!reply.ok) throw new Error(typeof value.error === 'string' ? value.error.slice(0, 240) : 'Сервис доступа временно недоступен.')
  return validateProfile(value)
}

class PublicAccess {
  constructor(directory, safeStorage) {
    this.file = path.join(directory, 'public-access.bin')
    this.deviceFile = path.join(directory, 'public-device.json')
    this.safeStorage = safeStorage
    this.profile = null
  }
  device() {
    if (fs.existsSync(this.deviceFile)) {
      const device = JSON.parse(fs.readFileSync(this.deviceFile, 'utf8')).device
      if (!/^[a-f0-9]{64}$/.test(device)) throw new Error('Повреждён идентификатор устройства.')
      return device
    }
    const device = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(this.deviceFile, JSON.stringify({ device }), { mode: 0o600, flag: 'wx' })
    return device
  }
  async activate(code) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Защищённое хранилище системы недоступно.')
    const profile = await requestProfile(code, this.device())
    const temporary = this.file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
    fs.writeFileSync(temporary, this.safeStorage.encryptString(code.trim()), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, this.file)
    this.profile = profile
    return profile
  }
  async refresh() {
    if (this.endpoints().length && Date.now() - (this.fetchedAt || 0) < 300000) return this.profile
    if (!fs.existsSync(this.file)) throw new Error('Сначала добавьте личный код в настройках.')
    this.profile = await requestProfile(this.safeStorage.decryptString(fs.readFileSync(this.file)), this.device())
    this.fetchedAt = Date.now()
    return this.profile
  }
  endpoints() { return this.profile && this.profile.expires * 1000 > Date.now() ? this.profile.endpoints : [] }
}
module.exports = { PublicAccess, requestProfile, validateProfile }
