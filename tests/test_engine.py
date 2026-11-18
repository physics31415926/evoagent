"""Offline orchestration and provenance contracts; no API access."""
import asyncio
import json
from pathlib import Path
import tempfile
import unittest

from evoagent.engine import Engine
from evoagent.memory import Store
from evoagent.models import Policy, Proposal, Task
from evoagent.verifiers import ExpressionVerifier


class ScriptedProvider:
    def __init__(self, callback):
        self.callback = callback
        self.calls = []
        self.active = self.peak = 0

    async def propose(self, task, strategy, memories, feedback, max_tokens):
        self.calls.append((strategy, feedback, max_tokens, list(memories)))
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            # A scheduling yield makes overlap deterministic without wall-clock assertions.
            await asyncio.sleep(0)
            return self.callback(task, strategy, feedback)
        finally:
            self.active -= 1


class EngineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name) / 'state.sqlite3')
        self.task = Task('linear', 'Compute 2*x + 1', inputs=(0, 2), expected=(1, 5))

    async def run_engine(self, provider, policy):
        return await Engine(provider, ExpressionVerifier(), self.store, policy).run(self.task)

    async def test_repair_links_parent_and_receives_feedback(self):
        provider = ScriptedProvider(lambda t, s, f: Proposal('2*x+1' if f else '2*x'))
        result = await self.run_engine(provider, Policy(strategies=('direct',), max_calls=2))
        self.assertEqual(result.status, 'passed')
        first, repair = result.attempts
        self.assertIsNone(first.parent_id)
        self.assertEqual(repair.parent_id, first.id)
        self.assertEqual((first.round, repair.round), (0, 1))
        self.assertIn('2*x', provider.calls[1][1])
        self.assertIn('Matched', provider.calls[1][1])

    async def test_concurrency_call_and_token_caps(self):
        provider = ScriptedProvider(lambda t, s, f: Proposal(str(len(s))))
        policy = Policy(strategies=('a', 'bb', 'ccc', 'dddd', 'eeeee'),
                        concurrency=2, max_calls=7, max_rounds=10, max_tokens=37)
        result = await self.run_engine(provider, policy)
        self.assertEqual(result.calls, 7)
        self.assertEqual(len(provider.calls), 7)
        self.assertEqual(provider.peak, 2)
        self.assertTrue(all(c[2] == 37 for c in provider.calls))

    async def test_budget_smaller_than_initial_frontier(self):
        provider = ScriptedProvider(lambda t, s, f: Proposal('0'))
        result = await self.run_engine(provider, Policy(max_calls=1))
        self.assertEqual((result.calls, len(result.attempts)), (1, 1))

    async def test_provider_error_isolated_and_secret_not_persisted(self):
        def callback(task, strategy, feedback):
            if strategy == 'broken':
                raise RuntimeError('secret-token https://private.invalid')
            return Proposal('2*x+1')
        result = await self.run_engine(ScriptedProvider(callback), Policy(strategies=('broken', 'good')))
        self.assertEqual(result.status, 'passed')
        self.assertEqual(result.attempts[0].evidence.details, 'Branch error: RuntimeError')
        self.assertNotIn('secret-token', json.dumps(result.to_dict()))

    async def test_verifier_error_does_not_cancel_other_branch(self):
        class SometimesBrokenVerifier(ExpressionVerifier):
            def verify(self, task, proposal):
                if proposal.artifact == 'broken':
                    raise RuntimeError('verifier failure')
                return super().verify(task, proposal)
        provider = ScriptedProvider(lambda t, s, f: Proposal(s))
        result = await Engine(provider, SometimesBrokenVerifier(), self.store,
                              Policy(strategies=('broken', '2*x+1'))).run(self.task)
        self.assertEqual(result.status, 'passed')
        self.assertEqual(result.attempts[0].evidence.verifier, 'engine')

    async def test_duplicate_merging_avoids_duplicate_repair_and_memory(self):
        provider = ScriptedProvider(lambda t, s, f: Proposal(' 0 ' if s == 'b' else '0'))
        result = await self.run_engine(provider, Policy(strategies=('a', 'b'), max_calls=6, max_rounds=3))
        self.assertEqual(result.calls, 3)
        self.assertEqual(result.attempts[1].duplicate_of, result.attempts[0].id)
        self.assertEqual(result.attempts[2].parent_id, result.attempts[0].id)
        self.assertEqual(result.attempts[2].duplicate_of, result.attempts[0].id)
        self.assertEqual(len(self.store.list_memories()), 1)

    async def test_known_failed_answer_is_never_returned(self):
        result = await self.run_engine(ScriptedProvider(lambda t, s, f: Proposal('0')), Policy())
        self.assertEqual(result.status, 'failed')
        self.assertIsNone(result.answer)

    async def test_unknown_task_remains_unverified_despite_consensus(self):
        task = Task('research', 'Discuss an unknown claim', kind='research')
        provider = ScriptedProvider(lambda t, s, f: Proposal('confident consensus'))
        result = await Engine(provider, ExpressionVerifier(), self.store, Policy()).run(task)
        self.assertEqual(result.status, 'unverified')
        self.assertEqual(result.answer, 'confident consensus')
        self.assertTrue(all(a.evidence.status == 'unverified' for a in result.attempts))
        self.assertEqual(result.calls, 3)  # Unverified claims do not spawn repairs.

    async def test_sqlite_retrieval_retains_provenance_and_failed_status(self):
        result = await self.run_engine(ScriptedProvider(lambda t, s, f: Proposal('0')), Policy(max_calls=1))
        reopened = Store(self.store.path)
        rows = reopened.retrieve('Compute linear expression', 'expression')
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row['run_id'], result.run_id)
        self.assertEqual(row['task_id'], self.task.id)
        self.assertEqual(row['status'], 'failed')
        self.assertEqual(json.loads(row['evidence'])['verifier'], ExpressionVerifier.name)
        self.assertEqual(reopened.retrieve('Compute linear expression', 'research'), [])
        self.assertEqual(reopened.retrieve('unrelatedword', 'expression'), [])
        later = await self.run_engine(ScriptedProvider(lambda t, s, f: Proposal('2*x+1')), Policy(max_calls=1))
        self.assertEqual(later.retrieved[0]['run_id'], result.run_id)
