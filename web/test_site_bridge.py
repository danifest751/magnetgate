import hashlib
import hmac
import tempfile
import time
import unittest
from pathlib import Path
from site_bridge import bridge_identity


class BridgeTests(unittest.TestCase):
    def test_signature_binds_origin_network_path_and_exact_body_and_prevents_replay(self):
        with tempfile.TemporaryDirectory() as d:
            key = Path(d)/'secret'
            key.write_text('a'*64)
            config = {'websiteBridgeOrigins':['https://magnetvpn.world'], 'websiteBridgeSecretFile':str(key)}
            t = str(int(time.time()))
            body = b'{}'
            ip = '198.51.100.9'
            headers = {'Origin':'https://magnetvpn.world', 'X-Magnet-Bridge-Time':t, 'X-Magnet-Bridge-Nonce':'ab'*16, 'X-Magnet-Bridge-IP':ip}
            message = '\n'.join(['MGWEB1',t,'ab'*16,'/api/access',headers['Origin'],ip,hashlib.sha256(body).hexdigest()])
            headers['X-Magnet-Bridge-Signature'] = hmac.new(('a'*64).encode(),message.encode(),hashlib.sha256).hexdigest()
            for bad in ({**headers,'Origin':'https://evil.invalid'}, {**headers,'X-Magnet-Bridge-IP':'203.0.113.1'}):
                with self.assertRaises(ValueError): bridge_identity(config,bad,'/api/access',body)
            with self.assertRaises(ValueError): bridge_identity(config,headers,'/api/access',b'{"code":"changed"}')
            with self.assertRaises(ValueError): bridge_identity(config,headers,'/api/revoke',body)
            with self.assertRaises(ValueError): bridge_identity(config,headers,'/api/access',body,now=int(t)+31)
            self.assertEqual(bridge_identity(config,headers,'/api/access',body),ip)
            with self.assertRaises(ValueError): bridge_identity(config,headers,'/api/access',body)
            self.assertIsNone(bridge_identity(config,{},'/api/access',body))


if __name__ == '__main__': unittest.main()
