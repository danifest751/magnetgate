// The app's pay-as-you-go path against a real access service and a Requant regtest node; started by
// web/e2e_app.py, which sets SERVICE, CODE, WALLET_BIN, MINER_KEY and WORK.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { ChannelWallet } = require('../channel-wallet.cjs')

const { SERVICE, CODE, WALLET_BIN, MINER_KEY, WORK } = process.env
const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => String(b) }
const post = async (pathname, body) => {
  const reply = await fetch(SERVICE + '/api/' + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const value = await reply.json()
  if (!reply.ok) { const e = new Error(value.error); e.status = reply.status; throw e }
  return value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(what, f, secs = 120) {
  const t = Date.now()
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() - t > secs * 1000) throw new Error('timed out waiting for ' + what)
    await sleep(500)
  }
}

;(async () => {
  const wallet = new ChannelWallet(WORK, safeStorage, WALLET_BIN, post)
  let payment = await post('payment', { code: CODE })
  assert.ok(payment.channels, 'the service offers channels')
  const created = await wallet.create('regtest passphrase', payment)
  // the miner pays the app's wallet 5 RQT
  execFileSync(WALLET_BIN, ['send', MINER_KEY, created.address, '5', '--network', payment.network, '--api', payment.channels.api, '--yes'])
  await until('the wallet balance', async () => (await wallet.status(payment)).balanceAtoms >= 5e8)
  await wallet.open(payment, CODE, 2e8)
  // pay as you go: the first state is refused until the deposit confirms, then taken
  const taken = await until('the first payment to count', async () => {
    payment = await post('payment', { code: CODE })
    try { await wallet.keepPaid(payment, CODE) } catch (error) { if (error.status !== 409) throw error }
    payment = await post('payment', { code: CODE })
    return payment.channel?.status === 'open' && payment
  })
  assert.equal(taken.tier, 'full')
  assert.equal(taken.channel.paidAtoms, 5 * taken.channels.priceAtomsPerMinute)
  assert.ok(taken.paidUntil * 1000 > Date.now() + 4 * 60000)
  // nothing more while enough is paid ahead
  assert.equal(await wallet.keepPaid(taken, CODE), null)
  const closed = await wallet.close(CODE)
  assert.equal(closed.channel.status, 'closed')
  console.log('APP E2E OK: paid', taken.channel.paidAtoms, 'atoms, closed in', closed.channel.closedTxid)
})().catch(error => { console.error(error); process.exit(1) })
