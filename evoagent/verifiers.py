"""Bounded arithmetic interpreter: never eval/exec model-generated code."""
import ast
import math
from .models import Task, Proposal, Evidence


class ExpressionVerifier:
    name = "bounded-arithmetic-v1"

    def verify(self, task: Task, proposal: Proposal) -> Evidence:
        if task.kind != "expression":
            return Evidence("unverified", 0.0, "Unsupported task kind", self.name)
        try:
            if len(proposal.artifact) > 512:
                raise ValueError("Expression exceeds 512 characters")
            tree = ast.parse(proposal.artifact, mode="eval")
            if len(list(ast.walk(tree))) > 80:
                raise ValueError("Expression exceeds node budget")
            values = [self._value(tree.body, x) for x in task.inputs]
            matches = [math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)
                       for a, b in zip(values, task.expected)]
            passed = all(matches)
            # No hidden expected outputs in repair feedback.
            return Evidence("passed" if passed else "failed", sum(matches) / len(matches),
                            f"Matched {sum(matches)}/{len(matches)} evaluator cases", self.name)
        except (ValueError, SyntaxError, TypeError, ArithmeticError, RecursionError) as exc:
            return Evidence("failed", 0.0, f"Rejected: {type(exc).__name__}", self.name)

    def _value(self, node: ast.AST, x: float) -> float:
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            value = node.value
        elif isinstance(node, ast.Name) and node.id == "x":
            value = x
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = self._value(node.operand, x)
            if isinstance(node.op, ast.USub):
                value = -value
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
            a, b = self._value(node.left, x), self._value(node.right, x)
            if isinstance(node.op, ast.Add):
                value = a + b
            elif isinstance(node.op, ast.Sub):
                value = a - b
            elif isinstance(node.op, ast.Mult):
                value = a * b
            else:
                value = a / b
        else:
            raise ValueError("Unsupported expression node")
        if not math.isfinite(value) or abs(value) > 1e12:
            raise ValueError("Value outside numeric bounds")
        return float(value)


class UnverifiedVerifier:
    def verify(self, task: Task, proposal: Proposal) -> Evidence:
        return Evidence("unverified", 0.0, "Human or domain verifier required; consensus is not evidence", "none")
