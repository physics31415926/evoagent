"""Budgeted parallel exploration, evidence-gated selection and repair branches."""
import asyncio
from uuid import uuid4
from .models import Task, Policy, Proposal, Evidence, Attempt, RunResult, Provider, Verifier
from .memory import Store


class Engine:
    def __init__(self, provider: Provider, verifier: Verifier, store: Store, policy: Policy = Policy()):
        self.provider, self.verifier, self.store, self.policy = provider, verifier, store, policy

    async def run(self, task: Task) -> RunResult:
        memories = self.store.retrieve(task.prompt, task.kind)
        attempts: list[Attempt] = []
        seen: dict[str, Attempt] = {}
        calls = 0
        frontier: list[tuple[str, str | None, str | None]] = [(s, None, None) for s in self.policy.strategies]
        semaphore = asyncio.Semaphore(self.policy.concurrency)

        async def explore(strategy, parent_id, feedback, round_no):
            async with semaphore:
                try:
                    proposal = await self.provider.propose(task, strategy, memories, feedback, self.policy.max_tokens)
                    if not isinstance(proposal, Proposal) or not isinstance(proposal.artifact, str) or not proposal.artifact.strip():
                        raise ValueError("Invalid proposal")
                    if len(proposal.artifact) > 16000 or len(proposal.rationale) > 16000:
                        raise ValueError("Proposal exceeds size budget")
                    evidence = self.verifier.verify(task, proposal)
                    return Attempt(uuid4().hex, parent_id, strategy, round_no, proposal, evidence)
                except Exception as exc:
                    # Do not persist provider exception text: it may contain URLs or credentials.
                    return Attempt(uuid4().hex, parent_id, strategy, round_no, None,
                                   Evidence("failed", 0.0, f"Branch error: {type(exc).__name__}", "engine"))

        for round_no in range(self.policy.max_rounds):
            batch = frontier[:self.policy.max_calls - calls]
            if not batch:
                break
            calls += len(batch)
            results = await asyncio.gather(*(explore(s, p, f, round_no) for s, p, f in batch))
            for attempt in results:
                if attempt.proposal is not None:
                    key = attempt.proposal.artifact.strip()
                    if key in seen:
                        attempt.duplicate_of = seen[key].id
                    else:
                        seen[key] = attempt
                attempts.append(attempt)
            if any(a.evidence.status == "passed" for a in attempts):
                break
            # Each failed unique route may spawn a repair; unverified text is never treated as failed truth.
            frontier = [(a.strategy, a.id,
                         f"Previous candidate (untrusted): {a.proposal.artifact}\nVerifier: {a.evidence.details}")
                        for a in sorted(results, key=lambda a: a.evidence.score, reverse=True)
                        if a.proposal is not None and a.evidence.status == "failed" and not a.duplicate_of]
        passed = [a for a in attempts if a.evidence.status == "passed" and not a.duplicate_of]
        unverified = [a for a in attempts if a.evidence.status == "unverified" and a.proposal is not None]
        # Never return a known-failed candidate as an answer.
        selected = passed[0] if passed else (unverified[0] if unverified else None)
        result = RunResult(uuid4().hex, task.id, self.policy.id,
                           "passed" if passed else ("unverified" if unverified else "failed"),
                           selected.proposal.artifact if selected else None, attempts, calls, memories)
        self.store.save_run(result, task.prompt, task.kind)
        return result
