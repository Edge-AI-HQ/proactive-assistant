"""Unit tests for the eval metrics (pure functions). The eval is only meaningful
if the scoring can't silently drift — so the metric definitions get frozen tests.
No DB; runs in the default pytest collection."""

from __future__ import annotations

import math

from tests.eval.memory import metrics


def test_recall_at_k_full_and_partial():
    assert metrics.recall_at_k(["a", "b", "c"], {"a", "b"}, 3) == 1.0
    assert metrics.recall_at_k(["a", "x", "y"], {"a", "b"}, 3) == 0.5
    # outside the window doesn't count
    assert metrics.recall_at_k(["x", "y", "a"], {"a"}, 2) == 0.0
    # empty relevant set = vacuously perfect
    assert metrics.recall_at_k(["a"], set(), 3) == 1.0


def test_precision_at_k():
    assert metrics.precision_at_k(["a", "b"], {"a", "b"}, 2) == 1.0
    assert metrics.precision_at_k(["a", "x"], {"a"}, 2) == 0.5
    # fewer results than k → divide by actual top-k length, not k
    assert metrics.precision_at_k(["a"], {"a"}, 5) == 1.0
    assert metrics.precision_at_k([], {"a"}, 5) == 0.0


def test_mrr_rewards_first_hit():
    assert metrics.mrr(["a", "b"], {"a"}) == 1.0  # first
    assert metrics.mrr(["x", "a"], {"a"}) == 0.5  # second → 1/2
    assert metrics.mrr(["x", "y", "a"], {"a"}) == 1.0 / 3
    assert metrics.mrr(["x", "y"], {"a"}) == 0.0  # absent


def test_ndcg_at_k_ideal_and_discounted():
    # both relevant, ranked 1st & 2nd = ideal ordering = 1.0
    assert metrics.ndcg_at_k(["a", "b"], {"a", "b"}, 2) == 1.0
    # one relevant ranked 2nd while a noise item leads: dcg discounted vs ideal
    score = metrics.ndcg_at_k(["x", "a"], {"a"}, 2)
    assert 0.0 < score < 1.0
    assert math.isclose(score, (1.0 / math.log2(3)) / (1.0 / math.log2(2)))
    assert metrics.ndcg_at_k(["a"], set(), 3) == 1.0  # vacuous
