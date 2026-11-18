"""Shared contracts. Model output is untrusted; only verifiers set evidence."""
from dataclasses import dataclass, field, asdict
from typing import Any, Protocol
import hashlib
import json


@dataclass(frozen=True)
class Task:
    id: str
    prompt: str
    kind: str = "expression"
    inputs: tuple[float, ...] = ()
    expected: tuple[float, ...] = ()

    def __post_init__(self):
        if not self.id or not self.prompt:
            raise ValueError("Task id and prompt are required")
        if self.kind == "expression" and (not self.inputs or len(self.inputs) != len(self.expected)):
            raise ValueError("Expression tasks require matching nonempty inputs and expected")


@dataclass(frozen=True)
class Policy:
    strategies: tuple[str, ...] = ("direct", "alternative", "counterexample")
    max_calls: int = 6
    max_rounds: int = 2
    concurrency: int = 3
    max_tokens: int = 512

    def __post_init__(self):
        if not self.strategies or any(not isinstance(s, str) or not s for s in self.strategies):
            raise ValueError("At least one nonempty strategy required")
        if any(type(v) is not int or v < 1 for v in (self.max_calls, self.max_rounds, self.concurrency, self.max_tokens)):
            raise ValueError("Policy budgets must be positive integers")
        if self.max_calls > 100 or self.concurrency > 16 or self.max_rounds > 20 or self.max_tokens > 8192:
            raise ValueError("Policy exceeds MVP safety limits")

    @property
    def id(self) -> str:
        return hashlib.sha256(json.dumps(asdict(self), sort_keys=True).encode()).hexdigest()[:16]


@dataclass(frozen=True)
class Proposal:
    artifact: str
    rationale: str = ""


@dataclass(frozen=True)
class Evidence:
    status: str  # passed / failed / unverified
    score: float
    details: str
    verifier: str


@dataclass
class Attempt:
    id: str
    parent_id: str | None
    strategy: str
    round: int
    proposal: Proposal | None
    evidence: Evidence
    duplicate_of: str | None = None


@dataclass
class RunResult:
    run_id: str
    task_id: str
    policy_id: str
    status: str
    answer: str | None
    attempts: list[Attempt]
    calls: int
    retrieved: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class Provider(Protocol):
    async def propose(self, task: Task, strategy: str, memories: list[dict[str, Any]],
                      feedback: str | None, max_tokens: int) -> Proposal: ...


class Verifier(Protocol):
    def verify(self, task: Task, proposal: Proposal) -> Evidence: ...
