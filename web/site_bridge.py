"""Authenticated website relay; never trust client-IP headers without this MAC.

The relay verifies its own same-origin, single-use ALTCHA proof before signing
an /api/access request. Legacy direct requests retain Turnstile verification.
"""
import hashlib
import hmac
import ipaddress
import re
import threading
import time
from pathlib import Path

_seen = {}
_lock = threading.Lock()


def bridge_identity(config, headers, pathname, body, now=None):
    signature = headers.get('X-Magnet-Bridge-Signature')
    if signature is None:
        return None
    now = time.time() if now is None else now
    origin = headers.get('Origin', '')
    timestamp = headers.get('X-Magnet-Bridge-Time', '')
    nonce = headers.get('X-Magnet-Bridge-Nonce', '')
    ip = headers.get('X-Magnet-Bridge-IP', '')
    if origin not in config.get('websiteBridgeOrigins', []) or not re.fullmatch(r'[0-9]{10}', timestamp) or abs(now-int(timestamp)) > 30:
        raise ValueError('Invalid bridge identity')
    if not re.fullmatch(r'[a-f0-9]{32}', nonce) or not re.fullmatch(r'[a-f0-9]{64}', signature):
        raise ValueError('Invalid bridge identity')
    ipaddress.ip_address(ip)
    secret = Path(config['websiteBridgeSecretFile']).read_text().strip()
    if len(secret) < 32:
        raise ValueError('Bridge unavailable')
    message = '\n'.join(['MGWEB1', timestamp, nonce, pathname, origin, ip, hashlib.sha256(body).hexdigest()])
    expected = hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ValueError('Invalid bridge signature')
    with _lock:
        for key in list(_seen):
            if _seen[key] < now-30:
                del _seen[key]
        if nonce in _seen or len(_seen) >= 8192:
            raise ValueError('Bridge replay')
        _seen[nonce] = int(timestamp)
    return ip
