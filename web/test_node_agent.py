import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from node_agent import retry_central


class RetryTests(unittest.TestCase):
    @patch('node_agent.time.sleep')
    def test_transient_failure_retries_once(self, _):
        send = Mock(side_effect=[URLError('temporary'), {'kick': []}])
        self.assertEqual({'kick': []}, retry_central(send))
        self.assertEqual(2, send.call_count)

    @patch('node_agent.time.sleep')
    def test_persistent_failure_still_fails_closed(self, _):
        send = Mock(side_effect=TimeoutError())
        with self.assertRaises(TimeoutError):
            retry_central(send)
        self.assertEqual(2, send.call_count)

    def test_auth_rejection_is_never_retried(self):
        send = Mock(side_effect=HTTPError('https://example.test', 403, '', {}, None))
        with self.assertRaises(HTTPError):
            retry_central(send)
        self.assertEqual(1, send.call_count)

    def test_negative_auth_result_is_preserved(self):
        send = Mock(return_value={'ok': False})
        self.assertEqual({'ok': False}, retry_central(send))
        self.assertEqual(1, send.call_count)
