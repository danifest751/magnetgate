import tempfile
import time
import unittest
from server import AccessStore, AccessError


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = {'secret': 'a' * 64, 'nodes': [{'id': 'fi', 'country': 'FI', 'endpoint': {'t': 'hy2'}}], 'dailyBytes': 1000}
        self.store = AccessStore(self.temp.name + '/state.sqlite', self.config)
        self.store.report('fi', {'traffic': {}, 'online': {}, 'epoch': 'test'})

    def tearDown(self):
        self.store.db.close()
        self.temp.cleanup()

    def test_separate_codes_and_devices_and_persistence(self):
        code = self.store.issue('198.51.100.4')['code']
        first = self.store.profile(code, '1' * 64)
        self.assertEqual(first, self.store.profile(code, '1' * 64))
        second = self.store.profile(code, '2' * 64)
        self.assertNotEqual(first['endpoints'][0]['pw'], second['endpoints'][0]['pw'])
        with self.assertRaises(AccessError): self.store.profile(code, '3' * 64)
        self.assertNotIn(code, self.store.db.execute('SELECT token FROM accounts').fetchone()[0])
        auth = self.store.authenticate(first['endpoints'][0]['pw'])
        self.assertTrue(auth['ok'])
        reopened = AccessStore(self.temp.name + '/state.sqlite', self.config)
        self.assertTrue(reopened.authenticate(first['endpoints'][0]['pw'])['ok'])
        reopened.db.close()

    def test_registration_limit_shared_by_subnet_and_survives_restart(self):
        self.store.issue('198.51.100.1')
        self.store.issue('198.51.100.2')
        with self.assertRaises(AccessError): self.store.issue('198.51.100.3')
        reopened = AccessStore(self.temp.name + '/state.sqlite', self.config)
        with self.assertRaises(AccessError): reopened.issue('198.51.100.4')
        reopened.db.close()

    def test_revoke_stops_existing_credentials(self):
        code = self.store.issue('198.51.100.4')['code']
        password = self.store.profile(code, '1' * 64)['endpoints'][0]['pw']
        identity = self.store.authenticate(password)['id']
        self.store.revoke(code)
        self.assertFalse(self.store.authenticate(password)['ok'])
        with self.assertRaises(AccessError): self.store.profile(code, '1' * 64)
        self.assertEqual([identity], self.store.report('fi', {'traffic': {}, 'online': {identity: 1}, 'epoch': 'test'})['kick'])

    def test_quota_aggregates_nodes_and_repeated_reports_are_idempotent(self):
        code = self.store.issue('198.51.100.4')['code']
        password = self.store.profile(code, '1' * 64)['endpoints'][0]['pw']
        identity = self.store.authenticate(password)['id']
        report = {'traffic': {identity: {'tx': 400, 'rx': 100}}, 'online': {identity: 1}, 'epoch': 'test'}
        self.store.report('fi', report); self.store.report('fi', report)
        self.assertTrue(self.store.authenticate(password)['ok'])
        self.assertEqual([identity], self.store.report('nl', report)['kick'])
        self.assertFalse(self.store.authenticate(password)['ok'])

    def test_no_nodes_and_malformed_inputs_fail_closed(self):
        self.store.db.execute('DELETE FROM nodes')
        with self.assertRaises(AccessError): self.store.issue('198.51.100.4')
        self.assertFalse(self.store.authenticate(None)['ok'])
        with self.assertRaises(AccessError): self.store.profile('x', '1' * 64)
        with self.assertRaises(AccessError): self.store.report('fi', {'epoch': 'x', 'online': {'x': -1}, 'traffic': {}})

if __name__ == '__main__': unittest.main()
