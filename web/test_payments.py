import tempfile
import unittest
import payments
from server import AccessStore, AccessError

# test-network addresses of a throwaway wallet, with their key hashes (checked against requant-wallet)
ADDRESSES = [
    ('trq1q64k873ph3ngupg63e70cv5e276nk43ry23742j8clmm6m5wsn99qnqa0ak', 'd56c7f44378cd1c0a351cf9f86532af6a76ac464547d5548f8fef7add1d0994a'),
    ('trq1q2mtqcylkht0ngmsadhnnsayzsm4z34y5pvtyzvp3af2jwmtahevsf7muj9', '56d60c13f6badf346e1d6de738748286ea28d4940b16413031ea55276d7dbe59'),
]
DAY = 86400
PRICE = 1_000_000


class AddressTests(unittest.TestCase):
    def test_key_hash_of_an_address(self):
        for address, owner in ADDRESSES:
            self.assertEqual(payments.owner_of(address, 'test'), owner)

    def test_damaged_or_foreign_addresses_are_refused(self):
        address = ADDRESSES[0][0]
        for bad in (address[:-1] + ('q' if address[-1] != 'q' else 'p'), address.upper(), 'rq1' + address[4:], address + 'q', '', None):
            with self.assertRaises(ValueError):
                payments.owner_of(bad, 'test')
        with self.assertRaises(ValueError):
            payments.owner_of(address, 'main')


