"""Локальная авторизация Hysteria2 и контроль потребления без журналов посещений."""
import json
import os
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def retry_central(send):
    """Retry transient transport failures once; auth decisions and quotas are unchanged."""
    for attempt in range(2):
        try:
            return send()
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt or isinstance(error, urllib.error.HTTPError) and error.code < 500:
                raise
            time.sleep(0.25)


def refresh_presence(state, online, now):
    state['online'] = online
    # A reservation is fulfilled only when the connection count grows beyond its baseline.
    # An older live session must not erase the reservation for a reconnect still in flight.
    state['pending'] = {identity: (count, deadline)
                        for identity, (count, deadline) in state['pending'].items()
                        if deadline > now and online.get(identity, 0) <= count}


def run(config):
    central_base = config.get('centralBase', 'https://magnet.norma.so/api/')
    if central_base not in ('https://magnet.norma.so/api/', 'http://127.0.0.1:3410/api/'):
        raise ValueError('invalid central endpoint')
    lock = threading.Lock()
    state = {'healthy': False, 'online': {}, 'pending': {}, 'epoch': ''}

    def request(url, data=None, secret='', timeout=6):
        raw = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(url, data=raw, headers={'Content-Type': 'application/json', 'Authorization': secret, 'User-Agent': 'MagnetGate-Node/1.0'})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            payload = response.read(131073)
            if len(payload) > 131072:
                raise ValueError('oversized response')
            return json.loads(payload or '{}')

    def stats(path, data=None):
        return request('http://127.0.0.1:3412/' + path, data, config['statsSecret'])

    def central(path, data):
        return retry_central(lambda: request(central_base + path, data, 'Bearer ' + config['nodeKey'], timeout=3))

    def monitor():
        while True:
            try:
                # PID и время старта процесса дают устойчивую эпоху после перезапуска агента.
                pid = Path('/run/magnetgate-public/hysteria.pid').read_text().strip()
                epoch = pid + ':' + Path('/proc/' + pid + '/stat').read_text().split()[21]
                online = stats('online')
                traffic = stats('traffic')
                report = central('node-report', {'online': online, 'traffic': traffic, 'epoch': epoch})
                if report.get('kick'):
                    print('central policy requested disconnection', flush=True)
                    stats('kick', report['kick'])
                with lock:
                    state.update(healthy=True, epoch=epoch)
                    refresh_presence(state, online, time.monotonic())
            except Exception as error:
                # Do not log response bodies, identities, addresses or credentials.
                print('accounting unavailable: ' + type(error).__name__, flush=True)
                with lock:
                    state['healthy'] = False
                # При потере учёта новые входы закрываются, текущие отключаются.
                try:
                    online = stats('online')
                    if online:
                        stats('kick', list(online))
                except Exception:
                    pass
            time.sleep(5)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            result = {'ok': False}
            try:
                self.connection.settimeout(8)
                length = int(self.headers.get('Content-Length', '0'))
                if self.path != '/auth' or not 0 < length <= 2048:
                    raise ValueError('invalid request')
                data = json.loads(self.rfile.read(length))
                with lock:
                    if not state['healthy'] or sum(state['online'].values()) + len(state['pending']) >= config.get('maxConnections', 10):
                        raise ValueError('capacity')
                result = central('node-auth', {'auth': data.get('auth')})
                if result.get('ok'):
                    # Fresh local presence avoids a five-second lockout between a successful
                    # connection and the monitor's next accounting tick.
                    online = stats('online')
                    with lock:
                        refresh_presence(state, online, time.monotonic())
                        identity = result['id']
                        # A mobile reconnect may arrive before the dead QUIC session expires.
                        # One overlapping session avoids locking out the same device after a drop.
                        if state['online'].get(identity, 0) >= 2 or identity in state['pending'] or sum(state['online'].values()) + len(state['pending']) >= config.get('maxConnections', 10):
                            result = {'ok': False}
                        else:
                            state['pending'][identity] = (online.get(identity, 0), time.monotonic() + 12)
            except Exception:
                result = {'ok': False}
            body = json.dumps(result).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    threading.Thread(target=monitor, daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1', 3411), Handler).serve_forever()


if __name__ == '__main__':
    run(json.loads(Path(os.environ['MAGNETGATE_NODE_CONFIG']).read_text()))
