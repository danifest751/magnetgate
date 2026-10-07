"""Private read-only admin service. No public ingress or trust in proxy identity headers."""
import argparse
import json
import mimetypes
import os
import signal
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from admin_store import AdminStore


def handler(store, directory):
    directory = Path(directory).resolve()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def allowed(self):
            # Origin/Host checks prevent browser DNS rebinding against the loopback-only service.
            host = self.headers.get('Host', '')
            expected = f'127.0.0.1:{self.server.server_port}'
            local = f'localhost:{self.server.server_port}'
            origin = self.headers.get('Origin')
            return self.client_address[0] == '127.0.0.1' and host in (expected, local) and (not origin or origin == 'http://' + host) and self.headers.get('Sec-Fetch-Site', 'none') != 'cross-site'

        def reply(self, status, body, content_type='application/json; charset=utf-8'):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self.allowed():
                return self.reply(403, {'error': 'Private admin: use an SSH tunnel. Public authentication is not configured.'})
            url = urllib.parse.urlsplit(self.path)
            if len(self.path) > 2048:
                return self.reply(414, {'error': 'Request too long'})
            if url.path.startswith('/admin/api/'):
                section = url.path[len('/admin/api/'):].strip('/')
                if section not in {'overview', 'access', 'nodes', 'traffic', 'requests', 'events'}:
                    return self.reply(404, {'error': 'Not found'})
                try:
                    params = dict(urllib.parse.parse_qsl(url.query, max_num_fields=12))
                    return self.reply(200, store.query(section, params))
                except (ValueError, TypeError):
                    return self.reply(400, {'error': 'Invalid filter. Use a UTC date range of at most 31 days.'})
                except Exception:
                    return self.reply(503, {'error': 'Source data is unavailable. No sample data is substituted.'})
            if url.path in ('/admin', '/admin/'):
                target = directory / 'index.html'
            elif url.path.startswith('/admin/'):
                decoded = urllib.parse.unquote(url.path[len('/admin/'):])
                target = (directory / decoded).resolve()
                if not target.is_relative_to(directory) or any(part.startswith('.') for part in Path(decoded).parts):
                    return self.reply(404, {'error': 'Not found'})
            else:
                return self.reply(404, {'error': 'Not found'})
            if not target.is_file() or target.suffix not in {'.html', '.js', '.css', '.woff2', '.svg', '.png', '.webp'}:
                return self.reply(404, {'error': 'Not found'})
            return self.reply(200, target.read_bytes(), mimetypes.guess_type(target.name)[0] or 'application/octet-stream')

        def do_POST(self):
            return self.reply(405 if self.allowed() else 403, {'error': 'Read-only admin. Mutations are disabled.'})
        do_DELETE = do_POST
        do_PUT = do_POST
        do_PATCH = do_POST
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--settings', required=True, help='Existing private public-access config, never committed')
    parser.add_argument('--history', required=True, help='Separate private analytics SQLite database')
    parser.add_argument('--static', default=str(Path(__file__).parent / 'dist-admin'))
    parser.add_argument('--port', type=int, default=3420)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('use an unprivileged port')
    os.umask(0o077)
    config = json.loads(Path(args.settings).read_text())
    if config.get('analyticsDatabase') and Path(config['analyticsDatabase']).resolve() != Path(args.history).resolve():
        parser.error('history must match analyticsDatabase when request instrumentation is enabled')
    store = AdminStore(config, args.history)
    store.collect()
    stop = threading.Event()
    def collect():
        while not stop.wait(5):
            try:
                store.collect()
            except Exception:
                # Do not expose the original exception or private configuration.
                with store.lock:
                    store.available = False
    collector = threading.Thread(target=collect, daemon=True)
    collector.start()
    service = ThreadingHTTPServer(('127.0.0.1', args.port), handler(store, args.static))
    service.daemon_threads = True
    def shutdown(*_):
        stop.set()
        threading.Thread(target=service.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        service.serve_forever()
    finally:
        stop.set()
        collector.join(timeout=4)
        service.server_close()
        store.close()


if __name__ == '__main__':
    main()