class PriceTests(unittest.TestCase):
    s = {'price': PRICE, 'discounts': [[7, 10], [30, 20], [90, 30]], 'maxDays': 3650}

    def test_discounts_by_days(self):
        self.assertEqual(payments.cost(self.s, 1), PRICE)
        self.assertEqual(payments.cost(self.s, 6), 6 * PRICE)
        self.assertEqual(payments.cost(self.s, 7), 7 * PRICE * 9 // 10)
        self.assertEqual(payments.cost(self.s, 90), 90 * PRICE * 7 // 10)

    def test_most_days_for_an_amount_and_the_rest(self):
        self.assertEqual(payments.days_for(self.s, PRICE - 1), (0, PRICE - 1))
        self.assertEqual(payments.days_for(self.s, PRICE + 5), (1, 5))
        # 26.1 days' price: 29 days at 10% off cost that, but 32 days at 20% off cost less
        self.assertEqual(payments.days_for(self.s, 26_100_000), (32, 26_100_000 - 25_600_000))


class PaymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        deposits = self.temp.name + '/deposits.txt'
        with open(deposits, 'w') as f:
            f.write('\n'.join(a for a, _ in ADDRESSES) + '\n')
        self.config = {'secret': 'a' * 64, 'nodes': [{'id': 'fi', 'country': 'FI', 'endpoint': {'t': 'hy2', 'port': 1}, 'fullEndpoint': {'t': 'hy2', 'port': 2}}],
                       'dailyBytes': 1000, 'codeLifetimeDays': 7,
                       'payments': {'enabled': True, 'api': 'http://127.0.0.1:1', 'depositList': deposits, 'priceAtomsPerDay': PRICE, 'confirmations': 6}}
        self.store = AccessStore(self.temp.name + '/state.sqlite', self.config)
        self.store.report('fi', {'traffic': {}, 'online': {}, 'epoch': 'test'})

    def tearDown(self):
        self.store.db.close()
        self.temp.cleanup()

    def deposit(self, owner, atoms, confirmations, txid='aa' * 32):
        return {'txid': txid, 'owner': owner, 'received': atoms, 'sent': 0, 'confirmations': confirmations, 'height': 100}

    def test_codes_last_the_configured_days(self):
        issued = self.store.issue('198.51.100.4', now=1_000_000)
        self.assertEqual(issued['expires'], 1_000_000 + 7 * DAY)

    def test_info_advertises_payments_only_when_on(self):
        self.assertEqual(self.store.info()['payments']['priceAtomsPerDay'], PRICE)
        plain = AccessStore(self.temp.name + '/plain.sqlite', {**self.config, 'payments': {'enabled': False}})
        try:
            plain.report('fi', {'traffic': {}, 'online': {}, 'epoch': 'test'})
            self.assertNotIn('payments', plain.info())
            code = plain.issue('198.51.100.4')['code']
            with self.assertRaises(AccessError):
                plain.payment(code)
            self.assertNotIn('tier', plain.profile(code, '1' * 64))
        finally:
            plain.db.close()

    def test_one_address_per_account_and_never_reused(self):
        a = self.store.issue('198.51.100.4')['code']
        b = self.store.issue('198.51.100.5')['code']
        first = self.store.payment(a)
        self.assertEqual(first['address'], ADDRESSES[0][0])
        self.assertEqual(self.store.payment(a)['address'], first['address'])
        self.assertEqual(self.store.payment(b)['address'], ADDRESSES[1][0])
        c = self.store.issue('203.0.113.9')['code']
        with self.assertRaises(AccessError):
            self.store.payment(c)

    def test_confirmed_deposit_buys_days_once(self):
        code = self.store.issue('198.51.100.4')['code']
        self.store.payment(code)
        owner = ADDRESSES[0][1]
        password = self.store.profile(code, '1' * 64)['endpoints'][0]['pw']
        self.assertFalse(self.store.authenticate(password, 'full')['ok'])
        # not yet confirmed enough: nothing happens
        self.assertEqual(self.store.credit([self.deposit(owner, 7 * PRICE, 5)]), 0)
        self.assertEqual(self.store.payment(code)['tier'], 'free')
        entries = [self.deposit(owner, 7 * PRICE, 6)]
        self.assertEqual(self.store.credit(entries, now=2_000_000_000), 1)
        self.assertEqual(self.store.credit(entries, now=2_000_000_000), 0)
        state = self.store.payment(code, now=2_000_000_000)
        # 7 days at 10% off: 7 days and 0.7 day's price left
        self.assertEqual(state['paidUntil'], 2_000_000_000 + 7 * DAY)
        self.assertEqual(state['balanceAtoms'], 7 * PRICE - 7 * PRICE * 9 // 10)
        self.assertEqual(state['credits'][0]['days'], 7)
        self.assertEqual(state['expires'], state['paidUntil'] + 7 * DAY)

    def test_paid_days_lift_the_quota_and_open_the_full_listener(self):
        code = self.store.issue('198.51.100.4')['code']
        self.store.payment(code)
        free = self.store.profile(code, '1' * 64)
        self.assertEqual((free['tier'], free['endpoints'][0]['port']), ('free', 1))
        identity = self.store.authenticate(free['endpoints'][0]['pw'])['id']
        heavy = {'traffic': {identity: {'tx': 5000, 'rx': 0}}, 'online': {identity: 1}, 'epoch': 'test'}
        self.assertEqual(self.store.report('fi', heavy)['kick'], [identity])
        self.store.credit([self.deposit(ADDRESSES[0][1], PRICE, 6)])
        full = self.store.profile(code, '1' * 64)
        self.assertEqual((full['tier'], full['endpoints'][0]['port']), ('full', 2))
        self.assertTrue(self.store.authenticate(full['endpoints'][0]['pw'], 'full')['ok'])
        self.assertEqual(self.store.report('fi', heavy)['kick'], [])
        self.assertFalse(self.store.authenticate(full['endpoints'][0]['pw'], 'other')['ok'])

    def test_small_deposits_add_up(self):
        code = self.store.issue('198.51.100.4')['code']
        self.store.payment(code)
        owner = ADDRESSES[0][1]
        self.store.credit([self.deposit(owner, PRICE // 2, 6, 'aa' * 32)])
        self.assertEqual(self.store.payment(code)['tier'], 'free')
        self.store.credit([self.deposit(owner, PRICE // 2, 6, 'bb' * 32)])
        state = self.store.payment(code)
        self.assertEqual((state['tier'], state['balanceAtoms']), ('full', 0))

    def test_unknown_owners_and_malformed_entries_are_ignored(self):
        code = self.store.issue('198.51.100.4')['code']
        self.store.payment(code)
        entries = [self.deposit('00' * 32, PRICE, 6), self.deposit(ADDRESSES[1][1], PRICE, 6), {'received': 'x'}, None,
                   {**self.deposit(ADDRESSES[0][1], PRICE, 6), 'received': -1}]
        self.assertEqual(self.store.credit(entries), 0)

    def test_poll_watches_assigned_addresses_only(self):
        seen = []
        fetch = lambda s, addresses: seen.append(addresses) or [self.deposit(ADDRESSES[0][1], PRICE, 6)]
        self.assertEqual(self.store.poll_payments(fetch), 0)
        self.assertEqual(seen, [])
        code = self.store.issue('198.51.100.4')['code']
        self.store.payment(code)
        self.assertEqual(self.store.poll_payments(fetch), 1)
        self.assertEqual(seen, [[ADDRESSES[0][0]]])

    def test_a_bad_deposit_list_or_settings_stop_the_service(self):
        with open(self.config['payments']['depositList'], 'a') as f:
            f.write('trq1notanaddress\n')
        with self.assertRaises(ValueError):
            AccessStore(self.temp.name + '/other.sqlite', self.config)
        for bad in ({'priceAtomsPerDay': 0}, {'discounts': [[7, 100]]}, {'network': 'x'}, {'api': 'ftp://x'}):
            with self.assertRaises(ValueError):
                payments.settings({'payments': {**self.config['payments'], **bad}})


if __name__ == '__main__':
    unittest.main()
