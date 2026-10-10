import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from node_agent import retry_central, refresh_presence, combine, listeners_of


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


class ListenerTests(unittest.TestCase):
    def test_one_listener_by_default_and_names_checked(self):
        self.assertEqual([l['name'] for l in listeners_of({'statsSecret': 's'})], ['free'])
        two = [{'name': 'free', 'pidFile': 'a', 'statsPort': 1, 'statsSecret': 'x'}, {'name': 'full', 'pidFile': 'b', 'statsPort': 2, 'statsSecret': 'y'}]
        self.assertEqual(listeners_of({'listeners': two}), two)
        for bad in ([two[0], two[0]], [{**two[0], 'name': 'other'}]):
            with self.assertRaises(ValueError):
                listeners_of({'listeners': bad})

    def test_traffic_of_two_listeners_adds_up_across_restarts(self):
        memory = {}
        # the first sample is a baseline: traffic from before the agent started is not counted again
        self.assertEqual(combine(memory, [('free', 'p1', {'d': {'tx': 50, 'rx': 50}}), ('full', 'q1', {})]), {})
        report = combine(memory, [('free', 'p1', {'d': {'tx': 60, 'rx': 50}}), ('full', 'q1', {'d': {'tx': 5, 'rx': 0}})])
        self.assertEqual(report, {'d': {'tx': 15, 'rx': 0}})
        # the same sample again adds nothing
        self.assertEqual(combine(memory, [('free', 'p1', {'d': {'tx': 60, 'rx': 50}}), ('full', 'q1', {'d': {'tx': 5, 'rx': 0}})]), report)
        # the free listener restarts: its counters start from zero and only the new traffic counts
        report = combine(memory, [('free', 'p2', {'d': {'tx': 3, 'rx': 1}}), ('full', 'q1', {'d': {'tx': 5, 'rx': 0}})])
        self.assertEqual(report, {'d': {'tx': 18, 'rx': 1}})
        # malformed counters are skipped
        self.assertEqual(combine(memory, [('full', 'q1', {'d': {'tx': -1, 'rx': 0}, 'e': 'x'})]), report)
