"""Pay-as-you-go full access over Requant one-way payment channels (requant-wallet 0.7.0 `channel`).

Off unless `payments.channels.enabled`. The client locks a deposit under 2-of-2 (its key and this
service's channel key) with a refund to itself from an expiry height, then pays by signing states that
pay the service more each time; each state buys minutes of full access at the daily price. The service
closes the channel with the last state before the expiry, or when the client asks, and the rest of the
deposit goes back to the client in that state.

The protocol and its checks live in `requant-wallet`; this module runs it on temporary files. The
channel key on the server can only countersign refunds and states the client signed, so it cannot take
a client's coins. What closed channels paid sits at that key's address until the operator sweeps it
(`requant-wallet send KEY COLD_ADDRESS all`).
"""
import json
import os
import re
import subprocess
import tempfile
import urllib.request

MINUTES_PER_DAY = 1440
HEX64 = re.compile(r'^[0-9a-f]{64}$')


def settings(config, payment_settings):
    """Validated channel settings, or None when channels are off (or payments are)."""
    c = ((config.get('payments') or {}).get('channels')) or {}
    if not payment_settings or c.get('enabled') is not True:
        return None
    def whole(name, default, low, high):
        v = c.get(name, default)
        if type(v) is not int or not low <= v <= high:
            raise ValueError(f'payments.channels.{name} must be an integer from {low} to {high}')
        return v
    if not isinstance(c.get('wallet'), str) or not isinstance(c.get('key'), str):
        raise ValueError('payments.channels needs wallet (the requant-wallet binary) and key (the channel key file)')
    public_api = c.get('publicApi')
    if not isinstance(public_api, str) or not public_api.startswith(('http://', 'https://')):
        raise ValueError('payments.channels.publicApi must be the Requant API URL clients use, e.g. http://<node-ip>:19380')
    min_blocks = whole('minBlocks', 1440, 144, 10**6)
    s = {
        'wallet': c['wallet'], 'key': c['key'],
        'minDeposit': whole('minDepositAtoms', 10**8, 3000, 10**16),
        'minBlocks': min_blocks,
        'maxBlocks': whole('maxBlocks', 20160, min_blocks, 10**6),
        'closeMargin': whole('closeMarginBlocks', 120, 10, min_blocks - 1),
        # the daily price spread over minutes, rounded up
        'pricePerMinute': -(-payment_settings['price'] // MINUTES_PER_DAY),
        'network': payment_settings['network'], 'api': payment_settings['api'], 'publicApi': public_api.rstrip('/'),
    }
    return s


class Wallet:
    """`requant-wallet` on temporary files, against the node API of the payment settings."""

    def __init__(self, s, runner=subprocess.run):
        self.s, self.runner = s, runner

    def run(self, args, files=None):
        """Run the wallet in a fresh directory holding `files`; returns (stdout, the files afterwards)."""
        with tempfile.TemporaryDirectory(prefix='mg-channel-') as tmp:
            for name, text in (files or {}).items():
                with open(os.path.join(tmp, name), 'w', encoding='utf-8') as f:
                    f.write(text)
            done = self.runner([self.s['wallet'], *args, '--network', self.s['network'], '--api', self.s['api'], '--yes'],
                               cwd=tmp, capture_output=True, text=True, timeout=60)
            if done.returncode != 0:
                # the wallet's own message, without paths
                message = (done.stderr or '').strip().splitlines()
                raise ChannelError(message[-1].removeprefix('requant-wallet: ')[:240] if message else 'channel check failed')
            after = {}
            for name in files or {}:
                with open(os.path.join(tmp, name), encoding='utf-8') as f:
                    after[name] = f.read()
            return done.stdout, after

    def identity(self):
        """(public key hex, address) of the channel key."""
        out, _ = self.run(['address', self.s['key']])
        fields = dict(line.split(None, 1) for line in out.splitlines() if ' ' in line.strip())
        pubkey, address = fields.get('pubkey', '').strip(), fields.get('address', '').strip()
        if not HEX64.match(pubkey) or not address:
            raise ValueError('payments.channels.key is not a usable key file')
        return pubkey, address

    def accept(self, channel):
        _, after = self.run(['channel', 'accept', self.s['key'], 'ch.json', '--min-blocks', str(self.s['minBlocks'])],
                            {'ch.json': json.dumps(channel)})
        return json.loads(after['ch.json'])

    def receive(self, channel, state):
        out, _ = self.run(['channel', 'receive', 'ch.json', 's.hex'], {'ch.json': json.dumps(channel), 's.hex': state})
        return json.loads(out)

    def close(self, channel, state):
        out, _ = self.run(['channel', 'close', self.s['key'], 'ch.json', 's.hex'], {'ch.json': json.dumps(channel), 's.hex': state})
        txid = out.strip().rsplit(' ', 1)[-1]
        if not HEX64.match(txid):
            raise ChannelError('the close was not sent')
        return txid


class ChannelError(Exception):
    pass


def api_get(s, path):
    request = urllib.request.Request(s['api'] + path, headers={'User-Agent': 'MagnetGate-Payments/1.0'})
    with urllib.request.urlopen(request, timeout=20) as reply:
        return json.loads(reply.read(1 << 20))


def height(s):
    return int(api_get(s, '/api/info')['height'])


def confirmations(s, txid):
    """Confirmations of a transaction, 0 while pooled or unknown."""
    try:
        return int(api_get(s, '/api/tx/' + txid).get('confirmations') or 0)
    except Exception:
        return 0


def public(s, pubkey, address):
    """What clients need to open a channel."""
    return {'serverPubkey': pubkey, 'payTo': address, 'minDepositAtoms': s['minDeposit'], 'minBlocks': s['minBlocks'],
            'maxBlocks': s['maxBlocks'], 'closeMarginBlocks': s['closeMargin'], 'priceAtomsPerMinute': s['pricePerMinute'],
            'api': s['publicApi']}
