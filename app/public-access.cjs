const crypto = require('node:crypto')
const I18n = require('./renderer/i18n.js')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

function validateProfile(value) {
  if (value?.version !== 1 || !Number.isSafeInteger(value.expires) || value.expires * 1000 <= Date.now() ||
      !Array.isArray(value.endpoints) || !value.endpoints.length || value.endpoints.length > 4)
    throw new Error(I18n.t('publicAccess.badProfile'))
  if (value.tier !== undefined && !['free', 'full'].includes(value.tier)) throw new Error(I18n.t('publicAccess.badProfile'))
  for (const d of value.endpoints) {
    if (d.t !== 'hy2' || !net.isIPv4(d.host) || /^(0|10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(d.host) || ![4443, 4444].includes(d.port) ||
        !/^[a-f0-9]{64}$/.test(d.pw) || !/^[a-f0-9]{64}$/.test(d.obfs) ||
        !['FI', 'NL'].includes(d.country) || d.sni !== 'magnet.norma.so' ||
        typeof d.ca !== 'string' || d.ca.length > 4096 || !d.ca.startsWith('-----BEGIN CERTIFICATE-----'))
      throw new Error(I18n.t('publicAccess.badAddress'))
  }
  return value
}

// A Requant address (bech32m; the service checks the checksum against its own list).
const ADDRESS = /^(trq|rqrt|rq)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,80}$/
const atoms = v => Number.isSafeInteger(v) && v >= 0

function validatePayment(value) {
  const ok = value && ADDRESS.test(value.address) && ['free', 'full'].includes(value.tier) &&
    value.currency === 'RQT' && ['test', 'regtest', 'main'].includes(value.network) &&
    atoms(value.priceAtomsPerDay) && value.priceAtomsPerDay > 0 && atoms(value.balanceAtoms) &&
    atoms(value.paidUntil) && atoms(value.expires) && Number.isSafeInteger(value.confirmations) &&
    Array.isArray(value.discounts) && value.discounts.length <= 10 &&
    value.discounts.every(d => Array.isArray(d) && d.length === 2 && Number.isSafeInteger(d[0]) && d[0] > 0 &&
      Number.isSafeInteger(d[1]) && d[1] >= 0 && d[1] < 100) &&
    Array.isArray(value.credits) && value.credits.length <= 20 &&
    value.credits.every(c => /^[a-f0-9]{64}$/.test(c?.txid) && atoms(c.atoms) && atoms(c.days))
  if (!ok) throw new Error(I18n.t('publicAccess.badPayment'))
  return value
}

// POST a JSON body to the access service and read a bounded JSON answer.
async function post(pathname, body, fetcher) {
  const reply = await fetcher('https://magnet.norma.so/api/' + pathname, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  const reader = reply.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 24000) throw new Error(I18n.t('publicAccess.tooLarge'))
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!reply.ok) {
    const error = new Error(typeof value.error === 'string' ? value.error.slice(0, 240) : I18n.t('publicAccess.unavailable'))
    error.status = reply.status
    throw error
  }
  return value
}

function checkCode(code) {
  if (typeof code !== 'string' || !/^MG1-[a-f0-9]{64}$/.test(code.trim()))
    throw new Error(I18n.t('publicAccess.badCode'))
  return code.trim()
}

async function requestProfile(code, device, fetcher = fetch) {
  return validateProfile(await post('profile', { code: checkCode(code), device }, fetcher))
}

// The account's deposit address, tier and balance; null when the service takes no payments.
async function requestPayment(code, fetcher = fetch) {
  try {
    return validatePayment(await post('payment', { code: checkCode(code) }, fetcher))
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
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
      if (!/^[a-f0-9]{64}$/.test(device)) throw new Error(I18n.t('publicAccess.badDevice'))
      return device
    }
    const device = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(this.deviceFile, JSON.stringify({ device }), { mode: 0o600, flag: 'wx' })
    return device
  }
  async activate(code) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error(I18n.t('publicAccess.noSecureStorage'))
    const profile = await requestProfile(code, this.device())
    const temporary = this.file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
    fs.writeFileSync(temporary, this.safeStorage.encryptString(code.trim()), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, this.file)
    this.profile = profile
    return profile
  }
  async refresh() {
    if (this.endpoints().length && Date.now() - (this.fetchedAt || 0) < 300000) return this.profile
    if (!fs.existsSync(this.file)) throw new Error(I18n.t('publicAccess.noCode'))
    this.profile = await requestProfile(this.safeStorage.decryptString(fs.readFileSync(this.file)), this.device())
    this.fetchedAt = Date.now()
    return this.profile
  }
  endpoints() { return this.profile && this.profile.expires * 1000 > Date.now() ? this.profile.endpoints : [] }
  async payment(fetcher = fetch) {
    if (!fs.existsSync(this.file)) return null
    const payment = await requestPayment(this.safeStorage.decryptString(fs.readFileSync(this.file)), fetcher)
    // paid days change the endpoints (the full tier's listener): fetch the profile again on connect
    if (payment && this.profile && payment.tier !== (this.profile.tier || 'free')) this.fetchedAt = 0
    return payment
  }
}
module.exports = { PublicAccess, requestProfile, requestPayment, validateProfile, validatePayment }
