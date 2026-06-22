"""Verify the EdDSA per-run JWT web sends with each /agent/chat request.

Verify-only: chat process holds the Ed25519 PUBLIC key only. A chat-side
compromise cannot mint new JWTs — the asymmetric design is the core
security improvement over HS256.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

import jwt as pyjwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from agent_engine.config import get_chat_settings


class RunJWTError(Exception):
    """Verification failed."""


@dataclass(slots=True)
class RunPrincipal:
    user_id: int
    run_id: str
    virtual_key: str | None  # LiteLLM vk claim — present on chat-driving JWTs
    browserbase_context_id: str | None  # `bbctx` claim — per-user persistent ctx
    raw: dict[str, Any]


def _verify_pubkey() -> Ed25519PublicKey:
    s = get_chat_settings()
    if not s.pai_jwt_verify_pubkey:
        msg = "PAI_JWT_VERIFY_PUBKEY not set — cannot verify run JWT"
        raise RunJWTError(msg)
    try:
        raw = base64.b64decode(s.pai_jwt_verify_pubkey)
    except (ValueError, TypeError) as e:
        msg = "PAI_JWT_VERIFY_PUBKEY must be base64-encoded 32 raw bytes"
        raise RunJWTError(msg) from e
    if len(raw) != 32:
        msg = f"PAI_JWT_VERIFY_PUBKEY decoded to {len(raw)} bytes (need 32)"
        raise RunJWTError(msg)
    return Ed25519PublicKey.from_public_bytes(raw)


def verify_run_jwt(token: str) -> RunPrincipal:
    """Verify an EdDSA-signed run JWT. Tokens with any other algorithm
    are rejected — EdDSA is the only auth path."""
    pub = _verify_pubkey()
    pub_pem = pub.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    try:
        claims = pyjwt.decode(
            token,
            pub_pem,
            algorithms=["EdDSA"],
            audience="pinai-agents-internal",
            issuer="pinai-agents-web",
            options={
                "require": ["sub", "exp", "user_id", "run_id"],
                "verify_signature": True,
                "verify_exp": True,
                "verify_aud": True,
                "verify_iss": True,
            },
        )
    except pyjwt.InvalidTokenError as e:
        msg = f"invalid run JWT: {type(e).__name__}: {e}"
        raise RunJWTError(msg) from e

    user_id = claims.get("user_id")
    run_id = claims.get("run_id")
    if not isinstance(user_id, int) or user_id <= 0:
        raise RunJWTError(f"bad user_id claim: {user_id!r}")
    if not isinstance(run_id, str) or not run_id:
        raise RunJWTError(f"bad run_id claim: {run_id!r}")
    vk = claims.get("vk")
    bbctx = claims.get("bbctx")
    return RunPrincipal(
        user_id=user_id,
        run_id=run_id,
        virtual_key=vk if isinstance(vk, str) and vk else None,
        browserbase_context_id=bbctx if isinstance(bbctx, str) and bbctx else None,
        raw=claims,
    )
