"""Goal 3 plumbing: card context injection into the chat send path.

Asserts the message-assembly branch in `chat/routes/chat.py`:
  * main chat thread carrying card_context this turn → one
    <card_context> SystemMessage injected (per-turn, NOT gated on first
    turn — main chat is a per-user singleton).
  * main chat thread with no card_context → nothing injected.
  * card thread keeps its first-turn guard: injects on first turn, skips
    on later turns (regression — main-thread change must not touch it).

These exercise the pure `_build_send_messages` helper so we test the
decision without spinning up the agent / sandbox.
"""

from __future__ import annotations

from langchain_core.messages import SystemMessage

from pinai_agents.chat.transport.routes.chat import _build_send_messages

_CTX = {"card_id": "card_99", "title": "A-share digest", "intent": "review"}


def _system_messages(msgs: list) -> list[SystemMessage]:
    return [m for m in msgs if isinstance(m, SystemMessage)]


def _user_turns(msgs: list) -> list[dict]:
    return [m for m in msgs if isinstance(m, dict) and m.get("role") == "user"]


def test_main_thread_with_card_context_injects_system_message():
    msgs = _build_send_messages(
        messages=["this card is off"],
        card_context=_CTX,
        is_card_thread=False,
        is_first_turn=False,  # main thread is a singleton — never "first"
    )
    sysmsgs = _system_messages(msgs)
    assert len(sysmsgs) == 1
    assert "<card_context>" in sysmsgs[0].content
    assert "exact current card" in sysmsgs[0].content
    assert "Do not call cards_recent" in sysmsgs[0].content
    assert "card_99" in sysmsgs[0].content
    # The user turn is still appended after the context.
    assert _user_turns(msgs) == [{"role": "user", "content": "this card is off"}]


def test_main_thread_without_card_context_injects_nothing():
    msgs = _build_send_messages(
        messages=["hello"],
        card_context=None,
        is_card_thread=False,
        is_first_turn=False,
    )
    assert _system_messages(msgs) == []
    assert _user_turns(msgs) == [{"role": "user", "content": "hello"}]


def test_card_thread_first_turn_injects_once():
    msgs = _build_send_messages(
        messages=["help with this"],
        card_context=_CTX,
        is_card_thread=True,
        is_first_turn=True,
    )
    assert len(_system_messages(msgs)) == 1


def test_card_thread_later_turn_does_not_reinject():
    """Regression: the main-thread change must not break the card-thread
    first-turn guard — later card-thread turns inject nothing."""
    msgs = _build_send_messages(
        messages=["follow-up"],
        card_context=_CTX,
        is_card_thread=True,
        is_first_turn=False,
    )
    assert _system_messages(msgs) == []
    assert _user_turns(msgs) == [{"role": "user", "content": "follow-up"}]


def test_merge_sends_each_message_as_its_own_user_turn():
    """Actor-kernel merge: several pending user messages become SEPARATE
    role=user turns (not concatenated) — CORE-0 verified the LLM accepts
    consecutive user messages."""
    msgs = _build_send_messages(
        messages=["first", "second", "third"],
        card_context=None,
        is_card_thread=False,
        is_first_turn=False,
    )
    assert _user_turns(msgs) == [
        {"role": "user", "content": "first"},
        {"role": "user", "content": "second"},
        {"role": "user", "content": "third"},
    ]
