"""Local mocked transport only: never contact external services."""
import io
import json
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request

from evoagent.models import Proposal, Task
from evoagent.providers import DemoProvider, OpenAICompatibleProvider, _NoRedirect


def envelope(content):
    return json.dumps({'choices': [{'message': {'content': content}}]}).encode()


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.provider = OpenAICompatibleProvider(api_key='test-secret', model='test-model',
                                                 base_url='http://127.0.0.1:9999/v1')
        self.task = Task('private', 'Find arithmetic expression', inputs=(987654.125,), expected=(876543.25,))

    async def test_payload_allowlist_no_private_oracle_leak(self):
        with patch.object(self.provider, '_request', return_value=Proposal('x')) as request:
            await self.provider.propose(self.task, 'independent', [{
                'artifact': 'x+1', 'status': 'failed', 'expected': 'hidden-expected',
                'inputs': 'hidden-inputs', 'evidence': 'hidden-evidence', 'api_key': 'hidden-key',
            }], 'Matched 0/1 evaluator cases', 123)
        encoded = request.call_args.args[0]
        body = json.loads(encoded)
        text = encoded.decode()
        for secret in ('987654.125', '876543.25', 'hidden-expected', 'hidden-inputs', 'hidden-evidence', 'hidden-key', 'test-secret'):
            self.assertNotIn(secret, text)
        self.assertEqual(body['max_tokens'], 123)
        self.assertEqual(body['model'], 'test-model')
        user = json.loads(body['messages'][1]['content'])
        self.assertEqual(user['untrusted_memories'], [{'artifact': 'x+1', 'status': 'failed'}])
        self.assertEqual(user['prompt'], self.task.prompt)

    async def test_invalid_token_caps_fail_before_transport(self):
        with patch.object(self.provider, '_request') as request:
            for cap in (True, 0, 8193, 1.5):
                with self.subTest(cap=cap), self.assertRaises(ValueError):
                    await self.provider.propose(self.task, 'direct', [], None, cap)
        request.assert_not_called()

    def mock_response(self, raw):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = raw
        self.provider._opener = Mock()
        self.provider._opener.open.return_value = response
        return response

    def test_parses_valid_json_and_sends_post_with_auth(self):
        response = self.mock_response(envelope(json.dumps({'artifact': 'x+1', 'rationale': 'simple'})))
        result = self.provider._request(b'{"model":"test"}')
        self.assertEqual((result.artifact, result.rationale), ('x+1', 'simple'))
        request = self.provider._opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.get_header('Authorization'), 'Bearer test-secret')
        response.read.assert_called_once_with(self.provider.MAX_RESPONSE_BYTES + 1)

    def test_rejects_malformed_missing_extra_empty_and_unbounded_responses(self):
        invalid = [b'not json', b'{}', b'{"choices":[]}',
                   envelope(None), envelope('```json\n{}\n```'), envelope('[]')]
        for content in ({'artifact': 'x'}, {'artifact': 'x', 'rationale': '', 'verified': True},
                        {'artifact': '', 'rationale': ''}, {'artifact': 3, 'rationale': ''},
                        {'artifact': 'x', 'rationale': None},
                        {'artifact': 'x' * 16385, 'rationale': ''},
                        {'artifact': 'x', 'rationale': 'r' * 8193}):
            invalid.append(envelope(json.dumps(content)))
        for raw in invalid:
            with self.subTest(raw=raw[:70]):
                self.mock_response(raw)
                with self.assertRaisesRegex(ValueError, 'bounded JSON'):
                    self.provider._request(b'{}')

    def test_response_byte_budget(self):
        self.mock_response(b'x' * (self.provider.MAX_RESPONSE_BYTES + 1))
        with self.assertRaisesRegex(ValueError, 'size limit'):
            self.provider._request(b'{}')

    def test_transport_errors_do_not_expose_secret_url_or_body(self):
        errors = [urllib.error.HTTPError('https://test-secret.invalid', 401, 'test-secret', {}, io.BytesIO(b'test-secret')),
                  urllib.error.URLError('https://test-secret.invalid'), TimeoutError('test-secret')]
        for error in errors:
            with self.subTest(error=type(error).__name__):
                self.provider._opener = Mock()
                self.provider._opener.open.side_effect = error
                with self.assertRaises(ValueError) as caught:
                    self.provider._request(b'{}')
                self.assertNotIn('test-secret', str(caught.exception))

    def test_redirect_handler_installed_and_rejects_redirect(self):
        handlers = self.provider._opener.handlers
        guards = [h for h in handlers if isinstance(h, _NoRedirect)]
        self.assertEqual(len(guards), 1)
        request = urllib.request.Request('https://example.invalid', headers={'Authorization': 'Bearer test-secret'})
        for code in (301, 302, 303, 307, 308):
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, 'redirects are disabled'):
                guards[0].redirect_request(request, None, code, 'redirect', {}, 'https://evil.invalid')

    def test_constructor_rejects_insecure_or_malformed_config(self):
        for url in ('http://example.com/v1', 'https://name:secret@example.com', 'https://example.com?q=secret',
                    'https://example.com/#secret', 'ftp://example.com', 'https://example.com:bad', ' https://example.com'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                OpenAICompatibleProvider(api_key='key', model='model', base_url=url)
        for kwargs in ({'api_key': ''}, {'api_key': 'key\r\nInjected: yes'}, {'model': ''},
                       {'timeout': float('nan')}, {'timeout': True}, {'timeout': 301}):
            config = {'api_key': 'key', 'model': 'model', **kwargs}
            with self.subTest(config=kwargs), self.assertRaises(ValueError):
                OpenAICompatibleProvider(**config)

    async def test_demo_uses_prompt_not_hidden_expected_values(self):
        demo = DemoProvider()
        a = Task('a', 'Compute 2*x + 1', inputs=(1,), expected=(3,))
        b = Task('b', 'Compute 2*x + 1', inputs=(1,), expected=(999,))
        for strategy in ('direct', 'alternative'):
            self.assertEqual(await demo.propose(a, strategy, [], None, 32),
                             await demo.propose(b, strategy, [], None, 32))
        unknown = Task('c', 'No expression here', inputs=(1,), expected=(9876,))
        self.assertEqual((await demo.propose(unknown, 'direct', [], None, 32)).artifact, '0')
