"""Per-request session authorization for chat routes (defense-in-depth).

The run JWT carries `user_id` but NOT `session_key`, so every route that
accepts a session_key must still verify it belongs to the JWT principal —
web validates ownership before signing the JWT, but chat must not trust
that single point (these endpoints sit on the internal network).

- main threads encode the owner: `main-<user_id>-<rand>` → check the prefix
  against `principal.user_id`.
- card threads (`card-thread-<card_id>`) carry no user_id; their ownership
  (card belongs to user) is enforced in web before the JWT is signed, so
  here we only require the card-thread shape.
"""

from __future__ import annotations

from fastapi import HTTPException, status

from ..auth.run_jwt import RunJWTError, RunPrincipal, verify_run_jwt

_CARD_THREAD_PREFIX = "card-thread-"


def principal_from_header(
    authorization: str | None,
    *,
    require_vk: bool = False,
) -> RunPrincipal:
    """`Authorization: Bearer <run-jwt>` → verified RunPrincipal.

    `require_vk=True` for chat-driving routes (the model loop needs the
    LiteLLM virtual key); read-only routes (history / exists) leave it
    False since web signs those tokens without `vk`.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization: Bearer <token> required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization[len("bearer ") :].strip()
    try:
        principal = verify_run_jwt(token)
    except RunJWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"invalid run JWT: {e}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e
    if require_vk and not principal.virtual_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="run JWT missing `vk` claim — caller must be a chat-driving route",
        )
    return principal


def assert_session_key_principal(session_key: str, principal: RunPrincipal) -> None:
    """Reject when `session_key` does not belong to `principal` (403).

    See module docstring: main = prefix check; card = shape only.
    """
    if session_key.startswith(_CARD_THREAD_PREFIX):
        return
    expected = f"main-{principal.user_id}-"
    if not (session_key.startswith(expected) and len(session_key) > len(expected)):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="session_key does not belong to this principal",
        )
