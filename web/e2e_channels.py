"""End-to-end check of payment channels on a local Requant regtest node, with the real binaries.

    REQUANT_BIN=/path/to/requant/target/release python e2e_channels.py

Starts `requantd --network regtest` mining to a client key, then runs the client side with
`requant-wallet channel` and the service side through `AccessStore`: open, accept, fund, pay by the
minute, close on request, and a second channel closed by the service before its expiry.
"""
import json
from decimal import Decimal
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import channels
from server import AccessStore

BIN = os.environ.get('REQUANT_BIN', '')
EXE = '.exe' if os.name == 'nt' else ''
WALLET = os.path.join(BIN, 'requant-wallet' + EXE)
NODE = os.path.join(BIN, 'requantd' + EXE)
PRICE = 200_000_000  # 2 RQT a day: 138,889 atoms a minute


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def main():
    tmp = tempfile.mkdtemp(prefix='mg-e2e-')
    api_port, rpc_port, p2p_port = free_port(), free_port(), free_port()
    api = f'http://127.0.0.1:{api_port}'

    def wallet(*args, check=True):
        done = subprocess.run([WALLET, *args, '--network', 'regtest', '--api', api, '--yes'], cwd=tmp,
                              capture_output=True, text=True, timeout=60)
        if check and done.returncode:
            raise SystemExit(f'{args}: {done.stderr.strip()}')
        return done.stdout

    def field(out, name):
        return next(line.split()[-1] for line in out.splitlines() if line.startswith(name))

    def get(path):
        with urllib.request.urlopen(api + path, timeout=10) as r:
            return json.loads(r.read())

    def wait(what, f, secs=120):
        t = time.time()
        while not f():
            if time.time() - t > secs:
                raise SystemExit('timed out waiting for ' + what)
            time.sleep(0.3)

    client = wallet('keygen', 'client.key', '--no-passphrase')
    client_hash = field(client, 'key hash')
    server = wallet('keygen', 'srv.key', '--no-passphrase')
    server_address = field(server, 'address')
    node = subprocess.Popen([NODE, '--network', 'regtest', '--datadir', os.path.join(tmp, 'node'), '--listen', f'127.0.0.1:{p2p_port}',
                             '--rpc', f'127.0.0.1:{rpc_port}', '--explorer', f'127.0.0.1:{api_port}', '--mine', client_hash,
                             '--mine-interval-ms', '100', '--no-discover'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        def balance(src):
            line = next(line for line in wallet('balance', src).splitlines() if line.startswith('confirmed'))
            return int(Decimal(line.split()[1]) * 10**8)
        wait('the node API', lambda: _ok(lambda: get('/api/info')))
        wait('mature coins', lambda: balance('client.key') > 20 * 10**8)

        with open(os.path.join(tmp, 'deposits.txt'), 'w') as f:
            f.write(server_address + '\n')
        config = {'secret': 'b' * 64, 'codeLifetimeDays': 7, 'dailyBytes': 1000,
                  'nodes': [{'id': 'fi', 'country': 'FI', 'endpoint': {'t': 'hy2', 'port': 4443}, 'fullEndpoint': {'t': 'hy2', 'port': 4444}}],
                  'payments': {'enabled': True, 'network': 'regtest', 'api': api, 'depositList': os.path.join(tmp, 'deposits.txt'),
                               'priceAtomsPerDay': PRICE, 'confirmations': 2,
                               'channels': {'enabled': True, 'publicApi': api, 'wallet': WALLET, 'key': os.path.join(tmp, 'srv.key'),
                                            'minDepositAtoms': 10**8, 'minBlocks': 144, 'maxBlocks': 20000, 'closeMarginBlocks': 20}}}
        store = AccessStore(os.path.join(tmp, 'state.sqlite'), config)
        store.report('fi', {'traffic': {}, 'online': {}, 'epoch': 'e2e'})
        code = store.issue('203.0.113.9')['code']
        info = store.info()['payments']['channels']
        assert info['payTo'] == server_address, info

        def open_channel(name, amount, blocks):
            expiry = str(channels.height(store.channels) + blocks)
            wallet('channel', 'open', 'client.key', info['serverPubkey'], info['payTo'], amount, expiry, '--out', name)
            with open(os.path.join(tmp, name)) as f:
                proposed = json.load(f)
            answer = store.channel_open(code, proposed)
            at, refund = answer['at'], proposed['refund']
            accepted = {**proposed, 'refund': refund[:at] + answer['sig2'] + refund[at + 128:], 'accepted': True}
            with open(os.path.join(tmp, name), 'w') as f:
                json.dump(accepted, f)
            wallet('channel', 'fund', 'client.key', name)
            txid = accepted['funding_txid']
            wait('the deposit to confirm', lambda: channels.confirmations(store.channels, txid) >= 2)
            return accepted

        def pay(name, total, out):
            wallet('channel', 'pay', 'client.key', name, total, '--out', out)
            with open(os.path.join(tmp, out)) as f:
                return store.channel_pay(code, f.read().strip())

        # a channel of 3 RQT: 0.01 RQT buys 7 minutes, 0.05 in total 35 (36 cost 5,000,004 atoms)
        ch = open_channel('ch.json', '3', 400)
        now = time.time()
        r = pay('ch.json', '0.01', 's1.hex')
        assert r['tier'] == 'full' and 7 * 60 - 5 <= r['paidUntil'] - now <= 7 * 60 + 5, r
        r = pay('ch.json', '0.05', 's2.hex')
        assert 35 * 60 - 5 <= r["paidUntil"] - now <= 35 * 60 + 5, r
        assert store.profile(code, 'e' * 64)['endpoints'][0]['port'] == 4444
        # the client closes: 0.05 to the service, the rest of the deposit back to the client
        closed = store.channel_close(code)['channel']
        assert closed['status'] == 'closed', closed
        wait('the close to confirm', lambda: balance(server_address) == 5_000_000)
        print('channel 1: paid 0.05 RQT for 35 minutes, closed by the client in', closed['closedTxid'])

        # a second channel that the service closes by itself before the expiry
        ch = open_channel('ch2.json', '2', 160)
        pay('ch2.json', '0.02', 's3.hex')
        expiry = ch['expiry']
        wait('the close margin', lambda: channels.height(store.channels) >= expiry - store.channels['closeMargin'])
        assert store.close_due(channels.height(store.channels)) == 1
        wait('the second close to confirm', lambda: balance(server_address) == 7_000_000)
        print('channel 2: paid 0.02 RQT, closed by the service', expiry - channels.height(store.channels), 'blocks before its expiry')
        print('E2E OK')
    finally:
        node.terminate()
        node.wait(10)


def _ok(f):
    try:
        f()
        return True
    except Exception:
        return False


if __name__ == '__main__':
    if not os.path.isfile(WALLET) or not os.path.isfile(NODE):
        sys.exit('set REQUANT_BIN to the directory with requantd and requant-wallet')
    main()
