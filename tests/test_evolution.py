from pathlib import Path
import tempfile
import unittest

from evoagent.evolution import EvolutionLab
from evoagent.memory import Store
from evoagent.models import Policy, Proposal, Task


class EvaluationProvider:
    def __init__(self, regression=False):
        self.memories = []
        self.regression = regression

    async def propose(self, task, strategy, memories, feedback, max_tokens):
        self.memories.append(list(memories))
        success = strategy == ('baseline' if self.regression else 'candidate')
        return Proposal('x' if success else '0')


class EvolutionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name) / 'archive.sqlite3')
        self.tasks = [Task('a', 'Return x', inputs=(1,), expected=(1,)),
                      Task('b', 'Return x again', inputs=(2,), expected=(2,))]
        self.baseline = Policy(strategies=('baseline',), max_calls=2)
        self.candidate = Policy(strategies=('candidate',), max_calls=2)

    async def test_unequal_caps_rejected_before_provider_calls(self):
        provider = EvaluationProvider()
        lab = EvolutionLab(provider, self.store)
        for changes in ({'max_calls': 1}, {'max_tokens': 128}):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'equal'):
                await lab.compare(self.tasks, self.baseline, Policy(**changes))
        self.assertEqual(provider.memories, [])

    async def test_regression_keeps_baseline_and_never_activates(self):
        report = await EvolutionLab(EvaluationProvider(regression=True), self.store).compare(
            self.tasks, self.baseline, self.candidate)
        self.assertEqual(report['regressions'], ['a', 'b'])
        self.assertEqual(report['recommendation'], 'keep_baseline')
        self.assertIs(report['activated'], False)

    async def test_improvement_is_review_only_and_memory_isolated_per_task_and_arm(self):
        provider = EvaluationProvider()
        report = await EvolutionLab(provider, self.store).compare(self.tasks, self.baseline, self.candidate)
        self.assertEqual(report['recommendation'], 'review_candidate')
        self.assertIs(report['activated'], False)
        self.assertTrue(provider.memories)
        self.assertTrue(all(memories == [] for memories in provider.memories))
        self.assertEqual(self.store.list_memories(), [])
        with self.store._connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM policies').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM runs').fetchone()[0], 0)

    async def test_suite_validation(self):
        lab = EvolutionLab(EvaluationProvider(), self.store)
        for tasks in ([], [self.tasks[0], self.tasks[0]], [Task('r', 'Research', kind='research')]):
            with self.subTest(tasks=tasks), self.assertRaises(ValueError):
                await lab.compare(tasks, self.baseline, self.candidate)
