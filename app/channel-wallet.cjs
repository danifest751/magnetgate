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
    this.locking = new Map() // USDT swap file -> the error of its last lock, while one runs or after it failed
  }
  file(name) { return path.join(this.dir, name) }
  exists() { return fs.existsSync(this.file('key.txt')) && fs.existsSync(this.file('pass.bin')) }

  // requant-wallet with the network and API of the service's channel settings; resolves stdout
  run(args, info, extra = {}, timeout = 60000) {
    const env = { ...process.env, ...extra }
    if (this.exists()) env.REQUANT_WALLET_PASSPHRASE = this.safeStorage.decryptString(fs.readFileSync(this.file('pass.bin')))
    const api = info.channels?.api || info.swaps?.requantApi
    const argv = [...args, '--network', info.network, '--api', api, '--yes']
    return new Promise((resolve, reject) => {
      this.runner(this.binary, argv, { cwd: this.dir, env, timeout, windowsHide: true }, (error, stdout, stderr) => {
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

  // ---- buying RQT from the service's maker (atomic swaps: Lightning, on-chain Bitcoin or USDT on TRON) --
  swapIndex() {
    const f = this.file('swaps.json')
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []
  }
  saveSwaps(list) { fs.writeFileSync(this.file('swaps.json'), JSON.stringify(list.slice(-20), null, 2)) }

  // Start a purchase; the swap file (it holds the secret) stays in the wallet directory.
  async buy(info, method, rqtAtoms) {
    const s = info.swaps
    if (!s || !s.methods.includes(method) || (method === 'usdt' && !s.usdt)) throw new Error(I18n.t('swap.unavailable'))
    if (!Number.isSafeInteger(rqtAtoms) || rqtAtoms < s.minAtoms || rqtAtoms > s.maxAtoms)
      throw new Error(I18n.t('swap.badAmount', { min: rqt(s.minAtoms), max: rqt(s.maxAtoms) }))
    fs.mkdirSync(this.file('swaps'), { recursive: true, mode: 0o700 })
    const name = 'swaps/' + Date.now() + '.json'
    const command = { lightning: 'buy-ln', bitcoin: 'buy', usdt: 'buy-usdt' }[method]
    const out = await this.run(['swap', command, s.maker, rqt(rqtAtoms), 'key.txt', '--out', name], info)
    const line = key => (out.split(/\r?\n/).find(l => l.startsWith(key)) || '').slice(key.length).trim()
    const record = JSON.parse(fs.readFileSync(this.file(name), 'utf8'))
    const entry = { file: name, method, created: Date.now(), rqtAtoms, sats: record.btc_sats, state: 'waiting',
      invoice: method === 'lightning' ? line('invoice') : undefined,
      address: method === 'bitcoin' ? line('to') : method === 'usdt' ? record.terms.sender : undefined,
      usdtUnits: method === 'usdt' ? record.units : undefined, tronNetwork: method === 'usdt' ? record.tron_network : undefined }
    this.saveSwaps([...this.swapIndex(), entry])
    return entry
  }

  // Follow every open purchase: lock USDT once it has arrived (in the background: it waits about two
  // minutes for TRON), and claim the RQT once the maker has locked them. Returns the list.
  async advance(info) {
    const list = this.swapIndex()
    for (const e of list) {
      if (['done', 'claimed', 'failed', 'refunded'].includes(e.state)) continue
      // a failed or late purchase can still need its refund; USDT ones are followed until then
      if (['expired', 'rqt_refunded'].includes(e.state) && e.method !== 'usdt') continue
      try {
        const st = JSON.parse(await this.run(['swap', 'status', e.file], info))
        e.state = ['btc_claimed', 'token_claimed'].includes(st.state) ? 'claimed' : st.state
        if (e.method === 'usdt') {
          Object.assign(e, { held: st.usdt_held, lock: st.lock, refundFrom: st.refund_from })
          if (this.locking.has(e.file)) e.note = this.locking.get(e.file) || undefined
          // locked, the maker not yet: nothing more to send
          if (st.state === 'waiting_token' && st.lock === 'open') e.state = 'usdt_locked'
          if (st.state === 'waiting_token' && st.lock === 'none' && Number(st.usdt_held) >= Number(st.usdt_to_lock)) {
            if (this.locking.get(e.file) === null) e.state = 'locking'
            else this.lockUsdt(info, e.file)
          }
        }
        if (st.state === 'rqt_locked') {
          await this.run(['swap', 'claim', e.file, 'key.txt'], info)
          e.state = 'claimed'
        }
      } catch (error) { e.note = String(error.message).slice(0, 160) }
    }
    this.saveSwaps(list)
    return list
  }

  // `swap lock` approves and locks the USDT and waits for TRON (one or two minutes); one at a time per swap
  lockUsdt(info, file) {
    this.locking.set(file, null)
    this.run(['swap', 'lock', file], info, {}, 300000)
      .then(() => this.locking.delete(file))
      .catch(error => this.locking.set(file, String(error.message).slice(0, 160)))
  }

  // Taking back what a purchase the maker did not complete paid: BTC on chain (from the Bitcoin timeout, to
  // `address`), or USDT on TRON (from the lock's refund time: back to the swap's address, then to `address`).
  async refundSwap(info, file, address, fetcher = fetch) {
    const entry = this.swapIndex().find(e => e.file === file)
    if (entry?.method === 'usdt') return this.refundUsdt(info, file, address)
    const btcAddress = address
    if (typeof btcAddress !== 'string' || !/^[a-z0-9]{14,90}$/i.test(btcAddress)) throw new Error(I18n.t('swap.badAddress'))
    const hex = (await this.run(['swap', 'refund', file, btcAddress], info)).trim()
    const reply = await fetcher(info.swaps.bitcoinApi + '/tx', { method: 'POST', body: hex, signal: AbortSignal.timeout(30000) })
    const text = await reply.text()
    if (!reply.ok) throw new Error(text.slice(0, 200))
    const list = this.swapIndex()
    for (const e of list) if (e.file === file) { e.state = 'refunded'; e.refundTxid = text.trim() }
    this.saveSwaps(list)
    return text.trim()
  }

  async refundUsdt(info, file, tronAddress) {
    if (typeof tronAddress !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(tronAddress)) throw new Error(I18n.t('swap.badTronAddress'))
    const st = JSON.parse(await this.run(['swap', 'status', file], info))
    // a lock still open goes back to the swap's own address first (allowed from its refund time)
    if (st.lock === 'open') await this.run(['swap', 'refund', file], info, {}, 300000)
    const out = await this.run(['swap', 'withdraw', file, tronAddress], info, {}, 300000)
    const list = this.swapIndex()
    for (const e of list) if (e.file === file) { e.state = 'refunded'; e.note = undefined }
    this.saveSwaps(list)
    return out.trim()
  }

  refund(info) { return this.run(['channel', 'refund', 'channel.json'], info) }
}

module.exports = { ChannelWallet, rqt, STEP_MINUTES }
