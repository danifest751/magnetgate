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


def listeners_of(config):
    """The Hysteria2 instances this agent accounts for. One by default (today's node). With payments, a
    node may run two: `free` (with the free tier's bandwidth limit) and `full` (paid accounts only); each
    has its own pid file and traffic-stats port, and authenticates at /auth/<name>."""
    listeners = config.get('listeners') or [{'name': 'free', 'pidFile': '/run/magnetgate-public/hysteria.pid', 'statsPort': 3412, 'statsSecret': config.get('statsSecret', '')}]
    names = [item.get('name') for item in listeners]
    if len(listeners) > 4 or len(set(names)) != len(names) or any(name not in ('free', 'full') for name in names):
        raise ValueError('listeners must be named free and full')
    return listeners


def combine(memory, samples):
    """Traffic of several listeners as one report. `samples` is [(name, epoch, traffic)]; `memory` keeps
    each listener's last epoch and totals between calls. The result counts growth since the agent
    started, so a listener restarting (new epoch, counters from zero) adds only its new traffic, and
    the report's own epoch is the agent's."""
    totals = memory.setdefault('totals', {})
    for name, epoch, traffic in samples:
        before = memory.setdefault('last', {}).get(name)
        traffic = {d: {'tx': c['tx'], 'rx': c['rx']} for d, c in traffic.items()
                   if isinstance(c, dict) and all(type(c.get(k)) is int and c[k] >= 0 for k in ('tx', 'rx'))}
        for device, counters in traffic.items():
            # first sight of a listener: a baseline only (what it carried before this agent was counted then)
            if before is None:
                continue
            old = before[1].get(device, {}) if before[0] == epoch else {}
            total = totals.setdefault(device, {'tx': 0, 'rx': 0})
            for k in ('tx', 'rx'):
                total[k] += max(0, counters[k] - old.get(k, 0))
        memory['last'][name] = (epoch, traffic)
    return {d: dict(c) for d, c in totals.items()}


def run(config):
    central_base = config.get('centralBase', 'https://magnet.norma.so/api/')
    if central_base not in ('https://magnet.norma.so/api/', 'http://127.0.0.1:3410/api/'):
        raise ValueError('invalid central endpoint')
    lock = threading.Lock()
    state = {'healthy': False, 'online': {}, 'pending': {}, 'epoch': ''}
    listeners = listeners_of(config)
    single = len(listeners) == 1
    memory = {}
    agent_epoch = 'agent:%d:%d' % (os.getpid(), time.time())

    def request(url, data=None, secret='', timeout=6):
        raw = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(url, data=raw, headers={'Content-Type': 'application/json', 'Authorization': secret, 'User-Agent': 'MagnetGate-Node/1.0'})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            payload = response.read(131073)
            if len(payload) > 131072:
                raise ValueError('oversized response')
            return json.loads(payload or '{}')

    def stats(path, data=None, listener=None):
        listener = listener or listeners[0]
        return request('http://127.0.0.1:%d/' % listener['statsPort'] + path, data, listener['statsSecret'])

    def stats_all(path, data=None):
        """Online counts summed over the listeners (or the result of a kick on each)."""
        merged = {}
        for listener in listeners:
            for device, count in (stats(path, data, listener) or {}).items():
                merged[device] = merged.get(device, 0) + count if type(count) is int else count
        return merged

    def central(path, data):
        return retry_central(lambda: request(central_base + path, data, 'Bearer ' + config['nodeKey'], timeout=3))

    def monitor():
        while True:
            try:
                samples = []
                for listener in listeners:
                    # PID и время старта процесса дают устойчивую эпоху после перезапуска агента.
                    pid = Path(listener['pidFile']).read_text().strip()
                    samples.append((listener['name'], pid + ':' + Path('/proc/' + pid + '/stat').read_text().split()[21], stats('traffic', None, listener)))
                online = stats_all('online')
                if single:
                    _, epoch, traffic = samples[0]
                else:
                    epoch, traffic = agent_epoch, combine(memory, samples)
                report = central('node-report', {'online': online, 'traffic': traffic, 'epoch': epoch})
                if report.get('kick'):
                    print('central policy requested disconnection', flush=True)
                    for listener in listeners:
                        stats('kick', report['kick'], listener)
                with lock:
                    state.update(healthy=True, epoch=epoch)
                    refresh_presence(state, online, time.monotonic())
            except Exception as error:
                # Do not log response bodies, identities, addresses or credentials.
                print('accounting unavailable: ' + type(error).__name__, flush=True)
                with lock:
                    state['healthy'] = False
                # При потере учёта новые входы закрываются, текущие отключаются.
                for listener in listeners:
                    try:
                        online = stats('online', None, listener)
                        if online:
                            stats('kick', list(online), listener)
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
                # /auth is the free listener of a one-listener node; /auth/<name> names it
                name = 'free' if self.path == '/auth' else self.path[len('/auth/'):] if self.path.startswith('/auth/') else None
                if name not in [listener['name'] for listener in listeners] or not 0 < length <= 2048:
                    raise ValueError('invalid request')
                data = json.loads(self.rfile.read(length))
                with lock:
                    if not state['healthy'] or sum(state['online'].values()) + len(state['pending']) >= config.get('maxConnections', 10):
                        raise ValueError('capacity')
                result = central('node-auth', {'auth': data.get('auth')} if single else {'auth': data.get('auth'), 'listener': name})
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
