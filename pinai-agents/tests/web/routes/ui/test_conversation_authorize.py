"""Cross-user isolation for /api/conversation/* (P0).

`_resolve_owned` is the guard every conversation route calls: main /
proactive threads are authorized by the user_id embedded in the key
(_classify); card threads by an RLS-scoped `final_cards` containment check
(a client must not be able to open/read/drive another user's card thread).
The card query is doubled here with a fake conn so we don't need a live DB
(ported from the legacy chat-stream authorize tests when ui/chat.py was
removed).
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from pinai_agents.web.routes.ui.conversation import _resolve_owned


class _FakeCursor:
    def __init__(self, row: Any) -> None:
        self._row = row

    async def __aenter__(self) -> _FakeCursor:
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    async def execute(self, *_a: Any, **_k: Any) -> None:
        return None

    async def fetchone(self) -> Any:
        return self._row


class _FakeConn:
    """Minimal async-conn double: the card-ownership query yields `row`;
    the thread-metadata insert is a no-op."""

    def __init__(self, row: Any) -> None:
        self._row = row

    def cursor(self, *_a: Any, **_k: Any) -> _FakeCursor:
        return _FakeCursor(self._row)


async def test_main_own_user_passes() -> None:
    kind, card_id = await _resolve_owned("main-5296-abc123", 5296, _FakeConn(None))
    assert kind == "main"
    assert card_id is None


async def test_main_other_user_rejected() -> None:
    # _classify rejects a main key whose embedded user_id != caller.
    with pytest.raises(HTTPException) as exc:
        await _resolve_owned("main-9999-abc123", 5296, _FakeConn(None))
    assert exc.value.status_code == 400


async def test_card_owned_passes() -> None:
    # final_cards containment query returns a row → card belongs to user.
    kind, card_id = await _resolve_owned("card-thread-xyz", 5296, _FakeConn((1,)))
    assert kind == "card"
    assert card_id == "xyz"


async def test_card_not_owned_rejected() -> None:
    # No row → another user's card → 403 (the cross-user leak this closes).
    with pytest.raises(HTTPException) as exc:
        await _resolve_owned("card-thread-xyz", 5296, _FakeConn(None))
    assert exc.value.status_code == 403
