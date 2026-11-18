"""Command-line interface. All result and error output is JSON."""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
from pathlib import Path
from typing import Any

from .models import Policy, Task
from .providers import DemoProvider, OpenAICompatibleProvider


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(message)


def _parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="evoagent", description="Evidence-driven agent experiment (offline demo available)")
    parser.add_argument("--state", default=".evoagent/state.sqlite3", help="SQLite state path")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("demo", "Run the deterministic offline expression demo"),
        ("run", "Run one JSON task"),
        ("evolve", "Compare policies without activating either"),
        ("memory", "List saved memories"),
    ):
        sub = commands.add_parser(name, help=help_text)
        # Also accept --state after the command without overriding a global value.
        sub.add_argument("--state", default=argparse.SUPPRESS, help="SQLite state path")
        if name in ("run", "evolve"):
            sub.add_argument("--provider", choices=("demo", "openai"), default="demo")
        if name == "run":
            sub.add_argument("--task", required=True, help="Path to a JSON task object")
        if name == "evolve":
            sub.add_argument("--tasks", required=True, help="Path to a JSON task list")
        if name == "memory":
            sub.add_argument("--limit", type=int, default=20)
    return parser


def _task(data: Any) -> Task:
    if not isinstance(data, dict) or set(data) - {"id", "prompt", "kind", "inputs", "expected"}:
        raise ValueError("Task must be an object with id, prompt, kind, inputs and expected fields only")
    for name in ("id", "prompt"):
        if not isinstance(data.get(name), str) or not data[name].strip():
            raise ValueError(f"Task {name} must be a nonempty string")
    kind = data.get("kind", "expression")
    if not isinstance(kind, str) or not kind.strip():
        raise ValueError("Task kind must be a nonempty string")
    numbers = {}
    for key in ("inputs", "expected"):
        values = data.get(key, [])
        if not isinstance(values, list) or len(values) > 1000:
            raise ValueError(f"Task {key} must be a list of at most 1000 finite numbers")
        if any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
            raise ValueError(f"Task {key} must contain finite numbers")
        numbers[key] = tuple(values)
    return Task(id=data["id"], prompt=data["prompt"], kind=kind, **numbers)


def _load(path: str) -> Any:
    source = Path(path)
    if source.stat().st_size > 1_048_576:
        raise ValueError("Task file exceeds 1 MiB size limit")
    return json.loads(source.read_text(encoding="utf-8-sig"))


async def _execute(args: argparse.Namespace) -> dict[str, Any] | list[Any]:
    from .engine import Engine
    from .memory import Store
    from .verifiers import ExpressionVerifier, UnverifiedVerifier
    from .evolution import EvolutionLab

    if args.command == "memory" and not 1 <= args.limit <= 1000:
        raise ValueError("Memory limit must be from 1 to 1000")
    provider = None
    if args.command != "memory":
        provider = OpenAICompatibleProvider() if getattr(args, "provider", "demo") == "openai" else DemoProvider()
    # Validate files and tasks before creating a database or contacting a model.
    task = None
    tasks = None
    if args.command == "demo":
        task = Task("linear-demo", "Compute 2*x + 1", inputs=(-2, 0, 3), expected=(-3, 1, 7))
    elif args.command == "run":
        task = _task(_load(args.task))
    elif args.command == "evolve":
        data = _load(args.tasks)
        if not isinstance(data, list) or not data or len(data) > 100:
            raise ValueError("Evolution tasks must be a nonempty JSON list of at most 100 tasks")
        tasks = [_task(item) for item in data]
    store = Store(args.state)
    try:
        if args.command == "memory":
            return {"memories": store.list_memories(limit=args.limit)}
        if args.command == "evolve":
            baseline = Policy(strategies=("direct",))
            candidate = Policy()
            return await EvolutionLab(provider, store).compare(tasks, baseline, candidate)
        verifier = ExpressionVerifier() if task.kind == "expression" else UnverifiedVerifier()
        result = await Engine(provider, verifier, store, policy=Policy()).run(task)
        return result.to_dict()
    finally:
        close = getattr(store, "close", None)
        if callable(close):
            close()


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
        output = asyncio.run(_execute(args))
        print(json.dumps(output, ensure_ascii=False, allow_nan=False))
        return 0
    except KeyboardInterrupt:
        print(json.dumps({"error": "Interrupted"}), file=sys.stderr)
        return 2
    except Exception as exc:
        # Errors must never leak a provider credential, even when an OS error
        # embeds a filename supplied by the caller.
        import os
        message = str(exc)
        secret = os.environ.get("EVO_API_KEY", "")
        if secret:
            message = message.replace(secret, "[REDACTED]")
        print(json.dumps({"error": message}, ensure_ascii=False), file=sys.stderr)
        return 2
