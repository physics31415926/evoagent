import unittest

from evoagent.models import Policy, Proposal, Task
from evoagent.verifiers import ExpressionVerifier


class VerifierTests(unittest.TestCase):
    def setUp(self):
        self.verifier = ExpressionVerifier()
        self.task = Task('identity', 'Return x', inputs=(-2, 0, 3), expected=(-2, 0, 3))

    def test_supported_arithmetic(self):
        for expression in ('x', '+x', '-(-x)', '(x * 2 + 0) / 2', 'x-0'):
            with self.subTest(expression=expression):
                self.assertEqual(self.verifier.verify(self.task, Proposal(expression)).status, 'passed')

    def test_arbitrary_code_pow_nonfinite_and_unbounded_values_rejected(self):
        forbidden = [
            "__import__('os').system('echo unsafe')", 'open("unsafe", "w")',
            'x.__class__', '[x for x in (1, 2)]', 'lambda: x', 'x[0]',
            '2**100', 'pow(x, 2)', 'NaN', 'nan', 'float("nan")',
            '1e309', '1e12 * 1e12', '1/0', 'True', '"x"',
            'x; print(1)', 'x=' , 'x' * 513,
        ]
        for expression in forbidden:
            with self.subTest(expression=expression):
                evidence = self.verifier.verify(self.task, Proposal(expression))
                self.assertEqual(evidence.status, 'failed')
                self.assertTrue(evidence.details.startswith('Rejected:'))

    def test_node_budget(self):
        result = self.verifier.verify(self.task, Proposal('+'.join(['x'] * 30)))
        self.assertEqual(result.status, 'failed')
        self.assertIn('Rejected:', result.details)

    def test_nan_input_cannot_pass(self):
        task = Task('nan', 'Return x', inputs=(float('nan'),), expected=(float('nan'),))
        self.assertEqual(self.verifier.verify(task, Proposal('x')).status, 'failed')

    def test_feedback_does_not_expose_expected_values(self):
        task = Task('private', 'Find expression', inputs=(12345,), expected=(67890,))
        evidence = self.verifier.verify(task, Proposal('0'))
        self.assertEqual(evidence.details, 'Matched 0/1 evaluator cases')
        self.assertNotIn('67890', evidence.details)


class ModelTests(unittest.TestCase):
    def test_policy_rejects_invalid_caps(self):
        for changes in ({'max_calls': 0}, {'max_rounds': True}, {'concurrency': 17},
                        {'max_tokens': 8193}, {'strategies': ()}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                Policy(**changes)

    def test_policy_id_deterministic_and_sensitive(self):
        self.assertEqual(Policy().id, Policy().id)
        self.assertNotEqual(Policy().id, Policy(max_calls=5).id)

    def test_expression_task_requires_evaluation_cases(self):
        for inputs, expected in (((), ()), ((1,), ()), ((1,), (1, 2))):
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                Task('invalid', 'Find x', inputs=inputs, expected=expected)
