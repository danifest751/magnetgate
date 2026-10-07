import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from node_agent import retry_central, refresh_presence


class RetryTests(unittest.TestCase):
    def test_reconnect_reservation_waits_for_new_session(self):
        state = {'pending': {'device': (0, 20)}}
        refresh_presence(state, {'device': 1}, 10)
        self.assertEqual({}, state['pending'])
        state['pending']['device'] = (1, 22)
        refresh_presence(state, {'device': 1}, 11)
        self.assertIn('device', state['pending'])
        refresh_presence(state, {'device': 2}, 12)
        self.assertEqual({}, state['pending'])

    def test_failed_handshake_reservation_expires(self):
        state = {'pending': {'device': (1, 20)}}
        refresh_presence(state, {'device': 1}, 20)
        self.assertEqual({}, state['pending'])

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
