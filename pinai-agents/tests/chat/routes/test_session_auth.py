"""Cross-user isolation guards for chat routes (P0 — see plan
2026-06-02 §10). `assert_session_key_principal` is chat's defense-in-depth
check that a session_key handed to an internal endpoint belongs to the
run JWT's principal — langgraph checkpoints have no RLS, so a mismatched
main-<other_user>-... must be rejected even if web's check is bypassed.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from pinai_agents.chat.auth.run_jwt import RunPrincipal
from pinai_agents.chat.transport.routes._session_auth import assert_session_key_principal


def _principal(user_id: int) -> RunPrincipal:
    return RunPrincipal(
        user_id=user_id,
        run_id="run-x",
        virtual_key="vk",
        browserbase_context_id=None,
        raw={},
    )


def test_main_thread_own_user_passes() -> None:
    # No exception = authorized.
    assert_session_key_principal("main-5296-ab12cd34ef", _principal(5296))


def test_main_thread_other_user_rejected() -> None:
    with pytest.raises(HTTPException) as exc:
        assert_session_key_principal("main-9999-ab12cd34ef", _principal(5296))
    assert exc.value.status_code == 403


def test_main_prefix_confusion_rejected() -> None:
    # principal 52 must NOT match main-5296-... via a loose prefix compare.
    with pytest.raises(HTTPException) as exc:
        assert_session_key_principal("main-5296-ab12cd34ef", _principal(52))
    assert exc.value.status_code == 403


def test_card_thread_shape_passes() -> None:
    # Card ownership is enforced in web (card belongs to user) before the
    # JWT is signed; chat only requires the card-thread shape here.
    assert_session_key_principal("card-thread-abc123", _principal(5296))


def test_proactive_thread_own_user_passes() -> None:
    # The per-user singleton heartbeat thread (proactive_loop.proactive_thread_id).
    assert_session_key_principal("proactive-5296", _principal(5296))


def test_proactive_thread_other_user_rejected() -> None:
    with pytest.raises(HTTPException) as exc:
        assert_session_key_principal("proactive-9999", _principal(5296))
    assert exc.value.status_code == 403


def test_proactive_prefix_confusion_rejected() -> None:
    # Exact match (not a prefix compare) so principal 52 can't slip through on
    # `proactive-5296` the way a loose `startswith("proactive-52")` would.
    with pytest.raises(HTTPException) as exc:
        assert_session_key_principal("proactive-5296", _principal(52))
    assert exc.value.status_code == 403
