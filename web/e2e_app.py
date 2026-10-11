"""The desktop app's pay-as-you-go path (app/channel-wallet.cjs) against this access service over HTTP,
on a local Requant regtest node, with the real binaries.

    REQUANT_BIN=/path/to/requant/target/release python e2e_app.py
"""
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer

import e2e_channels as e2e
from server import AccessStore, handler


def main():
    tmp = tempfile.mkdtemp(prefix='mg-e2e-app-')
    api_port, rpc_port, p2p_port = e2e.free_port(), e2e.free_port(), e2e.free_port()
    api = f'http://127.0.0.1:{api_port}'
    run = lambda *a: subprocess.run([e2e.WALLET, *a, '--network', 'regtest', '--api', api, '--yes'], cwd=tmp,
                                    capture_output=True, text=True, timeout=60, check=True).stdout
    miner = run('keygen', 'miner.key', '--no-passphrase')
    miner_hash = next(l.split()[-1] for l in miner.splitlines() if l.startswith('key hash'))
    server = run('keygen', 'srv.key', '--no-passphrase')
    server_address = next(l.split()[-1] for l in server.splitlines() if l.startswith('address'))
    node = subprocess.Popen([e2e.NODE, '--network', 'regtest', '--datadir', os.path.join(tmp, 'node'), '--listen', f'127.0.0.1:{p2p_port}',
                             '--rpc', f'127.0.0.1:{rpc_port}', '--explorer', f'127.0.0.1:{api_port}', '--mine', miner_hash,
                             '--mine-interval-ms', '100', '--no-discover'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        def confirmed():
            try:
                line = next(l for l in run('balance', 'miner.key').splitlines() if l.startswith('confirmed'))
                return float(line.split()[1]) > 20
            except Exception:
                return False
        t = time.time()
        while not confirmed():
            if time.time() - t > 120:
                raise SystemExit('no mature coins')
            time.sleep(0.5)
        with open(os.path.join(tmp, 'deposits.txt'), 'w') as f:
            f.write(server_address + '\n')
        config = {'secret': 'c' * 64, 'codeLifetimeDays': 7, 'dailyBytes': 1000, 'hostname': 'localhost',
                  'nodes': [{'id': 'fi', 'key': 'k' * 32, 'country': 'FI', 'endpoint': {'t': 'hy2', 'port': 4443}, 'fullEndpoint': {'t': 'hy2', 'port': 4444}}],
                  'payments': {'enabled': True, 'network': 'regtest', 'api': api, 'depositList': os.path.join(tmp, 'deposits.txt'),
                               'priceAtomsPerDay': e2e.PRICE, 'confirmations': 2,
                               'channels': {'enabled': True, 'publicApi': api, 'wallet': e2e.WALLET, 'key': os.path.join(tmp, 'srv.key'),
                                            'minDepositAtoms': 10**8, 'minBlocks': 144, 'maxBlocks': 20000, 'closeMarginBlocks': 20}}}
        store = AccessStore(os.path.join(tmp, 'state.sqlite'), config)
        store.report('fi', {'traffic': {}, 'online': {}, 'epoch': 'e2e'})
        code = store.issue('203.0.113.10')['code']
        port = e2e.free_port()
        service = ThreadingHTTPServer(('127.0.0.1', port), handler(store, config))
        threading.Thread(target=service.serve_forever, daemon=True).start()
        app = os.path.join(os.path.dirname(__file__), '..', 'app', 'tests', 'e2e-channel.cjs')
        work = os.path.join(tmp, 'app')
        os.makedirs(work)
        env = {**os.environ, 'SERVICE': f'http://127.0.0.1:{port}', 'CODE': code, 'WALLET_BIN': e2e.WALLET,
               'MINER_KEY': os.path.join(tmp, 'miner.key'), 'WORK': work}
        done = subprocess.run(['node', app], env=env, timeout=600)
        service.shutdown()
        sys.exit(done.returncode)
    finally:
        node.terminate()
        node.wait(10)


if __name__ == '__main__':
    main()
