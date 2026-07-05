"""Memory retrieval eval harness — load frozen fixtures, score a retriever's
output against ground truth (design §十 P0: fixed question set + human ground
truth + tamper-evident).

The harness itself is pure (YAML → dataclasses → metric dict). It does NOT touch
the DB or run retrieval — that's the caller's job (tests/eval/test_memory_retrieval.py
seeds events via EventsRepository against the test DB, runs the real
events_search, and hands the ranked ids here). Keeping the harness DB-free means
the fixture format + scoring are unit-testable in isolation, and the same harness
can score any retriever (structured, semantic, a future re-ranker).

Ground truth lives in fixtures/*.yaml and is checked in. Treat those files as the
answer key: changing an `expected` list changes the eval's verdict, so a fixture
diff must get the same scrutiny as changing a test assertion. The harness records
a sha256 of each fixture's ground-truth so a silent edit is visible in the run
output (tamper-evidence, not tamper-proofing — the point is reviewers can SEE it).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from . import metrics

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@dataclass(frozen=True)
class EvalQuery:
    """One retrieval probe + its ground-truth relevant ids."""

    name: str
    # Retrieval params handed to the retriever (event_type / since / until / q /
    # status / limit). The harness is retriever-agnostic — the caller maps these
    # onto search_structured / search_semantic.
    params: dict[str, Any]
    expected_ids: list[str]  # ground-truth relevant ids (order = ideal ranking)
    # Per-query metric thresholds the run must meet (regression gate). Keys are
    # metric names ("recall@k" / "precision@k" / "mrr" / "ndcg@k"); the @k suffix
    # is parsed out. Empty = report-only (no gate).
    thresholds: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class EvalFixture:
    name: str
    description: str
    seed_events: list[dict[str, Any]]  # AppendEventInput kwargs (curated/etc.)
    queries: list[EvalQuery]
    ground_truth_sha: str  # sha256 of the (queries → expected_ids) answer key

    @classmethod
    def from_yaml(cls, path: Path) -> EvalFixture:
        raw = yaml.safe_load(path.read_text())
        queries = [
            EvalQuery(
                name=q["name"],
                params=q.get("params", {}),
                expected_ids=list(q.get("expected_ids", [])),
                thresholds=q.get("thresholds", {}),
            )
            for q in raw.get("queries", [])
        ]
        answer_key = {q.name: q.expected_ids for q in queries}
        sha = hashlib.sha256(
            json.dumps(answer_key, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()[:16]
        return cls(
            name=raw["name"],
            description=raw.get("description", ""),
            seed_events=list(raw.get("seed_events", [])),
            queries=queries,
            ground_truth_sha=sha,
        )


def load_fixtures(directory: Path = FIXTURES_DIR) -> list[EvalFixture]:
    """All *.yaml fixtures, sorted by name (deterministic run order)."""
    return sorted(
        (EvalFixture.from_yaml(p) for p in directory.glob("*.yaml")),
        key=lambda f: f.name,
    )


# Default k for any metric whose name omits "@k" (e.g. bare "recall").
_DEFAULT_K = 10


def _parse_metric(name: str) -> tuple[str, int]:
    """ "recall@5" → ("recall", 5); "mrr" → ("mrr", _DEFAULT_K)."""
    if "@" in name:
        base, k = name.split("@", 1)
        return base.strip(), int(k)
    return name.strip(), _DEFAULT_K


_METRIC_FNS = {
    "recall": metrics.recall_at_k,
    "precision": metrics.precision_at_k,
    "ndcg": metrics.ndcg_at_k,
}


def score_query(ranked: list[str], query: EvalQuery) -> dict[str, float]:
    """Score one retriever output (ranked ids, best-first) against the query's
    ground truth. Returns {metric_name: value} for every threshold key (so the
    gate has something to compare) plus the always-useful recall@k / mrr."""
    relevant = set(query.expected_ids)
    wanted = set(query.thresholds) | {f"recall@{_DEFAULT_K}", "mrr"}
    out: dict[str, float] = {}
    for metric_name in wanted:
        base, k = _parse_metric(metric_name)
        if base == "mrr":
            out[metric_name] = metrics.mrr(ranked, relevant)
        elif base in _METRIC_FNS:
            out[metric_name] = _METRIC_FNS[base](ranked, relevant, k)
    return out


@dataclass
class QueryResult:
    query: str
    metrics: dict[str, float]
    failures: list[str]  # threshold keys that came in under target


def evaluate(ranked: list[str], query: EvalQuery) -> QueryResult:
    """score_query + apply the query's regression thresholds → list any misses."""
    scored = score_query(ranked, query)
    failures = [
        f"{name}={scored.get(name, 0.0):.3f} < {target:.3f}"
        for name, target in query.thresholds.items()
        if scored.get(name, 0.0) + 1e-9 < target
    ]
    return QueryResult(query=query.name, metrics=scored, failures=failures)
