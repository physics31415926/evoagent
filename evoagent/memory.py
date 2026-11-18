"""SQLite provenance store; failed hypotheses never become verified knowledge."""
from contextlib import contextmanager
import json
from pathlib import Path
import re
import sqlite3
from .models import RunResult


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS memories (
                    id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
                    kind TEXT NOT NULL, prompt TEXT NOT NULL, artifact TEXT NOT NULL,
                    status TEXT NOT NULL, evidence TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS policies (
                    id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
            ''')

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def save_run(self, result: RunResult, prompt: str, kind: str):
        with self._connect() as db:
            db.execute("INSERT INTO runs VALUES (?, ?)", (result.run_id, json.dumps(result.to_dict(), ensure_ascii=False)))
            for attempt in result.attempts:
                if attempt.proposal is None or attempt.duplicate_of:
                    continue
                db.execute("INSERT INTO memories(run_id,task_id,kind,prompt,artifact,status,evidence) VALUES(?,?,?,?,?,?,?)",
                           (result.run_id, result.task_id, kind, prompt, attempt.proposal.artifact,
                            attempt.evidence.status, json.dumps(attempt.evidence.__dict__, ensure_ascii=False)))

    def list_memories(self, limit: int = 20) -> list[dict]:
        with self._connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM memories ORDER BY id DESC LIMIT ?", (limit,))]

    def retrieve(self, prompt: str, kind: str, limit: int = 5) -> list[dict]:
        tokens = set(re.findall(r"\w+", prompt.lower()))
        rows = [r for r in self.list_memories(500) if r["kind"] == kind]
        def overlap(row):
            return len(tokens & set(re.findall(r"\w+", row["prompt"].lower())))
        rows = [r for r in rows if overlap(r) > 0]
        return sorted(rows, key=overlap, reverse=True)[:limit]

    def archive_policy(self, report: dict):
        with self._connect() as db:
            db.execute("INSERT INTO policies(payload) VALUES(?)", (json.dumps(report, ensure_ascii=False),))
