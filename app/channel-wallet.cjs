// The in-app wallet for payment channels: one Requant key file and at most one channel at a time.
//
// The key file is the standard requant-wallet format, encrypted with the passphrase the user chose; the
// passphrase is kept with the system's secure storage so that payments run without asking. Every
// operation runs the bundled requant-wallet binary (`channel open/fund/pay/refund`); the access service
// signs the refund and takes the states (PAYMENTS.md, payment channels).
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const I18n = require('./renderer/i18n.js')

const FEE = 1000 // atoms: the fee of every channel state (requant-wallet CHANNEL_FEE)
const STEP_MINUTES = 5 // what one automatic payment buys
const KEEP_AHEAD = 180 // seconds of paid time below which the next payment goes out

function rqt(atoms) {
  const whole = Math.floor(atoms / 1e8)
  const part = String(atoms % 1e8).padStart(8, '0').replace(/0+$/, '')
  return part ? whole + '.' + part : String(whole)
}

class ChannelWallet {
  constructor(directory, safeStorage, binary, post, run = execFile) {
    this.dir = path.join(directory, 'wallet')
    this.safeStorage = safeStorage
    this.binary = binary
    this.post = post
    this.runner = run
    this.busy = null
  }
  file(name) { return path.join(this.dir, name) }
  exists() { return fs.existsSync(this.file('key.txt')) && fs.existsSync(this.file('pass.bin')) }

