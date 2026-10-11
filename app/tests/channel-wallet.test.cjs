const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ChannelWallet, rqt } = require('../channel-wallet.cjs')
const I18n = require('../renderer/i18n.js')
const { channelView, parseRqt } = require('../renderer/state.js')

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from('enc:' + s),
  decryptString: b => String(b).slice(4)
}
const payment = (change = {}) => ({
  network: 'test', confirmations: 6, paidUntil: 0,
  channels: { api: 'http://api', serverPubkey: 'ab'.repeat(32), payTo: 'trq1server', minDepositAtoms: 1e8, minBlocks: 1440,
    maxBlocks: 20160, closeMarginBlocks: 120, priceAtomsPerMinute: 138889 },
  ...change
})

// requant-wallet stand-in: records calls and writes what the real one writes
function fakeWallet(calls) {
  return (binary, argv, options, done) => {
    calls.push({ argv, passphrase: options.env.REQUANT_WALLET_PASSPHRASE })
    const file = name => path.join(options.cwd, name)
    const [cmd, sub] = argv
    if (cmd === 'keygen') fs.writeFileSync(file(argv[1]), 'requant-key:1:x')
    if (cmd === 'address') return done(null, 'address  trq1client\nkey hash ' + '0'.repeat(64) + '\npubkey   ' + 'cd'.repeat(32) + '\n')
    if (cmd === 'balance') return done(null, 'confirmed   5.5 RQT in 2 outputs\n')
    if (cmd === 'channel' && sub === 'open')
      fs.writeFileSync(file('proposed.json'), JSON.stringify({ funding_txid: 'f'.repeat(64), refund: 'aa'.repeat(10) + '0'.repeat(128) + 'bb', deposit: Number(argv[5]) * 1e8, paid: 0, accepted: false }))
    if (cmd === 'channel' && sub === 'pay') {
      const ch = JSON.parse(fs.readFileSync(file('channel.json')))
      ch.paid = Math.round(Number(argv[4]) * 1e8)
      fs.writeFileSync(file('channel.json'), JSON.stringify(ch))
      fs.writeFileSync(file('state.hex'), 'beef' + ch.paid)
    }
    done(null, 'sent, txid ' + 'e'.repeat(64) + '\n')
  }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-wallet-'))
  const calls = [], posts = []
  const post = async (pathname, body) => {
    posts.push({ pathname, body })
    if (pathname === 'channel/open') return { sig2: 'cd'.repeat(64), at: 20 }
    return { tier: 'full', paidUntil: 1 }
  }
  const w = new ChannelWallet(dir, safeStorage, 'requant-wallet', post, fakeWallet(calls))
  w.height = async () => 5000
  return { w, calls, posts }
}

test('a wallet is created with the chosen passphrase, kept in secure storage', async () => {
  const { w, calls } = setup()
  await assert.rejects(w.create('short', payment()), /8/)
  const status = await w.create('a long passphrase', payment())
  assert.equal(status.address, 'trq1client')
  assert.equal(status.balanceAtoms, 550_000_000)
  assert.equal(calls[0].argv[0], 'keygen')
  assert.equal(calls[0].passphrase, 'a long passphrase')
  assert.ok(calls.every(c => c.argv.includes('--api') && c.argv.includes('http://api') && c.argv.includes('test')))
  await assert.rejects(w.create('another passphrase', payment()), /already/)
})

test('opening proposes, stores the accepted channel and only then funds it', async () => {
  const { w, calls, posts } = setup()
  await w.create('a long passphrase', payment())
  await assert.rejects(w.open(payment(), 'MG1-x', 5e7), /at least 1/)
  await assert.rejects(w.open(payment({ channel: { status: 'open' } }), 'MG1-x', 2e8), /already open/)
  await w.open(payment(), 'MG1-x', 2e8)
  const open = calls.find(c => c.argv[1] === 'open').argv
  assert.deepEqual(open.slice(2, 7), ['key.txt', 'ab'.repeat(32), 'trq1server', '2', String(5000 + 10080)])
  assert.equal(posts[0].pathname, 'channel/open')
  const order = calls.map(c => c.argv[1])
  assert.ok(order.indexOf('fund') > order.indexOf('open'))
  assert.equal(w.channel().refund, 'aa'.repeat(10) + 'cd'.repeat(64) + 'bb')
  assert.equal(w.channel().accepted, true)
})

test('pay as you go keeps a few minutes ahead and stops at the deposit', async () => {
  const { w, posts } = setup()
  await w.create('a long passphrase', payment())
  await w.open(payment(), 'MG1-x', 1e8)
  const now = 1_800_000_000_000
  assert.equal(await w.keepPaid(payment({ paidUntil: now / 1000 + 600 }), 'MG1-x', now), null, 'enough paid ahead')
  await w.keepPaid(payment({ paidUntil: 0 }), 'MG1-x', now)
  assert.equal(w.channel().paid, 5 * 138889)
  assert.equal(posts.at(-1).pathname, 'channel/pay')
  assert.match(posts.at(-1).body.state, /^beef/)
  // until the service takes it, the same state goes again
  await w.keepPaid(payment({ paidUntil: 0 }), 'MG1-x', now)
  assert.equal(w.channel().paid, 5 * 138889)
  const taken = paid => payment({ channel: { status: 'open', paidAtoms: paid } })
  for (let i = 0; i < 200; i++) await w.keepPaid(taken(w.channel().paid), 'MG1-x', now)
  assert.equal(w.channel().paid, 1e8 - 1000, 'never more than the deposit less the fee')
  assert.equal(await w.keepPaid(taken(1e8 - 1000), 'MG1-x', now), null)
  assert.equal(await w.keepPaid(payment({ channel: { status: 'closed' } }), 'MG1-x', now), null)
})

test('the pay-as-you-go block in both languages', () => {
  assert.equal(parseRqt('1'), 1e8)
  assert.equal(parseRqt('0,25'), 25_000_000)
  assert.equal(parseRqt('1.123456789'), null)
  assert.equal(parseRqt('-1'), null)
  assert.equal(channelView(payment(), null), null)
  assert.equal(channelView({ network: 'test' }, { exists: true }), null)
  assert.deepEqual(channelView(payment(), { exists: false }), { create: true })
  const wallet = { exists: true, address: 'trq1client', balanceAtoms: 5e8 }
  for (const lang of ['en', 'ru']) {
    I18n.setLanguage(lang)
    const none = channelView(payment(), wallet)
    assert.ok(none.canOpen && !none.live)
    const waiting = channelView(payment({ channel: { status: 'accepted', depositAtoms: 2e8, paidAtoms: 0 } }), wallet)
    assert.ok(!waiting.canOpen && waiting.live && waiting.status.includes('2'))
    const live = channelView(payment({ channel: { status: 'open', depositAtoms: 2e8, paidAtoms: 1e7 } }), wallet)
    assert.ok(live.status.includes('0.1'))
    assert.ok(channelView(payment({ channel: { status: 'abandoned', depositAtoms: 2e8, paidAtoms: 0 } }), wallet).refund)
    const pending = channelView(payment({ channel: { status: 'accepted', depositAtoms: 2e8, paidAtoms: 0 } }), { ...wallet, pending: true })
    assert.ok(pending.canOpen && !pending.live)
    assert.ok(channelView(payment({ channel: { status: 'closed', depositAtoms: 2e8, paidAtoms: 1e7 } }), wallet).canOpen)
  }
  assert.equal(rqt(123_000_000), '1.23')
})
