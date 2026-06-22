"""Per-run JWT — EdDSA only, no HS256 fallback.

Web has Ed25519 private key (signs); chat has the public key (verifies).
Asymmetric design = chat-side compromise can't mint new JWTs.
"""

from __future__ import annotations

import base64
import time

import jwt as pyjwt
import pytest
from agent_engine.auth.run_jwt import RunJWTError, verify_run_jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pinai_api.platform.auth.agent_jwt import (
    AgentJWTError,
    sign_agent_run_jwt,
    verify_agent_run_jwt,
)


def _gen_keypair() -> tuple[str, str]:
    """Returns (b64 priv, b64 pub) — fresh keypair per test."""
    priv = Ed25519PrivateKey.generate()
    priv_raw = priv.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_raw = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(priv_raw).decode(), base64.b64encode(pub_raw).decode()


def _priv_pem_from_env() -> bytes:
    """Reconstruct PEM from the test fixture's PAI_JWT_SIGNING_KEY env."""
    import os

    raw = base64.b64decode(os.environ["PAI_JWT_SIGNING_KEY"])
    priv = Ed25519PrivateKey.from_private_bytes(raw)
    return priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


@pytest.fixture(autouse=True)
def _set_keypair(monkeypatch):
    priv_b64, pub_b64 = _gen_keypair()
    monkeypatch.setenv("PAI_JWT_SIGNING_KEY", priv_b64)
    monkeypatch.setenv("PAI_JWT_VERIFY_PUBKEY", pub_b64)
    from agent_engine.config import get_chat_settings
    from pinai_api import config

    config.get_web_settings.cache_clear()
    get_chat_settings.cache_clear()
    yield
    config.get_web_settings.cache_clear()
    get_chat_settings.cache_clear()


def test_sign_and_verify_web_side_roundtrip():
    token, run_id = sign_agent_run_jwt(user_id=42)
    claims = verify_agent_run_jwt(token)
    assert claims.user_id == 42
    assert claims.run_id == run_id
    assert claims.scope == "agent"


def test_sign_web_verify_chat_cross_process():
    """Asymmetric: web signs with private, chat verifies with public."""
    token, run_id = sign_agent_run_jwt(user_id=1234)
    principal = verify_run_jwt(token)
    assert principal.user_id == 1234
    assert principal.run_id == run_id


def test_signed_token_uses_eddsa_algorithm():
    token, _ = sign_agent_run_jwt(user_id=1)
    headers = pyjwt.get_unverified_header(token)
    assert headers["alg"] == "EdDSA"


def test_hs256_token_rejected_no_fallback():
    """HS256-signed tokens must NOT verify — no fallback path exists.
    Belt-and-suspenders against attackers who guess at the algorithm
    confusion classic."""
    secret = "any-shared-secret-attacker-might-guess"
    hs_token = pyjwt.encode(
        {
            "iss": "pinai-agents-web",
            "aud": "pinai-agents-internal",
            "sub": "agent-run",
            "user_id": 1,
            "run_id": "run_x",
            "exp": int(time.time()) + 600,
            "iat": int(time.time()),
            "scope": "agent",
            "jti": "x",
        },
        secret,
        algorithm="HS256",
    )
    with pytest.raises(AgentJWTError):
        verify_agent_run_jwt(hs_token)
    with pytest.raises(RunJWTError):
        verify_run_jwt(hs_token)


def test_eddsa_token_rejected_when_pubkey_wrong():
    """A token signed with our key must NOT verify against an unrelated
    public key — proves we actually check signatures."""
    token, _ = sign_agent_run_jwt(user_id=10)

    _, other_pub = _gen_keypair()
    import os

    os.environ["PAI_JWT_VERIFY_PUBKEY"] = other_pub
    from agent_engine.config import get_chat_settings

    get_chat_settings.cache_clear()
    try:
        with pytest.raises(RunJWTError):
            verify_run_jwt(token)
    finally:
        get_chat_settings.cache_clear()


def test_verify_rejects_wrong_audience():
    pem = _priv_pem_from_env()
    bad_token = pyjwt.encode(
        {
            "iss": "pinai-agents-web",
            "aud": "wrong-audience",
            "sub": "agent-run",
            "user_id": 1,
            "run_id": "run_x",
            "exp": int(time.time()) + 60,
        },
        pem,
        algorithm="EdDSA",
    )
    with pytest.raises(AgentJWTError):
        verify_agent_run_jwt(bad_token)
    with pytest.raises(RunJWTError):
        verify_run_jwt(bad_token)


def test_verify_rejects_expired():
    pem = _priv_pem_from_env()
    expired = pyjwt.encode(
        {
            "iss": "pinai-agents-web",
            "aud": "pinai-agents-internal",
            "sub": "agent-run",
            "user_id": 1,
            "run_id": "run_x",
            "exp": int(time.time()) - 60,
            "iat": int(time.time()) - 120,
        },
        pem,
        algorithm="EdDSA",
    )
    with pytest.raises(AgentJWTError):
        verify_agent_run_jwt(expired)


def test_sign_without_signing_key_raises():
    import os

    saved = os.environ.pop("PAI_JWT_SIGNING_KEY", None)
    from pinai_api import config

    config.get_web_settings.cache_clear()
    try:
        with pytest.raises(AgentJWTError):
            sign_agent_run_jwt(user_id=1)
    finally:
        if saved:
            os.environ["PAI_JWT_SIGNING_KEY"] = saved
        config.get_web_settings.cache_clear()


def test_verify_without_pubkey_raises():
    import os

    saved = os.environ.pop("PAI_JWT_VERIFY_PUBKEY", None)
    from agent_engine.config import get_chat_settings

    get_chat_settings.cache_clear()
    try:
        with pytest.raises(RunJWTError):
            verify_run_jwt("anything")
    finally:
        if saved:
            os.environ["PAI_JWT_VERIFY_PUBKEY"] = saved
        get_chat_settings.cache_clear()
