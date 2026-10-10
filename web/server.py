"""Лендинг и выдача личного доступа. Общий PSK этому процессу не нужен."""
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from admin_metrics import RequestMetrics
import payments


class AccessError(Exception):
    def __init__(self, status, message, reason='http_error'):
        self.status, self.message = status, message
        self.reason = reason


class AccessStore:
    def __init__(self, path, config):
        self.config = config
        self.lock = threading.RLock()
        # payment settings and the whole deposit list are checked before anything is opened
        self.payments = payments.settings(config)
        listed = payments.load_addresses(self.payments) if self.payments else []
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.metrics = RequestMetrics(config['analyticsDatabase']) if config.get('analyticsDatabase') else None
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, token TEXT UNIQUE, expires INTEGER, revoked INTEGER DEFAULT 0);
          CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, account TEXT, token TEXT UNIQUE);
          CREATE TABLE IF NOT EXISTS issues(day TEXT, network TEXT, count INTEGER, PRIMARY KEY(day,network));
          CREATE TABLE IF NOT EXISTS traffic(node TEXT, device TEXT, epoch TEXT, total INTEGER, PRIMARY KEY(node,device));
          CREATE TABLE IF NOT EXISTS usage(day TEXT, account TEXT, bytes INTEGER, PRIMARY KEY(day,account));
          CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, seen INTEGER, online INTEGER);
          -- payments (used only with payments.enabled): an address is handed to one account, never again
          CREATE TABLE IF NOT EXISTS deposits(address TEXT PRIMARY KEY, owner TEXT UNIQUE, account TEXT UNIQUE, assigned INTEGER);
          CREATE TABLE IF NOT EXISTS credits(txid TEXT, address TEXT, account TEXT, atoms INTEGER, days INTEGER, height INTEGER, credited INTEGER, PRIMARY KEY(txid,address));
        ''')
        columns = {r[1] for r in self.db.execute('PRAGMA table_info(accounts)')}
        if 'paid_until' not in columns:
            self.db.execute('ALTER TABLE accounts ADD COLUMN paid_until INTEGER DEFAULT 0')
        if 'balance' not in columns:
            self.db.execute('ALTER TABLE accounts ADD COLUMN balance INTEGER DEFAULT 0')
        self.db.executemany('INSERT OR IGNORE INTO deposits(address,owner) VALUES(?,?)', listed)

    def digest(self, value):
        return hmac.new(self.config['secret'].encode(), value.encode(), hashlib.sha256).hexdigest()

    def transaction(self, fn):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                result = fn()
                self.db.execute('COMMIT')
                return result
            except BaseException:
                self.db.execute('ROLLBACK')
                raise

    def issue(self, ip, now=None):
        now = int(time.time() if now is None else now)
        address = ipaddress.ip_address(ip)
        network = ipaddress.ip_network(f'{address}/{24 if address.version == 4 else 56}', strict=False)
        day = time.strftime('%Y-%m-%d', time.gmtime(now))
        network_hash = self.digest(day + str(network))
        def commit():
            self.db.execute('DELETE FROM issues WHERE day < ?', (day,))
            self.db.execute('DELETE FROM usage WHERE day < ?', (day,))
            # an account with RQT left over is kept: its deposit address may still be paid to
            old = [r[0] for r in self.db.execute('SELECT id FROM accounts WHERE expires < ? AND coalesce(balance,0)=0', (now - 86400,))]
            for account in old:
                self.db.execute('DELETE FROM traffic WHERE device IN (SELECT id FROM devices WHERE account=?)', (account,))
                self.db.execute('DELETE FROM devices WHERE account=?', (account,))
                self.db.execute('DELETE FROM accounts WHERE id=?', (account,))
            count = self.db.execute('SELECT coalesce(sum(count),0) FROM issues WHERE day=?', (day,)).fetchone()[0]
            local = self.db.execute('SELECT count FROM issues WHERE day=? AND network=?', (day, network_hash)).fetchone()
            active = self.db.execute('SELECT count(*) FROM accounts WHERE expires>? AND revoked=0', (now,)).fetchone()[0]
            ready = self.db.execute('SELECT count(*) FROM nodes WHERE seen>? AND online<?', (now - 20, self.config.get('nodeConnections', 10))).fetchone()[0]
            if not ready:
                raise AccessError(503, 'Сейчас нет свободных нод. Попробуйте немного позже.', 'no_capacity')
            if count >= self.config.get('dailyAccounts', 20) or active >= self.config.get('maxAccounts', 100):
                raise AccessError(429, 'На сегодня выдача новых кодов приостановлена. Действующие коды продолжают работать.', 'daily_limit')
            if local and local[0] >= 2:
                raise AccessError(429, 'С этой сети уже получены коды на сегодня. Используйте сохранённый код или вернитесь завтра.', 'network_limit')
            code = 'MG1-' + secrets.token_hex(32)
            expires = now + self.lifetime()
            self.db.execute('INSERT INTO accounts(id,token,expires) VALUES(?,?,?)', (secrets.token_hex(16), self.digest(code), expires))
            self.db.execute('INSERT INTO issues VALUES(?,?,1) ON CONFLICT(day,network) DO UPDATE SET count=count+1', (day, network_hash))
            return {'code': code, 'expires': expires, 'devices': 2}
        return self.transaction(commit)

    def lifetime(self):
        """Seconds a free code lasts (`codeLifetimeDays`, default 30)."""
        days = self.config.get('codeLifetimeDays', 30)
        if type(days) is not int or not 1 <= days <= 365:
            raise ValueError('codeLifetimeDays must be from 1 to 365')
        return days * 86400

    def account(self, code, now):
        if not isinstance(code, str) or len(code) != 68 or not code.startswith('MG1-') or any(c not in '0123456789abcdef' for c in code[4:]):
            raise AccessError(401, 'Проверьте личный код: он начинается с MG1-.')
        row = self.db.execute('SELECT id,expires,revoked FROM accounts WHERE token=?', (self.digest(code),)).fetchone()
        if not row or row[2] or row[1] <= now:
            raise AccessError(401, 'Код не найден, истёк или был отозван. Получите новый код на сайте.')
        return row

    def profile(self, code, device):
        if not isinstance(device, str) or len(device) != 64 or any(c not in '0123456789abcdef' for c in device):
            raise AccessError(400, 'Некорректный идентификатор устройства.')
        def commit():
            now = time.time()
            account, expires, _ = self.account(code, now)
            paid_until = self.db.execute('SELECT coalesce(paid_until,0) FROM accounts WHERE id=?', (account,)).fetchone()[0]
            full = paid_until > now
            identity = self.digest(account + ':' + device)[:32]
            password = self.digest('device:' + identity)
            if not self.db.execute('SELECT 1 FROM devices WHERE id=?', (identity,)).fetchone():
                if self.db.execute('SELECT count(*) FROM devices WHERE account=?', (account,)).fetchone()[0] >= 2:
                    raise AccessError(409, 'Этот код уже используется на двух устройствах.', 'device_limit')
                self.db.execute('INSERT INTO devices VALUES(?,?,?)', (identity, account, self.digest(password)))
            endpoints = []
            for index, node in enumerate(self.config['nodes']):
                # a node may run a separate unthrottled listener for the full tier
                endpoint = node.get('fullEndpoint') if full and node.get('fullEndpoint') else node['endpoint']
                endpoints.append({**endpoint, 'pw': password, 'exitId': str(index), 'node': 'MagnetGate', 'country': node['country']})
            result = {'version': 1, 'expires': expires, 'endpoints': endpoints}
            if self.payments:
                result.update(tier='full' if full else 'free', paidUntil=paid_until)
            return result
        return self.transaction(commit)

    def allowed(self, account, now, listener=None):
        day = time.strftime('%Y-%m-%d', time.gmtime(now))
        row = self.db.execute('SELECT expires,revoked,coalesce(paid_until,0) FROM accounts WHERE id=?', (account,)).fetchone()
        if not row or row[1] or row[0] <= now:
            return False
        if self.payments and row[2] > now:
            # paid days: no daily quota, and the full-tier listener is open
            return True
        if listener == 'full':
            return False
        used = self.db.execute('SELECT coalesce(sum(bytes),0) FROM usage WHERE day=? AND account=?', (day, account)).fetchone()[0]
        total = self.db.execute('SELECT coalesce(sum(bytes),0) FROM usage WHERE day=?', (day,)).fetchone()[0]
        return used < self.config.get('dailyBytes', 5 * 2**30) and total < self.config.get('totalDailyBytes', 100 * 2**30)

    def authenticate(self, password, listener=None):
        if not isinstance(password, str) or len(password) != 64 or listener not in (None, 'free', 'full'):
            return {'ok': False}
        with self.lock:
            row = self.db.execute('SELECT id,account FROM devices WHERE token=?', (self.digest(password),)).fetchone()
            return {'ok': True, 'id': row[0]} if row and self.allowed(row[1], time.time(), listener) else {'ok': False}

    def report(self, node, data):
        now = int(time.time())
        day = time.strftime('%Y-%m-%d', time.gmtime(now))
        traffic, online, epoch = data.get('traffic'), data.get('online'), data.get('epoch')
        if not isinstance(traffic, dict) or not isinstance(online, dict) or len(traffic) > 200 or len(online) > 200 or not isinstance(epoch, str) or len(epoch) > 80:
            raise AccessError(400, 'invalid report')
        def commit():
            for device, counters in traffic.items():
                if not isinstance(counters, dict) or any(type(counters.get(k)) is not int or not 0 <= counters[k] <= 2**53 for k in ('tx', 'rx')):
                    raise AccessError(400, 'invalid counters')
                row = self.db.execute('SELECT account FROM devices WHERE id=?', (device,)).fetchone()
                if not row:
                    continue
                total = counters['tx'] + counters['rx']
                before = self.db.execute('SELECT epoch,total FROM traffic WHERE node=? AND device=?', (node, device)).fetchone()
                delta = total if not before or before[0] != epoch else max(0, total - before[1])
                self.db.execute('INSERT INTO traffic VALUES(?,?,?,?) ON CONFLICT(node,device) DO UPDATE SET epoch=excluded.epoch,total=excluded.total', (node, device, epoch, max(total, before[1]) if before and before[0] == epoch else total))
                self.db.execute('INSERT INTO usage VALUES(?,?,?) ON CONFLICT(day,account) DO UPDATE SET bytes=bytes+excluded.bytes', (day, row[0], delta))
            if any(type(v) is not int or v < 0 or v > 1000 for v in online.values()):
                raise AccessError(400, 'invalid online')
            self.db.execute('INSERT INTO nodes VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET seen=excluded.seen,online=excluded.online', (node, now, sum(online.values())))
            kick = []
            for device, connections in online.items():
                row = self.db.execute('SELECT account FROM devices WHERE id=?', (device,)).fetchone()
                # Two transport sessions may overlap during a device reconnect. Both are billed
                # to the same device/account; registration, device and node capacity limits remain.
                if not row or connections > 2 or not self.allowed(row[0], now):
                    kick.append(device)
            return {'kick': kick}
        return self.transaction(commit)

    def revoke(self, code):
        def commit():
            account, _, _ = self.account(code, time.time())
            self.db.execute('UPDATE accounts SET revoked=1 WHERE id=?', (account,))
            return {'ok': True}
        return self.transaction(commit)

    def info(self):
        with self.lock:
            ready = [r[0] for r in self.db.execute('SELECT id FROM nodes WHERE seen>? AND online<?', (int(time.time()) - 20, self.config.get('nodeConnections', 10)))]
        result = {'sitekey': self.config.get('sitekey', ''), 'available': bool(ready), 'countries': [n['country'] for n in self.config['nodes'] if n['id'] in ready], 'downloads': self.config.get('downloads', {}), 'dailyGiB': self.config.get('dailyBytes', 5 * 2**30) // 2**30}
        if self.payments:
            # only a service that takes payments says so; clients show no payment UI without this field
            result['payments'] = payments.public(self.payments)
        return result

    def payment(self, code, now=None):
        """The account's deposit address (handed out on the first ask), tier, balance and recent deposits."""
        if not self.payments:
            raise AccessError(404, 'This service does not take payments.', 'payments_off')
        now = int(time.time() if now is None else now)
        def commit():
            account, expires, _ = self.account(code, now)
            row = self.db.execute('SELECT address FROM deposits WHERE account=?', (account,)).fetchone()
            if not row:
                row = self.db.execute('SELECT address FROM deposits WHERE account IS NULL ORDER BY rowid LIMIT 1').fetchone()
                if not row:
                    raise AccessError(503, 'No deposit addresses are left. Please try again later.', 'no_addresses')
                self.db.execute('UPDATE deposits SET account=?, assigned=? WHERE address=?', (account, now, row[0]))
            paid_until, balance = self.db.execute('SELECT coalesce(paid_until,0),coalesce(balance,0) FROM accounts WHERE id=?', (account,)).fetchone()
            credits = [{'txid': r[0], 'atoms': r[1], 'days': r[2], 'height': r[3]} for r in self.db.execute(
                'SELECT txid,atoms,days,height FROM credits WHERE account=? ORDER BY credited DESC LIMIT 20', (account,))]
            return {**payments.public(self.payments), 'address': row[0], 'tier': 'full' if paid_until > now else 'free',
                    'paidUntil': paid_until, 'expires': expires, 'balanceAtoms': balance, 'credits': credits}
        return self.transaction(commit)

    def watched(self):
        """Deposit addresses to watch: those handed to an account that still exists."""
        with self.lock:
            return [r[0] for r in self.db.execute('SELECT d.address FROM deposits d JOIN accounts a ON a.id=d.account ORDER BY d.address')]

    def credit(self, entries, now=None):
        """Credit confirmed deposits from node history `entries` (each naming its `owner` key hash).
        Each (txid, address) counts once, so the same history can be fed again; deposits still short of
        the confirmations wait for a later poll. Returns the number of new credits."""
        now = int(time.time() if now is None else now)
        need = self.payments['confirmations']
        def commit():
            fresh = 0
            for e in entries:
                if not isinstance(e, dict) or type(e.get('received')) is not int or e['received'] <= 0:
                    continue
                if type(e.get('confirmations')) is not int or e['confirmations'] < need or not isinstance(e.get('txid'), str):
                    continue
                row = self.db.execute('SELECT address,account FROM deposits WHERE owner=?', (e.get('owner'),)).fetchone()
                if not row or not row[1]:
                    continue
                address, account = row
                if self.db.execute('SELECT 1 FROM credits WHERE txid=? AND address=?', (e['txid'], address)).fetchone():
                    continue
                current = self.db.execute('SELECT coalesce(paid_until,0),coalesce(balance,0),expires FROM accounts WHERE id=?', (account,)).fetchone()
                days = 0
                if current:
                    paid_until, balance, expires = current
                    days, left = payments.days_for(self.payments, balance + e['received'])
                    paid_until = max(paid_until, now) + days * payments.DAY if days else paid_until
                    # the code outlives the paid days by a free period, to top up with the same code
                    expires = max(expires, paid_until + self.lifetime())
                    self.db.execute('UPDATE accounts SET paid_until=?, balance=?, expires=? WHERE id=?', (paid_until, left, expires, account))
                # recorded even when the account is gone, so the operator can see and refund it
                self.db.execute('INSERT INTO credits VALUES(?,?,?,?,?,?,?)', (e['txid'], address, account, e['received'], days, e.get('height'), now))
                fresh += 1
            return fresh
        return self.transaction(commit)

    def poll_payments(self, fetch=payments.fetch_history):
        addresses = self.watched()
        return self.credit(fetch(self.payments, addresses)) if addresses else 0


def watch_payments(store):
    """Poll the node for deposits forever (a daemon thread); failures wait for the next round."""
    while True:
        try:
            store.poll_payments()
        except Exception as error:
            # no addresses, amounts or response bodies in the log
            print('payments poll failed: ' + type(error).__name__, flush=True)
        time.sleep(store.payments['pollSeconds'])


def verify_turnstile(config, token, ip):
    if not isinstance(token, str) or not 10 <= len(token) <= 2048:
        return False
    payload = urllib.parse.urlencode({'secret': config['turnstileSecret'], 'response': token, 'remoteip': ip}).encode()
    request = urllib.request.Request('https://challenges.cloudflare.com/turnstile/v0/siteverify', data=payload, headers={'User-Agent': 'MagnetGate-Access/1.0'})
    with urllib.request.urlopen(request, timeout=8) as reply:
        result = json.loads(reply.read(8192))
    return result.get('success') is True and result.get('hostname') == config['hostname'] and result.get('action') == 'access'


def handler(store, config):
    limiter, limiter_lock = {}, threading.Lock()
    class Handler(BaseHTTPRequestHandler):
        server_version = 'MagnetGate'
        def log_message(self, *_):
            pass

        def reply(self, status, data):
            body = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            if store.metrics:
                reason = getattr(self, 'metric_reason', None) or ('denied' if data.get('ok') is False else 'ok' if status < 400 else 'http_error')
                elapsed = (time.monotonic() - getattr(self, 'request_started', time.monotonic())) * 1000
                store.metrics.record(self.path, status, reason, elapsed)

        def limited(self, ip):
            bucket = int(time.time() // 60)
            key = (bucket, store.digest(ip))
            with limiter_lock:
                for old in list(limiter):
                    if old[0] < bucket:
                        del limiter[old]
                if key not in limiter and len(limiter) >= 4096:
                    return True
                limiter[key] = limiter.get(key, 0) + 1
                return limiter[key] > 20

        def do_GET(self):
            self.request_started = time.monotonic()
            self.metric_reason = None
            if self.path == '/api/info':
                self.reply(200, store.info())
            else:
                self.reply(404, {'error': 'Не найдено'})

        def do_POST(self):
            self.request_started = time.monotonic()
            self.metric_reason = None
            try:
                self.connection.settimeout(10)
                if self.headers.get('Transfer-Encoding'):
                    raise AccessError(400, 'invalid transfer encoding')
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= (65536 if self.path == '/api/node-report' else 4096):
                    raise AccessError(413, 'Слишком большой запрос.')
                origin = self.headers.get('Origin')
                if origin and origin != 'https://' + config['hostname']:
                    raise AccessError(403, 'Недопустимый источник запроса.')
                is_node = self.path in ('/api/node-auth', '/api/node-report')
                node = None
                if is_node:
                    bearer = self.headers.get('Authorization', '')
                    node = next((n for n in config['nodes'] if hmac.compare_digest(bearer, 'Bearer ' + n['key'])), None)
                    if not node:
                        raise AccessError(403, 'forbidden')
                else:
                    # Только локальный cloudflared обращается к этому слушателю.
                    ip = str(ipaddress.ip_address(self.headers.get('CF-Connecting-IP', self.client_address[0])))
                    if self.limited(ip):
                        raise AccessError(429, 'Слишком много запросов. Подождите минуту.', 'rate_limit')
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise AccessError(400, 'Некорректный запрос.')
                if self.path == '/api/access':
                    if origin != 'https://' + config['hostname'] or not verify_turnstile(config, data.get('challenge'), ip):
                        raise AccessError(403, 'Пройдите проверку на странице и попробуйте снова.', 'challenge')
                    result = store.issue(ip)
                elif self.path == '/api/profile':
                    result = store.profile(data.get('code'), data.get('device'))
                elif self.path == '/api/revoke':
                    result = store.revoke(data.get('code'))
                elif self.path == '/api/payment':
                    result = store.payment(data.get('code'))
                elif self.path == '/api/node-auth':
                    result = store.authenticate(data.get('auth'), data.get('listener'))
                elif self.path == '/api/node-report':
                    result = store.report(node['id'], data)
                else:
                    raise AccessError(404, 'Не найдено')
                self.reply(200, result)
            except AccessError as error:
                self.metric_reason = error.reason
                self.reply(error.status, {'error': error.message})
            except (ValueError, KeyError, TypeError):
                self.metric_reason = 'invalid'
                self.reply(400, {'error': 'Некорректный запрос.'})
            except Exception:
                self.metric_reason = 'internal'
                self.reply(503, {'error': 'Сервис временно недоступен. Попробуйте позже.'})
    return Handler


if __name__ == '__main__':
    os.umask(0o077)
    settings = json.loads(Path(os.environ['MAGNETGATE_PUBLIC_CONFIG']).read_text())
    store = AccessStore(settings['database'], settings)
    if store.payments:
        threading.Thread(target=watch_payments, args=(store,), daemon=True).start()
    service = ThreadingHTTPServer(('127.0.0.1', 3410), handler(store, settings))
    service.daemon_threads = True
    service.serve_forever()
