"""Local synthetic fixtures only; no live hosts, codes or operational configuration."""
import http.client
import json
import secrets
import sqlite3
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from admin_metrics import RequestMetrics
from admin_server import handler
from admin_store import AdminStore, day_of
from server import AccessStore, handler as public_handler


class AdminTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = int(time.time())
        self.config = {'database': self.temp.name + '/source.sqlite', 'secret': secrets.token_hex(32),
                       'hostname': 'example.test', 'dailyBytes': 1000,
                       'nodes': [{'id': 'test-node', 'country': 'ZZ', 'key': secrets.token_hex(32), 'endpoint': {'t': 'hy2'}}]}
        self.public = AccessStore(self.config['database'], self.config)
        self.public.report('test-node', {'traffic': {}, 'online': {}, 'epoch': 'first'})
        self.code = self.public.issue('198.51.100.4', now=self.now)['code']
        self.password = self.public.profile(self.code, '1' * 64)['endpoints'][0]['pw']
        self.device = self.public.authenticate(self.password)['id']
        self.public.report('test-node', {'traffic': {self.device: {'tx': 70, 'rx': 30}}, 'online': {self.device: 1}, 'epoch': 'first'})
        self.store = AdminStore(self.config, self.temp.name + '/history.sqlite', clock=lambda: self.now)
        self.assertTrue(self.store.collect())

    def tearDown(self):
        self.store.close()
        if self.public.metrics:
            self.public.metrics.close()
        self.public.db.close()
        self.temp.cleanup()

    def query(self, section, **params):
        return self.store.query(section, {'from': day_of(self.now), 'to': day_of(self.now), **params})

    def report(self, total, epoch='first'):
        self.public.report('test-node', {'traffic': {self.device: {'tx': total, 'rx': 0}}, 'online': {self.device: 1}, 'epoch': epoch})
        self.store.collect()

    def test_explicit_projections_and_no_secrets(self):
        before = list(self.public.db.iterdump())
        serialized = json.dumps([self.query(section) for section in ['overview', 'access', 'nodes', 'traffic', 'requests', 'events']])
        private_values = [self.code, self.password, self.config['secret'], self.config['nodes'][0]['key'], '198.51.100.4']
        private_values.extend(row[0] for row in self.public.db.execute('SELECT token FROM accounts UNION SELECT token FROM devices UNION SELECT network FROM issues'))
        for private in private_values:
            self.assertNotIn(private, serialized)
        self.assertEqual(before, list(self.public.db.iterdump()))
        self.assertNotIn('token', self.store.snapshot['accounts'][0])

    def test_bootstrap_baseline_and_idempotence(self):
        self.assertEqual(100, self.query('overview')['bytesToday'])
        self.assertEqual(0, self.query('traffic')['total'])
        self.report(170)
        self.report(170)
        self.assertEqual(70, self.query('traffic')['total'])
        self.report(20, 'restarted')
        self.assertEqual(90, self.query('traffic')['total'])
        self.assertEqual(190, self.query('overview')['bytesToday'])

    def test_counter_baseline_survives_admin_restart(self):
        self.report(150)
        self.store.close()
        self.store = AdminStore(self.config, self.temp.name + '/history.sqlite', clock=lambda: self.now)
        self.store.collect()
        self.assertEqual(50, self.query('traffic')['total'])
        self.report(200)
        self.assertEqual(100, self.query('traffic')['total'])

    def test_heartbeat_is_not_a_probe_and_transitions(self):
        fresh = self.query('nodes')['rows'][0]
        self.assertTrue(fresh['fresh'])
        self.assertIsNone(fresh['probes'])
        self.assertIsNone(fresh['resources'])
        self.now += 21
        self.store.collect()
        node = self.query('nodes')['rows'][0]
        self.assertFalse(node['fresh'])
        self.assertIsNone(node['connections'])
        self.assertEqual('heartbeat_stale', self.query('events')['rows'][0]['kind'])
        self.public.db.execute('UPDATE nodes SET seen=?', (self.now,))
        self.store.collect()
        self.assertIn('heartbeat_recovered', [r['kind'] for r in self.query('events')['rows']])

    def test_source_failure_marks_snapshot_then_expires(self):
        self.store.source = Path(self.temp.name + '/missing.sqlite')
        self.assertFalse(self.store.collect())
        self.assertFalse(self.query('overview')['source']['healthy'])
        self.now += 31
        with self.assertRaises(RuntimeError): self.query('overview')
        self.store.source = Path(self.config['database'])
        self.assertTrue(self.store.collect())
        self.assertTrue(self.query('overview')['source']['healthy'])

    def test_history_survives_public_cleanup(self):
        old_day = day_of(self.now - 86400)
        self.public.db.execute('INSERT INTO usage VALUES(?,?,?)', (old_day, 'archived', 400))
        self.public.db.execute('INSERT INTO issues VALUES(?,?,?)', (old_day, 'fixture-network', 3))
        self.store.collect()
        self.public.db.execute('DELETE FROM usage WHERE day=?', (old_day,))
        self.public.db.execute('DELETE FROM issues WHERE day=?', (old_day,))
        self.store.collect()
        rows = self.store.query('overview', {'from': old_day, 'to': day_of(self.now)})['days']
        self.assertEqual({'day': old_day, 'issued': 3, 'bytes': 400}, rows[0])

    def test_status_search_and_pagination(self):
        account = self.query('access')['rows'][0]
        self.assertEqual('active', account['status'])
        self.assertEqual(0, self.query('access', search='not-an-account')['total'])
        self.assertEqual(1, self.query('access', search=account['id'][:8])['total'])
        self.assertEqual([], self.query('access', page='2', limit='1')['rows'])
        self.public.revoke(self.code)
        self.store.collect()
        self.assertEqual(1, self.query('access', status='revoked')['total'])
        self.assertEqual(0, self.query('access', status='valid')['total'])

    def test_filters_fail_closed(self):
        for params in [{'from': '2026-1-1'}, {'from': '2020-01-01'}, {'page': '0'}, {'limit': '101'}, {'node': "' OR 1=1"}, {'status': 'secret'}]:
            with self.subTest(params=params), self.assertRaises(ValueError): self.query('access', **params)
        with self.assertRaises(ValueError): self.query('requests', route='/private')

    def test_aggregate_totals_are_not_page_totals(self):
        minute = self.now // 86400 * 86400 + 43200
        self.store.db.execute('DELETE FROM presence')
        histogram = json.dumps([0, 2, 0, 0, 0, 0, 0, 0, 0])
        for i in range(80):
            self.store.db.execute('INSERT INTO requests VALUES(?,?,?,?,?,?,?)', (minute - i, '/api/access', 200, 'ok', 2, 60, histogram))
            self.store.db.execute('INSERT INTO events(ts,kind,node) VALUES(?,?,?)', (minute - i, 'heartbeat_stale', 'test-node'))
            self.store.db.execute('INSERT OR REPLACE INTO presence VALUES(?,?,?,?)', (minute - i, 'test-node', 1, 1))
        self.store.db.commit()
        result = self.query('requests', limit='1', page='2', route='/api/access')
        self.assertEqual(160, result['count'])
        self.assertEqual(80, result['total'])
        self.assertEqual(1, len(result['rows']))
        self.assertEqual(50, result['p95UpperMs'])
        self.assertEqual(80, self.query('events', limit='1')['total'])
        self.assertEqual(80, self.query('nodes', limit='1')['total'])

    def test_history_database_cannot_be_public_database(self):
        with self.assertRaises(ValueError): AdminStore(self.config, self.config['database'])

    def test_http_guards_readonly_errors_and_static_paths(self):
        directory = Path(self.temp.name) / 'static'
        directory.mkdir(); (directory / 'index.html').write_text('<h1>Fixture</h1>')
        (directory / '.hidden.html').write_text('must not serve')
        service = ThreadingHTTPServer(('127.0.0.1', 0), handler(self.store, directory))
        thread = threading.Thread(target=service.serve_forever, daemon=True); thread.start()
        def request(path='/admin/api/overview', method='GET', headers=None):
            connection = http.client.HTTPConnection('127.0.0.1', service.server_port, timeout=3)
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse(); body = response.read(); connection.close()
            return response.status, body, dict(response.getheaders())
        try:
            self.assertEqual(200, request()[0])
            self.assertEqual(403, request(headers={'Host': 'example.test', 'X-Forwarded-For': '127.0.0.1'})[0])
            self.assertEqual(403, request(headers={'Origin': 'https://example.test'})[0])
            self.assertEqual(403, request(headers={'Sec-Fetch-Site': 'cross-site'})[0])
            for method in ['POST', 'PUT', 'PATCH', 'DELETE']:
                self.assertEqual(405, request(method=method)[0])
            self.assertEqual(400, request('/admin/api/access?page=-1')[0])
            self.assertEqual(400, request('/admin/api/access?' + '&'.join(f'x{i}=1' for i in range(20)))[0])
            for path in ['/admin/%2e%2e/source.sqlite', '/admin/%2e%2e%2fsource.sqlite', '/admin/.hidden.html', '/admin/missing.js', '/admin/api/settings']:
                self.assertEqual(404, request(path)[0], path)
            status, body, headers = request('/admin/')
            self.assertEqual(200, status)
            self.assertIn('Fixture', body.decode())
            self.assertEqual('no-store', headers['Cache-Control'])
            self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
            self.now += 31
            self.assertEqual(503, request()[0])
        finally:
            service.shutdown(); service.server_close(); thread.join()

    def test_metrics_sanitize_inputs_and_never_block_failed_storage(self):
        metric = RequestMetrics(self.temp.name + '/metrics.sqlite')
        metric.record('/api/access?code=private', 400, 'private-reason', 40)
        metric.record('/api/access', 200, 'ok', 40)
        metric.queue.join(); metric.close()
        with sqlite3.connect(metric.path) as db:
            rows = db.execute('SELECT route,reason,count FROM requests ORDER BY route').fetchall()
        self.assertEqual([('/api/access', 'ok', 1), ('other', 'http_error', 1)], rows)
        broken = RequestMetrics(self.temp.name + '/missing/subdir.sqlite')
        broken.record('/api/access', 200, 'ok', 1)
        broken.queue.join(); broken.close()

    def test_public_http_instrumentation_preserves_response(self):
        self.public.metrics = RequestMetrics(str(self.store.history))
        service = ThreadingHTTPServer(('127.0.0.1', 0), public_handler(self.public, self.config))
        thread = threading.Thread(target=service.serve_forever, daemon=True); thread.start()
        try:
            connection = http.client.HTTPConnection('127.0.0.1', service.server_port)
            connection.request('POST', '/api/profile', body=json.dumps({'code': self.code, 'device': '1' * 64}), headers={'Content-Type': 'application/json'})
            response = connection.getresponse()
            self.assertEqual(200, response.status)
            self.assertEqual(self.password, json.loads(response.read())['endpoints'][0]['pw'])
            connection.close()
            service.shutdown(); thread.join()
            self.public.metrics.queue.join()
            result = self.query('requests')
            self.assertEqual(1, result['count'])
            self.assertNotIn(self.code, json.dumps(result))
            self.assertNotIn(self.password, json.dumps(result))
        finally:
            service.server_close()


if __name__ == '__main__':
    unittest.main()
