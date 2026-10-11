import json
import os
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest import mock

import channels
from server import AccessStore, AccessError

PUBKEY = 'ab' * 32
PAY_TO = 'trq1q64k873ph3ngupg63e70cv5e276nk43ry23742j8clmm6m5wsn99qnqa0ak'
PRICE = 1_440_000  # 1000 atoms a minute
FUNDING = 'cd' * 32


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


class FakeWallet:
    """Stands in for requant-wallet: `paid` per state hex, failures on demand."""

    def __init__(self):
        self.paid = {}
        self.funded = True
        self.closed = []
        self.refuse = None

    def __call__(self, argv, cwd, **_):
        args = argv[1:argv.index('--network')]
        out, code, err = '', 0, ''
        if self.refuse:
            return SimpleNamespace(returncode=1, stdout='', stderr='requant-wallet: ' + self.refuse)
        if args[0] == 'address':
            out = f'address  {PAY_TO}\nkey hash {"00" * 32}\npubkey   {PUBKEY}\n'
        elif args[:2] == ['channel', 'accept']:
            path = os.path.join(cwd, 'ch.json')
            ch = json.loads(read(path))
            ch['accepted'] = True
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(ch, f)
        elif args[:2] == ['channel', 'receive']:
            state = read(os.path.join(cwd, 's.hex'))
            if state not in self.paid:
                return SimpleNamespace(returncode=1, stdout='', stderr='requant-wallet: not a state of this channel')
            out = json.dumps({'paid': self.paid[state], 'funded': self.funded, 'confirmed': True, 'closed': False,
                              'blocks_left': self.blocks_left})
        elif args[:2] == ['channel', 'close']:
            self.closed.append(read(os.path.join(cwd, 's.hex')))
            out = 'sent, txid ' + 'ef' * 32
        return SimpleNamespace(returncode=code, stdout=out, stderr=err)

    blocks_left = 1000


def channel_file(deposit=500_000_000, expiry=3000):
    return {'requant_channel': 1, 'network': 'test', 'server': PUBKEY, 'server_to': PAY_TO, 'deposit': deposit,
            'expiry': expiry, 'funding_txid': FUNDING, 'vout': 1}


class ChannelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        deposits = self.temp.name + '/deposits.txt'
        with open(deposits, 'w') as f:
            f.write(PAY_TO + '\n')
        self.config = {'secret': 'a' * 64, 'nodes': [{'id': 'fi', 'country': 'FI', 'endpoint': {'t': 'hy2', 'port': 1}, 'fullEndpoint': {'t': 'hy2', 'port': 2}}],
                       'dailyBytes': 1000, 'codeLifetimeDays': 7,
                       'payments': {'enabled': True, 'api': 'http://127.0.0.1:1', 'depositList': deposits, 'priceAtomsPerDay': PRICE,
                                    'confirmations': 6,
                                    'channels': {'enabled': True, 'publicApi': 'http://127.0.0.1:2', 'wallet': 'requant-wallet', 'key': '/k', 'minDepositAtoms': 100_000_000}}}
        self.wallet = FakeWallet()
        self.store = AccessStore(self.temp.name + '/state.sqlite', self.config, runner=self.wallet)
        self.store.report('fi', {'traffic': {}, 'online': {}, 'epoch': 'test'})
        self.code = self.store.issue('203.0.113.5')['code']
        self.patches = [mock.patch.object(channels, 'height', return_value=2000),
                        mock.patch.object(channels, 'confirmations', return_value=6)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.store.db.close()
        self.temp.cleanup()

    def test_settings_and_what_clients_are_told(self):
        info = self.store.info()['payments']['channels']
        self.assertEqual(info['serverPubkey'], PUBKEY)
        self.assertEqual(info['payTo'], PAY_TO)
        self.assertEqual(info['priceAtomsPerMinute'], 1000)
        for bad in ({'minBlocks': 10}, {'closeMarginBlocks': 5000}, {'wallet': None}):
            config = json.loads(json.dumps(self.config))
            config['payments']['channels'].update(bad)
            with self.assertRaises(ValueError):
                channels.settings(config, self.store.payments)
        off = json.loads(json.dumps(self.config))
        off['payments']['channels']['enabled'] = False
        self.assertIsNone(channels.settings(off, self.store.payments))

    def test_open_pay_by_the_minute_and_close(self):
        now = 1_000_000
        opened = self.store.channel_open(self.code, channel_file(), now)
        self.assertTrue(opened['channel']['accepted'])
        self.assertEqual(opened['status']['status'], 'accepted')
        # a second channel is refused while this one is funded
        with self.assertRaises(AccessError):
            self.store.channel_open(self.code, channel_file() | {'funding_txid': 'aa' * 32}, now)
        # 10 minutes paid, then 25 in total: 15 more; a repeat or an older state credits nothing
        self.wallet.paid = {'aa': 10_500, 'bb': 25_000, 'cc': 9_000}
        r = self.store.channel_pay(self.code, 'aa', now)
        self.assertEqual((r['tier'], r['paidUntil']), ('full', now + 600))
        self.assertEqual(r['channel']['creditedAtoms'], 10_000)
        r = self.store.channel_pay(self.code, 'bb', now)
        self.assertEqual(r['paidUntil'], now + 1500)
        self.assertEqual(self.store.channel_pay(self.code, 'cc', now)['paidUntil'], now + 1500)
        self.assertEqual(self.store.channel_pay(self.code, 'bb', now)['paidUntil'], now + 1500)
        # the profile gives the full tier; the payment view shows the channel
        self.assertEqual(self.store.payment(self.code, now)['channel']['paidAtoms'], 25_000)
        self.assertEqual(self.store.payment(self.code, now)['channels']['height'], 2000)
        # the client closes: the last state is countersigned and sent
        closed = self.store.channel_close(self.code, now)
        self.assertEqual(closed['channel']['status'], 'closed')
        self.assertEqual(self.wallet.closed, ['bb'])
        with self.assertRaises(AccessError):
            self.store.channel_pay(self.code, 'bb', now)

    def test_a_device_on_the_full_listener_is_dropped_when_paid_time_ends(self):
        self.store.channel_open(self.code, channel_file(), 1_000_000)
        self.wallet.paid = {'aa': 2_000}
        now = time.time()
        self.store.channel_pay(self.code, 'aa', now)
        profile = self.store.profile(self.code, 'd' * 64)
        device = self.store.db.execute('SELECT id FROM devices').fetchone()[0]
        self.assertEqual(profile['tier'], 'full')
        report = {'traffic': {}, 'online': {device: 1}, 'epoch': 'test', 'fullOnline': [device]}
        self.assertEqual(self.store.report('fi', report)['kick'], [])
        # two minutes later the paid time is over: off the full listener, still fine on the free one
        with mock.patch.object(time, 'time', return_value=now + 121):
            self.assertEqual(self.store.report('fi', report)['kick'], [device])
            self.assertEqual(self.store.report('fi', report | {'fullOnline': []})['kick'], [])

    def test_unconfirmed_expiring_or_forged_states_buy_nothing(self):
        now = 1_000_000
        self.store.channel_open(self.code, channel_file(), now)
        self.wallet.paid = {'aa': 60_000}
        with mock.patch.object(channels, 'confirmations', return_value=2):
            with self.assertRaises(AccessError) as e:
                self.store.channel_pay(self.code, 'aa', now)
            self.assertIn('2 of 6', e.exception.message)
        self.wallet.funded = False
        with self.assertRaises(AccessError):
            self.store.channel_pay(self.code, 'aa', now)
        self.wallet.funded = True
        self.wallet.blocks_left = 50
        with self.assertRaises(AccessError):
            self.store.channel_pay(self.code, 'aa', now)
        self.wallet.blocks_left = 1000
        with self.assertRaises(AccessError):
            self.store.channel_pay(self.code, 'zz', now)
        with self.assertRaises(AccessError):
            self.store.channel_pay(self.code, 'not hex', now)
        self.assertEqual(self.store.payment(self.code, now)['tier'], 'free')

    def test_refused_channels(self):
        now = 1_000_000
        with self.assertRaises(AccessError):
            self.store.channel_open(self.code, channel_file(deposit=1000), now)
        with self.assertRaises(AccessError):
            self.store.channel_open(self.code, channel_file(expiry=2000 + 30000), now)
        with self.assertRaises(AccessError):
            self.store.channel_open(self.code, channel_file() | {'server': 'ee' * 32}, now)
        self.wallet.refuse = 'the refund is not the deposit back to the client from the expiry'
        with self.assertRaises(AccessError) as e:
            self.store.channel_open(self.code, channel_file(), now)
        self.assertIn('refund', e.exception.message)

    def test_the_service_closes_before_the_expiry(self):
        now = 1_000_000
        self.store.channel_open(self.code, channel_file(expiry=3000), now)
        self.wallet.paid = {'aa': 30_000}
        self.store.channel_pay(self.code, 'aa', now)
        self.assertEqual(self.store.close_due(2000), 0)
        self.assertEqual(self.store.close_due(2900), 1)
        self.assertEqual(self.wallet.closed, ['aa'])
        # an accepted channel never funded is dropped at its expiry
        other = self.store.issue('198.51.100.7')['code']
        self.store.channel_open(other, channel_file() | {'funding_txid': 'ab' * 32}, now)
        self.store.close_due(3000)
        self.assertEqual(self.store.payment(other, now)['channel']['status'], 'expired')


if __name__ == '__main__':
    unittest.main()
