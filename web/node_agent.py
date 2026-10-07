"""Локальная авторизация Hysteria2 и контроль потребления без журналов посещений."""
import json
import os
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def run(config):
    lock = threading.Lock()
    state = {'healthy': False, 'online': {}, 'pending': {}, 'epoch': ''}

    def request(url, data=None, secret=''):
        raw = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(url, data=raw, headers={'Content-Type': 'application/json', 'Authorization': secret, 'User-Agent': 'MagnetGate-Node/1.0'})
        with urllib.request.urlopen(req, timeout=6) as response:
            payload = response.read(131073)
            if len(payload) > 131072:
                raise ValueError('oversized response')
            return json.loads(payload or '{}')

    def stats(path, data=None):
        return request('http://127.0.0.1:3412/' + path, data, config['statsSecret'])

    def central(path, data):
        return request('https://magnet.norma.so/api/' + path, data, 'Bearer ' + config['nodeKey'])

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
                    stats('kick', report['kick'])
                with lock:
                    state.update(healthy=True, online=online, epoch=epoch)
                    state['pending'] = {k: t for k, t in state['pending'].items() if t > time.monotonic() and k not in online}
            except Exception:
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
                    with lock:
                        identity = result['id']
                        if identity in state['online'] or identity in state['pending'] or sum(state['online'].values()) + len(state['pending']) >= config.get('maxConnections', 10):
                            result = {'ok': False}
                        else:
                            state['pending'][identity] = time.monotonic() + 12
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
