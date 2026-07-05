"""Retrieval metrics for the memory eval regression set (design §十 P0).

Pure functions over a ranked result list + a ground-truth relevant set. No DB,
no I/O — the harness (harness.py) seeds events, runs the real retrieval, and
feeds the ranked ids here. Kept separate so the metric definitions are trivially
unit-testable and frozen (the eval is only meaningful if the scoring can't drift).

All take:
  ranked   — the retrieved ids, best-first (what events_search returned).
  relevant — the ground-truth relevant ids (the fixture's expected set).
"""

from __future__ import annotations

import math


def recall_at_k(ranked: list[str], relevant: set[str], k: int) -> float:
    """Fraction of the relevant set that appears in the top-k. 1.0 = every
    expected id surfaced within k. The headline "did we find it" metric."""
    if not relevant:
        return 1.0
    topk = set(ranked[:k])
    return len(topk & relevant) / len(relevant)


def precision_at_k(ranked: list[str], relevant: set[str], k: int) -> float:
    """Fraction of the top-k that is relevant. Guards against a retriever that
    pads the top-k with noise to inflate recall."""
    if k <= 0:
        return 0.0
    topk = ranked[:k]
    if not topk:
        return 0.0
    hits = sum(1 for r in topk if r in relevant)
    return hits / len(topk)


def mrr(ranked: list[str], relevant: set[str]) -> float:
    """Mean reciprocal rank — 1/(rank of the first relevant hit). Rewards putting
    a relevant result FIRST (the ranking quality, not just presence). 0.0 if no
    relevant id is in the list."""
    for i, r in enumerate(ranked, start=1):
        if r in relevant:
            return 1.0 / i
    return 0.0


def ndcg_at_k(ranked: list[str], relevant: set[str], k: int) -> float:
    """Normalized DCG@k with binary relevance. Discounts hits by log2(rank+1) so
    a relevant id ranked 2nd counts less than 1st; normalized by the ideal
    ordering so 1.0 = the best achievable arrangement of the relevant ids."""
    if not relevant:
        return 1.0
    dcg = sum(1.0 / math.log2(i + 1) for i, r in enumerate(ranked[:k], start=1) if r in relevant)
    ideal_hits = min(len(relevant), k)
    idcg = sum(1.0 / math.log2(i + 1) for i in range(1, ideal_hits + 1))
    return dcg / idcg if idcg > 0 else 0.0
