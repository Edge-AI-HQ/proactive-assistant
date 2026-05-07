"""jti revocation cache + repository — pure-logic tests (no DB)."""

from __future__ import annotations

from pinai_agents.web.db.repositories.jti_revocations import (
    _CACHE_MAX,
    _cache_get,
    _cache_invalidate,
    _cache_put,
    clear_cache_for_tests,
)


def setup_function(_fn):
    clear_cache_for_tests()


def test_cache_returns_none_for_unknown():
    assert _cache_get("never-seen") is None


def test_cache_round_trip_negative():
    _cache_put("jti-a", False)
    assert _cache_get("jti-a") is False


def test_cache_round_trip_positive():
    _cache_put("jti-b", True)
    assert _cache_get("jti-b") is True


def test_invalidate_drops_entry():
    _cache_put("jti-c", True)
    _cache_invalidate("jti-c")
    assert _cache_get("jti-c") is None


def test_lru_evicts_oldest_at_capacity():
    """Stuff the cache past its max; the oldest unread entries fall out."""
    for i in range(_CACHE_MAX + 10):
        _cache_put(f"jti-{i}", False)
    # First 10 should be evicted.
    for i in range(10):
        assert _cache_get(f"jti-{i}") is None, f"jti-{i} should be evicted"
    # Most recent always stays.
    assert _cache_get(f"jti-{_CACHE_MAX + 9}") is False


def test_get_promotes_to_most_recent():
    """LRU semantics: a `get` on an old entry should rescue it from the
    next eviction wave."""
    _cache_put("oldest", False)
    for i in range(_CACHE_MAX - 1):
        _cache_put(f"filler-{i}", False)
    # `oldest` is now the LRU. Touch it.
    assert _cache_get("oldest") is False
    # Add one more — should evict the new LRU (filler-0), not `oldest`.
    _cache_put("freshest", False)
    assert _cache_get("oldest") is False
    assert _cache_get("filler-0") is None
