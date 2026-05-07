"""EdDSA per-run JWT for web → chat / sandbox.

Sign: web only — `pai_jwt_signing_key` (Ed25519 private, base64 raw 32B)
       lives in master credentials.
Verify: web (for /api/agent/* requests) + chat (own copy of the verify
        path in chat/auth/run_jwt.py).

Asymmetry: chat process holds ONLY the public key. A chat-side compromise
cannot mint new JWTs. This is the core security improvement over HS256
(where any compromised verify-side process could also forge tokens).

Claims:
  iss / aud — issuer / audience binding (RFC 8707 — prevents cross-service
                                          replay)
  sub        — always 'agent-run' for these tokens
  user_id    — int, the Pin AI user
  run_id     — opaque string, the agent run identifier (for audit join)
  scope      — 'agent' (room for 'admin' / 'dev' later)
  iat / exp  — 1-hour TTL by default (per pai_run_jwt_ttl_seconds)
  jti        — uuid; checked against pai_jti_revocations on verify
"""

from __future__ import annotations

import base64
import time
import uuid
from dataclasses import dataclass
from typing import Any

import jwt as pyjwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from ...config import get_web_settings


class AgentJWTError(Exception):
    """Raised when sign/verify fails."""


@dataclass(slots=True)
class AgentRunClaims:
    user_id: int
    run_id: str
    scope: str
    jti: str
    virtual_key: str | None  # LiteLLM `vk` claim — present for chat-driving JWTs
    browserbase_context_id: str | None  # `bbctx` — per-user persistent context
    raw: dict[str, Any]


def _signing_key() -> Ed25519PrivateKey:
    s = get_web_settings()
    if not s.pai_jwt_signing_key:
        msg = "PAI_JWT_SIGNING_KEY not configured — refusing to sign agent run JWT"
        raise AgentJWTError(msg)
    try:
        raw = base64.b64decode(s.pai_jwt_signing_key)
    except (ValueError, TypeError) as e:
        msg = "PAI_JWT_SIGNING_KEY must be base64-encoded 32 raw bytes"
        raise AgentJWTError(msg) from e
    if len(raw) != 32:
        msg = f"PAI_JWT_SIGNING_KEY decoded to {len(raw)} bytes (need 32)"
        raise AgentJWTError(msg)
    return Ed25519PrivateKey.from_private_bytes(raw)


def _verifying_key() -> Ed25519PublicKey:
    """Web also verifies (for /api/agent/* deps). Derive the public key
    from the signing key — no need for a separate config var on web."""
    return _signing_key().public_key()


def sign_agent_run_jwt(
    *,
    user_id: int,
    run_id: str | None = None,
    scope: str = "agent",
    ttl_seconds: int | None = None,
    virtual_key: str | None = None,
    browserbase_context_id: str | None = None,
) -> tuple[str, str]:
    """Sign a fresh per-run JWT. Returns (token, run_id).

    Algorithm: EdDSA (Ed25519). pyjwt accepts PEM-format keys; we convert
    our raw 32-byte private key to PEM at sign time.

    `virtual_key` (optional): LiteLLM virtual key embedded as the `vk`
    claim. Required for chat-driving JWTs (the chat worker uses it to
    auth its LLM calls). Sandbox / scheduler tokens omit it.
    """
    settings = get_web_settings()
    actual_run_id = run_id or f"run_{uuid.uuid4().hex[:16]}"
    now = int(time.time())
    claims: dict[str, Any] = {
        "iss": settings.pai_hmac_issuer,
        "aud": settings.pai_hmac_audience,
        "sub": "agent-run",
        "user_id": user_id,
        "run_id": actual_run_id,
        "scope": scope,
        "iat": now,
        "exp": now + (ttl_seconds or settings.pai_run_jwt_ttl_seconds),
        "jti": uuid.uuid4().hex,
    }
    if virtual_key:
        claims["vk"] = virtual_key
    if browserbase_context_id:
        claims["bbctx"] = browserbase_context_id
    priv = _signing_key()
    pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    token = pyjwt.encode(claims, pem, algorithm="EdDSA")
    return token, actual_run_id


def verify_agent_run_jwt(token: str) -> AgentRunClaims:
    """Verify an EdDSA-signed agent run JWT. Tokens with any other
    algorithm are rejected outright — EdDSA is the only auth path."""
    settings = get_web_settings()
    pub = _verifying_key()
    pub_pem = pub.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    try:
        claims = pyjwt.decode(
            token,
            pub_pem,
            algorithms=["EdDSA"],
            audience=settings.pai_hmac_audience,
            issuer=settings.pai_hmac_issuer,
            options={
                "require": ["sub", "exp", "user_id", "run_id"],
                "verify_signature": True,
                "verify_exp": True,
                "verify_aud": True,
                "verify_iss": True,
            },
        )
    except pyjwt.InvalidTokenError as e:
        msg = f"invalid agent run JWT: {type(e).__name__}: {e}"
        raise AgentJWTError(msg) from e

    user_id = claims.get("user_id")
    if not isinstance(user_id, int) or user_id <= 0:
        msg = f"agent JWT user_id must be positive int, got {user_id!r}"
        raise AgentJWTError(msg)
    run_id = claims.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        msg = "agent JWT run_id required and must be non-empty string"
        raise AgentJWTError(msg)

    vk = claims.get("vk")
    bbctx = claims.get("bbctx")
    return AgentRunClaims(
        user_id=user_id,
        run_id=run_id,
        scope=claims.get("scope", "agent"),
        jti=claims.get("jti", ""),
        virtual_key=vk if isinstance(vk, str) and vk else None,
        browserbase_context_id=bbctx if isinstance(bbctx, str) and bbctx else None,
        raw=claims,
    )