  // requant-wallet with the network and API of the service's channel settings; resolves stdout
  run(args, info, extra = {}) {
    const env = { ...process.env, ...extra }
    if (this.exists()) env.REQUANT_WALLET_PASSPHRASE = this.safeStorage.decryptString(fs.readFileSync(this.file('pass.bin')))
    const argv = [...args, '--network', info.network, '--api', info.channels.api, '--yes']
    return new Promise((resolve, reject) => {
      this.runner(this.binary, argv, { cwd: this.dir, env, timeout: 60000, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout))
        const line = String(stderr || '').trim().split(/\r?\n/).pop() || error.message
        reject(new Error(line.replace(/^requant-wallet: /, '').slice(0, 240)))
      })
    })
  }

  async create(passphrase, info) {
    if (typeof passphrase !== 'string' || passphrase.length < 8) throw new Error(I18n.t('wallet.shortPassphrase'))
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error(I18n.t('publicAccess.noSecureStorage'))
    if (this.exists()) throw new Error(I18n.t('wallet.exists'))
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    await this.run(['keygen', 'key.txt'], info, { REQUANT_WALLET_PASSPHRASE: passphrase })
    fs.writeFileSync(this.file('pass.bin'), this.safeStorage.encryptString(passphrase), { mode: 0o600 })
    return this.status(info)
  }

  exportKey(destination) { fs.copyFileSync(this.file('key.txt'), destination) }

  // a proposal is waiting and there is no accepted channel: opening has to be finished
  pending() { return fs.existsSync(this.file('proposed.json')) && !fs.existsSync(this.file('channel.json')) }

  channel() {
    return fs.existsSync(this.file('channel.json')) ? JSON.parse(fs.readFileSync(this.file('channel.json'), 'utf8')) : null
  }

  // The wallet's address and confirmed balance, and the channel file's own record.
  async status(info) {
    if (!this.exists()) return { exists: false }
    const out = await this.run(['address', 'key.txt'], info)
    const field = name => (out.split(/\r?\n/).find(l => l.startsWith(name)) || '').split(/\s+/).pop()
    let balance = null
    try {
      const b = await this.run(['balance', 'key.txt'], info)
      const line = b.split(/\r?\n/).find(l => l.startsWith('confirmed')) || ''
      balance = Math.round(Number(line.split(/\s+/)[1]) * 1e8)
    } catch { /* the API may be unreachable; the address is still shown */ }
    const ch = this.channel()
    return { exists: true, address: field('address'), pubkey: field('pubkey'), balanceAtoms: balance,
      channel: ch && { deposit: ch.deposit, paid: ch.paid, expiry: ch.expiry, accepted: ch.accepted }, pending: this.pending() }
  }

  // Propose a channel to the service, store what it accepted, then send the deposit.
  async open(info, code, depositAtoms) {
    const c = info.channels
    if (!Number.isSafeInteger(depositAtoms) || depositAtoms < c.minDepositAtoms) throw new Error(I18n.t('wallet.depositTooSmall', { amount: rqt(c.minDepositAtoms) }))
    if (['accepted', 'open'].includes(info.channel?.status) && !this.pending()) throw new Error(I18n.t('wallet.channelExists'))
    const height = await this.height(info)
    const expiry = height + Math.min(c.maxBlocks, Math.max(c.minBlocks + c.closeMarginBlocks + 60, 10080))
    for (const name of ['channel.json', 'state.hex']) fs.rmSync(this.file(name), { force: true })
    // a proposal whose answer was lost goes again as it is, rather than locking other coins in a second one
    if (!fs.existsSync(this.file('proposed.json')))
      await this.run(['channel', 'open', 'key.txt', c.serverPubkey, c.payTo, rqt(depositAtoms), String(expiry), '--out', 'proposed.json'], info)
    const proposed = JSON.parse(fs.readFileSync(this.file('proposed.json'), 'utf8'))
    // the service answers with its signature of the refund and where it goes (answers over some mobile
    // networks stall after their first packet); requant-wallet checks the signature before funding
    const { sig2, at } = await this.post('channel/open', { code, channel: proposed })
    const mine = proposed.refund
    if (!/^[0-9a-f]{128}$/.test(sig2 || '') || !Number.isSafeInteger(at) || at < 0 || at % 2 ||
        mine.slice(at, at + 128) !== '0'.repeat(128))
      throw new Error(I18n.t('wallet.badAccept'))
    const accepted = { ...proposed, refund: mine.slice(0, at) + sig2 + mine.slice(at + 128), accepted: true }
    fs.writeFileSync(this.file('channel.json'), JSON.stringify(accepted, null, 2))
    fs.rmSync(this.file('proposed.json'), { force: true })
    await this.run(['channel', 'fund', 'key.txt', 'channel.json'], info)
    return accepted
  }

  async height(info) {
    const reply = await fetch(info.channels.api + '/api/info', { signal: AbortSignal.timeout(15000) })
    const value = await reply.json()
    if (!Number.isSafeInteger(value.height)) throw new Error(I18n.t('publicAccess.unavailable'))
    return value.height
  }

  // Sign a state paying `totalAtoms` so far and give it to the service.
  async pay(info, code, totalAtoms) {
    await this.run(['channel', 'pay', 'key.txt', 'channel.json', rqt(totalAtoms), '--out', 'state.hex'], info)
    return this.post('channel/pay', { code, state: fs.readFileSync(this.file('state.hex'), 'utf8').trim() })
  }

  // One step of pay-as-you-go: keep a few minutes of full access paid ahead while connected.
  async keepPaid(payment, code, now = Date.now()) {
    const ch = this.channel()
    if (!payment?.channels || !ch?.accepted || payment.channel?.status === 'closed') return null
    if (payment.paidUntil * 1000 - now > KEEP_AHEAD * 1000) return null
    // the service has not taken the last state yet (the deposit still confirming): send it again
    // instead of signing more
    if (ch.paid > (payment.channel?.paidAtoms || 0) && fs.existsSync(this.file('state.hex')))
      return this.post('channel/pay', { code, state: fs.readFileSync(this.file('state.hex'), 'utf8').trim() })
    const most = ch.deposit - FEE
    if (ch.paid >= most) return null
    const total = Math.min(most, ch.paid + STEP_MINUTES * payment.channels.priceAtomsPerMinute)
    return this.pay(payment, code, total)
  }

  close(code) { return this.post('channel/close', { code }) }

  refund(info) { return this.run(['channel', 'refund', 'channel.json'], info) }
}

module.exports = { ChannelWallet, rqt, STEP_MINUTES }
