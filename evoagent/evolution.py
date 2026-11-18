"""Offline policy comparison, not autonomous deployment or proof of RSI."""
from dataclasses import asdict
from .engine import Engine
from .models import Policy, Task
from .verifiers import ExpressionVerifier


class EvolutionLab:
    def __init__(self, provider, store):
        self.provider, self.store = provider, store

    async def compare(self, tasks: list[Task], baseline: Policy, candidate: Policy) -> dict:
        if not tasks or len({t.id for t in tasks}) != len(tasks):
            raise ValueError("Need nonempty tasks with distinct IDs")
        if any(t.kind != "expression" for t in tasks):
            raise ValueError("MVP policy evaluation requires verifiable expression tasks")
        if baseline.max_calls != candidate.max_calls or baseline.max_tokens != candidate.max_tokens:
            raise ValueError("Compare policies with equal call and per-call token caps")
        # Isolated memory per arm prevents the second arm benefiting from first-arm solutions.
        import tempfile
        from pathlib import Path
        from .memory import Store
        arms = {}
        with tempfile.TemporaryDirectory(prefix="evo-evaluation-", dir=self.store.path.parent) as root:
            for label, policy in (("baseline", baseline), ("candidate", candidate)):
                results = []
                # Each task gets a fresh store: no within-suite answer leakage either.
                for index, task in enumerate(tasks):
                    store = Store(Path(root) / f"{label}-{index}.sqlite3")
                    result = await Engine(self.provider, ExpressionVerifier(), store, policy).run(task)
                    results.append(result.to_dict())
                arms[label] = {"policy": asdict(policy), "policy_id": policy.id,
                               "passed": sum(r["status"] == "passed" for r in results),
                               "calls": sum(r["calls"] for r in results), "runs": results}
        old, new = arms["baseline"], arms["candidate"]
        regressions = [t.id for t, a, b in zip(tasks, old["runs"], new["runs"])
                       if a["status"] == "passed" and b["status"] != "passed"]
        promising = not regressions and (new["passed"] > old["passed"] or
                     (new["passed"] == old["passed"] and new["calls"] < old["calls"]))
        report = {"arms": arms, "regressions": regressions,
                  "recommendation": "review_candidate" if promising else "keep_baseline",
                  "activated": False,
                  "limitations": "Development-suite evidence only. Equal caps, not equal realized tokens/cost. Require repeated trials, separate holdout and human review."}
        self.store.archive_policy(report)
        return report
