"""Read-only access to the public database; isolated aggregate analytics history."""
import hashlib
import json
import math
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from admin_metrics import BOUNDS, SCHEMA, ROUTES, REASONS


def day_of(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).strftime('%Y-%m-%d')


def date_range(start, end):
    a, b = datetime.strptime(start, '%Y-%m-%d'), datetime.strptime(end, '%Y-%m-%d')
    if a.strftime('%Y-%m-%d') != start or b.strftime('%Y-%m-%d') != end or a > b or (b - a).days > 30:
        raise ValueError('range must be between 1 and 31 UTC days')
    return a.replace(tzinfo=timezone.utc).timestamp(), (b + timedelta(days=1)).replace(tzinfo=timezone.utc).timestamp()


class AdminStore:
    def __init__(self, config, history, clock=time.time):
        self.clock, self.config = clock, config
        self.source = Path(config['database']).resolve()
        self.history = Path(history).resolve()
        if self.source == self.history:
            raise ValueError('analytics must use a separate database')
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.history, timeout=2, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript(SCHEMA + '''
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
          CREATE TABLE IF NOT EXISTS days(day TEXT PRIMARY KEY,issued INTEGER,bytes INTEGER);
          CREATE TABLE IF NOT EXISTS traffic_samples(hour INTEGER,node TEXT,bytes INTEGER,PRIMARY KEY(hour,node));
          CREATE TABLE IF NOT EXISTS counters(id TEXT PRIMARY KEY,epoch TEXT,total INTEGER);
          CREATE TABLE IF NOT EXISTS presence(minute INTEGER,node TEXT,online INTEGER,fresh INTEGER,PRIMARY KEY(minute,node));
          CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,ts INTEGER,kind TEXT,node TEXT);
          CREATE INDEX IF NOT EXISTS event_time ON events(ts);
        ''')
        self.snapshot = None
        self.last_success = 0
        self.available = False
        self.initialized = bool(self.db.execute("SELECT 1 FROM meta WHERE key='started'").fetchone())
        self.previous_nodes = {}
        self.db.commit()

    def read_source(self):
        # Explicit projections: never SELECT *, credentials or network hashes.
        with closing(sqlite3.connect(self.source.as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
            db.row_factory = sqlite3.Row
            db.execute('BEGIN')
            snapshot = {
                'accounts': [dict(r) for r in db.execute('SELECT id,expires,revoked FROM accounts ORDER BY id LIMIT 10001')],
                'devices': [dict(r) for r in db.execute('SELECT id,account FROM devices LIMIT 20001')],
                'usage': [dict(r) for r in db.execute('SELECT day,account,bytes FROM usage LIMIT 20001')],
                'nodes': [dict(r) for r in db.execute('SELECT id,seen,online FROM nodes LIMIT 1001')],
                'traffic': [dict(r) for r in db.execute('SELECT node,device,epoch,total FROM traffic LIMIT 50001')],
                'issues': [dict(r) for r in db.execute('SELECT day,sum(count) AS count FROM issues GROUP BY day')]
            }
            if len(snapshot['accounts']) > 10000 or len(snapshot['devices']) > 20000 or len(snapshot['nodes']) > 1000 or len(snapshot['traffic']) > 50000 or len(snapshot['usage']) > 20000:
                raise ValueError('source exceeds analytics capacity')
            return snapshot

    def collect(self):
        now = int(self.clock())
        try:
            source = self.read_source()
        except (sqlite3.Error, OSError, ValueError):
            with self.lock:
                if self.available:
                    self.db.execute("INSERT INTO events(ts,kind,node) VALUES(?,'source_unavailable','')", (now,))
                    self.db.commit()
                self.available = False
            return False
        with self.lock, self.db:
            recovering = self.last_success > 0 and not self.available
            if recovering:
                self.db.execute("INSERT INTO events(ts,kind,node) VALUES(?,'source_recovered','')", (now,))
            issued = {r['day']: r['count'] for r in source['issues']}
            used = {}
            for row in source['usage']:
                used[row['day']] = used.get(row['day'], 0) + row['bytes']
            for day in set(issued) | set(used) | {day_of(now)}:
                self.db.execute('INSERT INTO days VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET issued=max(issued,excluded.issued),bytes=max(bytes,excluded.bytes)', (day, issued.get(day, 0), used.get(day, 0)))
            active_counter_ids = set()
            for row in source['traffic']:
                identity = hashlib.sha256((row['node'] + ':' + row['device']).encode()).hexdigest()
                active_counter_ids.add(identity)
                before = self.db.execute('SELECT epoch,total FROM counters WHERE id=?', (identity,)).fetchone()
                delta = 0
                if self.initialized:
                    if before and before['epoch'] == row['epoch']:
                        delta = max(0, row['total'] - before['total'])
                    else:
                        delta = row['total']
                total = max(row['total'], before['total']) if before and before['epoch'] == row['epoch'] else row['total']
                self.db.execute('INSERT OR REPLACE INTO counters VALUES(?,?,?)', (identity, row['epoch'], total))
                if delta:
                    self.db.execute('INSERT INTO traffic_samples VALUES(?,?,?) ON CONFLICT(hour,node) DO UPDATE SET bytes=bytes+excluded.bytes', (now // 3600 * 3600, row['node'], delta))
            for row in self.db.execute('SELECT id FROM counters').fetchall():
                if row['id'] not in active_counter_ids:
                    self.db.execute('DELETE FROM counters WHERE id=?', (row['id'],))
            for node in self.nodes(source, now):
                fresh = node['fresh']
                previous = self.previous_nodes.get(node['id'])
                if previous is not None and previous != fresh:
                    self.db.execute('INSERT INTO events(ts,kind,node) VALUES(?,?,?)', (now, 'heartbeat_recovered' if fresh else 'heartbeat_stale', node['id']))
                self.previous_nodes[node['id']] = fresh
                self.db.execute('INSERT OR REPLACE INTO presence VALUES(?,?,?,?)', (now // 60 * 60, node['id'], node['connections'] or 0, int(fresh)))
            self.db.execute("INSERT OR IGNORE INTO meta VALUES('started',?)", (str(now),))
            self.db.execute('DELETE FROM requests WHERE minute<?', (now - 31 * 86400,))
            self.db.execute('DELETE FROM presence WHERE minute<?', (now - 31 * 86400,))
            self.db.execute('DELETE FROM traffic_samples WHERE hour<?', (now - 31 * 86400,))
            self.db.execute('DELETE FROM events WHERE ts<?', (now - 31 * 86400,))
            self.db.execute('DELETE FROM days WHERE day<?', (day_of(now - 31 * 86400),))
            self.snapshot, self.last_success, self.available, self.initialized = source, now, True, True
            return True

    def nodes(self, source=None, now=None):
        source = source if source is not None else self.snapshot
        now = self.clock() if now is None else now
        observed = {row['id']: row for row in source['nodes']}
        configured = {str(row['id']): row for row in self.config.get('nodes', [])}
        result = []
        capacity = int(self.config.get('nodeConnections', 10))
        for identity in sorted(set(observed) | set(configured)):
            row = observed.get(identity)
            age = max(0, int(now - row['seen'])) if row else None
            fresh = bool(row and row['seen'] <= now + 5 and age < 20)
            online = row['online'] if fresh else None
            country = str(configured.get(identity, {}).get('country', ''))
            result.append({'id': identity, 'country': country if len(country) == 2 and country.isalpha() else '',
                           'fresh': fresh, 'seen': row['seen'] if row else None, 'age': age,
                           'connections': online, 'capacity': capacity,
                           'free': max(0, capacity - online) if online is not None else None,
                           'resources': None, 'probes': None})
        return result

    def accounts(self, now):
        devices, used = {}, {}
        for row in self.snapshot['devices']:
            devices[row['account']] = devices.get(row['account'], 0) + 1
        for row in self.snapshot['usage']:
            if row['day'] == day_of(now):
                used[row['account']] = row['bytes']
        quota = int(self.config.get('dailyBytes', 5 * 2**30))
        rows = []
        for row in self.snapshot['accounts']:
            count, traffic = devices.get(row['id'], 0), used.get(row['id'], 0)
            status = ('revoked' if row['revoked'] else 'expired' if row['expires'] <= now else
                      'quota' if traffic >= quota else 'unused' if count == 0 else 'active')
            rows.append({'id': row['id'], 'status': status, 'expires': row['expires'],
                         'devices': count, 'deviceLimit': 2, 'bytesToday': traffic, 'dailyLimit': quota,
                         'valid': not row['revoked'] and row['expires'] > now})
        return rows

    def query(self, section, params):
        now = int(self.clock())
        start = params.get('from', day_of(now - 6 * 86400))
        end = params.get('to', day_of(now))
        lower, upper = date_range(start, end)
        node = params.get('node', '')
        with self.lock:
            if self.snapshot is None:
                raise RuntimeError('source unavailable')
            if now - self.last_success > 30:
                raise RuntimeError('source snapshot stale')
            source = {'collectedAt': self.last_success, 'healthy': self.available,
                      'historyStarted': int(self.db.execute("SELECT value FROM meta WHERE key='started'").fetchone()[0]),
                      'timezone': 'UTC', 'scope': 'public_hysteria2', 'readOnly': True,
                      'requestTelemetry': bool(self.config.get('analyticsDatabase'))}
            nodes = self.nodes(now=now)
            if node and node not in {n['id'] for n in nodes}:
                raise ValueError('unknown node')
            page, limit = int(params.get('page', '1')), int(params.get('limit', '50'))
            if page < 1 or not 1 <= limit <= 100:
                raise ValueError('invalid pagination')
            clause, values = 'minute>=? AND minute<?', [lower, upper]
            if node:
                clause += ' AND node=?'
                values.append(node)
            accounts = self.accounts(now)
            limits = {'issued': int(self.config.get('dailyAccounts', 20)), 'accounts': int(self.config.get('maxAccounts', 100)), 'traffic': int(self.config.get('totalDailyBytes', 100 * 2**30))}
            if section == 'overview':
                day = self.db.execute('SELECT * FROM days WHERE day=?', (day_of(now),)).fetchone()
                return {'source': source, 'limits': limits, 'issuedToday': day['issued'] if day else 0,
                        'bytesToday': day['bytes'] if day else 0, 'validAccounts': sum(a['valid'] for a in accounts),
                        'registeredDevices': len(self.snapshot['devices']), 'connections': sum(n['connections'] or 0 for n in nodes),
                        'freshNodes': sum(n['fresh'] for n in nodes), 'totalNodes': len(nodes),
                        'freeConnections': sum(n['free'] or 0 for n in nodes), 'nodes': nodes,
                        'issuanceAvailable': any(n['fresh'] and n['free'] > 0 for n in nodes) and sum(a['valid'] for a in accounts) < limits['accounts'] and (day['issued'] if day else 0) < limits['issued'],
                        'days': [dict(r) for r in self.db.execute('SELECT * FROM days WHERE day BETWEEN ? AND ? ORDER BY day', (start, end))]}
            if section == 'access':
                search = params.get('search', '').lower()[:64]
                status = params.get('status', '')
                if status and status not in {'active', 'unused', 'expired', 'revoked', 'quota', 'valid'}:
                    raise ValueError('invalid status')
                rows = [a for a in accounts if (not search or search in a['id'].lower()) and (not status or (a['valid'] if status == 'valid' else a['status'] == status))]
                page, limit = int(params.get('page', '1')), int(params.get('limit', '50'))
                if page < 1 or not 1 <= limit <= 100:
                    raise ValueError('invalid pagination')
                return {'source': source, 'rows': rows[(page - 1) * limit:page * limit], 'total': len(rows), 'page': page, 'limit': limit, 'historicalDetail': False}
            if section == 'nodes':
                presence = self.db.execute('SELECT minute,node,online,fresh FROM presence WHERE ' + clause + ' ORDER BY minute DESC,node LIMIT ? OFFSET ?', [*values, limit, (page - 1) * limit]).fetchall()
                total = self.db.execute('SELECT count(*) FROM presence WHERE ' + clause, values).fetchone()[0]
                return {'source': source, 'rows': [n for n in nodes if not node or n['id'] == node], 'presence': [dict(r) for r in presence], 'total': total, 'page': page, 'limit': limit}
            if section == 'traffic':
                clause = clause.replace('minute', 'hour')
                rows = [dict(r) for r in self.db.execute('SELECT hour,node,bytes FROM traffic_samples WHERE ' + clause + ' ORDER BY hour DESC,node LIMIT ? OFFSET ?', [*values, limit, (page - 1) * limit])]
                totals = self.db.execute('SELECT count(*),coalesce(sum(bytes),0) FROM traffic_samples WHERE ' + clause, values).fetchone()
                return {'source': source, 'rows': rows, 'total': totals[1], 'rowCount': totals[0], 'page': page, 'limit': limit, 'days': [dict(r) for r in self.db.execute('SELECT * FROM days WHERE day BETWEEN ? AND ? ORDER BY day', (start, end))], 'from': start, 'to': end}
            if section == 'requests':
                route, reason = params.get('route', ''), params.get('reason', '')
                if route and route not in ROUTES | {'other'} or reason and reason not in REASONS:
                    raise ValueError('invalid request filter')
                clause, values = 'minute>=? AND minute<?', [lower, upper]
                for key, value in [('route', route), ('reason', reason)]:
                    if value:
                        clause += ' AND ' + key + '=?'
                        values.append(value)
                page, limit = int(params.get('page', '1')), int(params.get('limit', '50'))
                if page < 1 or not 1 <= limit <= 100:
                    raise ValueError('invalid pagination')
                histogram = [0] * (len(BOUNDS) + 1)
                for row in self.db.execute('SELECT histogram FROM requests WHERE ' + clause, values):
                    histogram = [a + b for a, b in zip(histogram, json.loads(row[0]))]
                totals = self.db.execute("SELECT count(*),coalesce(sum(count),0),coalesce(sum(CASE WHEN reason!='ok' THEN count ELSE 0 END),0) FROM requests WHERE " + clause, values).fetchone()
                count = totals[1]
                rows = [dict(r) for r in self.db.execute('SELECT minute,route,status,reason,count,total_ms FROM requests WHERE ' + clause + ' ORDER BY minute DESC,route,status,reason LIMIT ? OFFSET ?', [*values, limit, (page - 1) * limit])]
                cumulative, p95 = 0, None
                for i, n in enumerate(histogram):
                    cumulative += n
                    if count and cumulative >= math.ceil(count * .95):
                        p95 = BOUNDS[i] if i < len(BOUNDS) else 60000
                        break
                return {'source': source, 'rows': rows, 'count': count, 'errors': totals[2], 'p95UpperMs': p95, 'total': totals[0], 'page': page, 'limit': limit}
            if section == 'events':
                clause = clause.replace('minute', 'ts')
                rows = self.db.execute('SELECT ts,kind,node FROM events WHERE ' + clause + ' ORDER BY ts DESC,id DESC LIMIT ? OFFSET ?', [*values, limit, (page - 1) * limit]).fetchall()
                total = self.db.execute('SELECT count(*) FROM events WHERE ' + clause, values).fetchone()[0]
                return {'source': source, 'rows': [dict(r) for r in rows], 'total': total, 'page': page, 'limit': limit}
            raise ValueError('unknown section')

    def close(self):
        self.db.close()
