"""Token generation + bcrypt verify — no DB needed."""

from __future__ import annotations

from pinai_agents.web.db.repositories.devices import (
    _generate_token,
    _hash_token,
    _verify_token,
)


def test_generate_token_returns_distinct_high_entropy_tokens():
    a = _generate_token()
    b = _generate_token()
    assert a != b
    # 32 random bytes → base64url is ~43 chars (no padding).
    assert len(a) >= 40


def test_verify_token_accepts_correct_pair():
    tok = _generate_token()
    h = _hash_token(tok)
    assert _verify_token(tok, h) is True


def test_verify_token_rejects_wrong_token():
    h = _hash_token(_generate_token())
    assert _verify_token("nope-not-the-token-at-all", h) is False


def test_verify_token_rejects_empty_inputs():
    assert _verify_token("", "anything") is False
    assert _verify_token("anything", "") is False
    assert _verify_token("", "") is False


def test_verify_token_rejects_corrupt_hash():
    # Bad bcrypt format → bcrypt raises; we swallow as "no match".
    assert _verify_token("any", "this-is-not-a-bcrypt-hash") is False
