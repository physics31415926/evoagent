import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from evoagent.cli import main


class CLITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / 'state.sqlite3'

    def invoke(self, args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main(args)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_demo_and_memory_print_valid_json(self):
        code, output, error = self.invoke(['demo', '--state', str(self.state)])
        self.assertEqual((code, error), (0, ''))
        result = json.loads(output)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['answer'], '2*x+1')
        code, output, error = self.invoke(['--state', str(self.state), 'memory', '--limit', '2'])
        self.assertEqual((code, error), (0, ''))
        self.assertLessEqual(len(json.loads(output)['memories']), 2)

    def test_unknown_task_cli_remains_unverified(self):
        source = self.root / 'task.json'
        source.write_text(json.dumps({'id': 'unknown', 'prompt': 'Research a claim', 'kind': 'research'}), encoding='utf-8')
        code, output, error = self.invoke(['run', '--task', str(source), '--state', str(self.state)])
        self.assertEqual((code, error), (0, ''))
        self.assertEqual(json.loads(output)['status'], 'unverified')

    def test_invalid_task_no_state_created(self):
        source = self.root / 'invalid.json'
        for value in (float('nan'), True, '1'):
            source.write_text(json.dumps({'id': 'bad', 'prompt': 'Find x', 'inputs': [value], 'expected': [1]}), encoding='utf-8')
            code, output, error = self.invoke(['run', '--task', str(source), '--state', str(self.state)])
            self.assertEqual((code, output), (2, ''))
            self.assertIn('error', json.loads(error))
            self.assertFalse(self.state.exists())

    def test_argument_errors_are_json_and_redact_api_secret(self):
        with patch.dict(os.environ, {'EVO_API_KEY': 'secret-for-test'}):
            code, output, error = self.invoke(['secret-for-test'])
        self.assertEqual((code, output), (2, ''))
        self.assertNotIn('secret-for-test', error)
        self.assertIn('[REDACTED]', json.loads(error)['error'])
