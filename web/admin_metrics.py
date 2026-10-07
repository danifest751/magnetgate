"""Optional aggregate request telemetry. Never receives bodies, headers or identities."""
import json
import queue
import sqlite3
import threading
import time

BOUNDS = (25, 50, 100, 250, 500, 1000, 3000, 10000)
ROUTES = {'/api/info', '/api/access', '/api/profile', '/api/revoke', '/api/node-auth', '/api/node-report'}
REASONS = {'ok', 'denied', 'no_capacity', 'daily_limit', 'network_limit', 'device_limit',
           'rate_limit', 'challenge', 'invalid', 'internal', 'http_error'}
SCHEMA = '''CREATE TABLE IF NOT EXISTS requests(
 minute INTEGER, route TEXT, status INTEGER, reason TEXT, count INTEGER,
 total_ms REAL, histogram TEXT, PRIMARY KEY(minute,route,status,reason));'''


class RequestMetrics:
    def __init__(self, path):
        self.path = path
        self.queue = queue.Queue(maxsize=2048)
        self.closed = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def record(self, route, status, reason, elapsed_ms):
        if self.closed.is_set():
            return
        event = (int(time.time() // 60) * 60, route if route in ROUTES else 'other',
                 int(status), reason if reason in REASONS else 'http_error',
                 max(0, min(float(elapsed_ms), 60000)))
        try:
            self.queue.put_nowait(event)
        except queue.Full:
            pass  # Telemetry must never block authentication or issuance.

    def run(self):
        while not self.closed.is_set() or not self.queue.empty():
            batch = []
            try:
                batch.append(self.queue.get(timeout=.5))
                while len(batch) < 256:
                    batch.append(self.queue.get_nowait())
            except queue.Empty:
                pass
            if not batch:
                continue
            try:
                with sqlite3.connect(self.path, timeout=1) as db:
                    db.execute('PRAGMA journal_mode=WAL')
                    db.executescript(SCHEMA)
                    groups = {}
                    for minute, route, status, reason, elapsed in batch:
                        key = (minute, route, status, reason)
                        item = groups.setdefault(key, [0, 0.0, [0] * (len(BOUNDS) + 1)])
                        item[0] += 1
                        item[1] += elapsed
                        bucket = next((i for i, bound in enumerate(BOUNDS) if elapsed <= bound), len(BOUNDS))
                        item[2][bucket] += 1
                    for key, (count, total, histogram) in groups.items():
                        old = db.execute('SELECT count,total_ms,histogram FROM requests WHERE minute=? AND route=? AND status=? AND reason=?', key).fetchone()
                        if old:
                            count += old[0]
                            total += old[1]
                            histogram = [a + b for a, b in zip(histogram, json.loads(old[2]))]
                        db.execute('INSERT OR REPLACE INTO requests VALUES(?,?,?,?,?,?,?)', (*key, count, total, json.dumps(histogram)))
            except (sqlite3.Error, OSError):
                pass  # No raw exception/config/payload goes into public logs.
            finally:
                for _ in batch:
                    self.queue.task_done()

    def close(self):
        self.closed.set()
        self.thread.join(timeout=3)
