"""Optional RQT payments for the personal-access service: days of full access bought with Requant.

Off unless the settings have `payments.enabled`. The service holds no keys: it hands out addresses from
a list made offline (`requant-wallet newaddress WALLET --count N --out deposits.txt`), watches them
through a Requant node's public API and credits confirmed deposits. The operator sweeps the coins with
the wallet that made the list (`prepare` on a watch-only copy, `sign` offline, `broadcast`).
"""
import json
import time
import urllib.parse
import urllib.request

CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
BECH32M = 0x2bc830a3
HRP = {'test': 'trq', 'regtest': 'rqrt', 'main': 'rq'}
DAY = 86400


def _polymod(values):
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1ffffff) << 5 ^ v
        for i, g in enumerate((0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)):
            if top >> i & 1:
                chk ^= g
    return chk


def owner_of(address, network):
    """The 32-byte key hash (hex) a Requant address pays, or ValueError."""
    if not isinstance(address, str) or len(address) > 90 or address != address.lower():
        raise ValueError('not a lower-case address')
    hrp, sep, rest = address.rpartition('1')
    if hrp != HRP[network] or not sep or len(rest) < 7 or any(c not in CHARSET for c in rest):
        raise ValueError('not an address of the ' + network + ' network')
    data = [CHARSET.index(c) for c in rest]
    if _polymod([ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp] + data) != BECH32M:
        raise ValueError('bad checksum')
    if data[0] != 0:
        raise ValueError('unknown address version')
    acc, bits, out = 0, 0, bytearray()
    for v in data[1:-6]:
        acc, bits = acc << 5 | v, bits + 5
        if bits >= 8:
            bits -= 8
            out.append(acc >> bits & 0xff)
    if len(out) != 32 or bits >= 5 or acc & (1 << bits) - 1:
        raise ValueError('bad length')
    return out.hex()


def settings(config):
    """Validated payment settings, or None when payments are off."""
    p = config.get('payments') or {}
    if p.get('enabled') is not True:
        return None
    network = p.get('network', 'test')
    price = p.get('priceAtomsPerDay')
    discounts = p.get('discounts', [[7, 10], [30, 20], [90, 30]])
    if network not in HRP:
        raise ValueError('payments.network must be test, regtest or main')
    if type(price) is not int or price <= 0:
        raise ValueError('payments.priceAtomsPerDay must be a positive integer')
    if not isinstance(discounts, list) or any(
            not isinstance(d, list) or len(d) != 2 or type(d[0]) is not int or type(d[1]) is not int
            or d[0] < 1 or not 0 <= d[1] < 100 for d in discounts):
        raise ValueError('payments.discounts must be [[days, percent], ...] with percent below 100')
    confirmations = p.get('confirmations', 6)
    if type(confirmations) is not int or not 1 <= confirmations <= 1000:
        raise ValueError('payments.confirmations must be from 1 to 1000')
    if not isinstance(p.get('api'), str) or not p['api'].startswith(('http://', 'https://')):
        raise ValueError('payments.api must be a node API URL, e.g. http://127.0.0.1:19380')
    if not isinstance(p.get('depositList'), str):
        raise ValueError('payments.depositList must name the deposit address file')
    return {'network': network, 'price': price, 'discounts': sorted(discounts), 'confirmations': confirmations,
            'api': p['api'].rstrip('/'), 'depositList': p['depositList'], 'maxDays': p.get('maxDays', 3650),
            'pollSeconds': p.get('pollSeconds', 60)}


def percent_off(s, days):
    return max([pct for at, pct in s['discounts'] if days >= at], default=0)


def cost(s, days):
    """Atoms for `days` of full access, the discount for that many days applied (rounded up)."""
    return -(-s['price'] * days * (100 - percent_off(s, days)) // 100)


def days_for(s, atoms):
    """The most days `atoms` buy and what is left. Discounts can make more days cost less than fewer
    (30 days at 20% off below 29 at 10%), so every count up to the cap is tried."""
    best = max((d for d in range(1, s['maxDays'] + 1) if cost(s, d) <= atoms), default=0)
    return best, atoms - (cost(s, best) if best else 0)


def public(s):
    """What clients are told: enough to show prices and confirmations, nothing private."""
    return {'currency': 'RQT', 'network': s['network'], 'atomsPerRqt': 10**8, 'priceAtomsPerDay': s['price'],
            'discounts': s['discounts'], 'confirmations': s['confirmations']}


def load_addresses(s):
    """The deposit list: one address per line; every line is checked, so a list for another network or
    with a damaged address is refused as a whole."""
    with open(s['depositList'], encoding='ascii') as f:
        lines = [line.strip() for line in f if line.strip()]
    return [(a, owner_of(a, s['network'])) for a in lines]


def fetch_history(s, addresses, per_request=25, pause=0.25):
    """History entries (each naming its `owner` key hash) of `addresses` from the node's public API.
    25 addresses per request fit what nodes up to 0.15.1 accept; the pause keeps within its rate limit."""
    entries = []
    for k in range(0, len(addresses), per_request):
        if k:
            time.sleep(pause)
        query = urllib.parse.urlencode({'owners': ','.join(addresses[k:k + per_request]), 'limit': 100}, safe=',')
        request = urllib.request.Request(s['api'] + '/api/history?' + query, headers={'User-Agent': 'MagnetGate-Payments/1.0'})
        with urllib.request.urlopen(request, timeout=20) as reply:
            data = json.loads(reply.read(4 << 20))
        if not isinstance(data, list):
            raise ValueError('unexpected answer from the node API')
        entries.extend(data)
    return entries
