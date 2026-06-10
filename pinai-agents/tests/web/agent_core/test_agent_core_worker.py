"""AgentRunWorker pure helpers — HITL decision matching + resume decisions.

Unit-level (no DB, no agent, no chat import): pins the HITL-matrix corner
cases (plan §十六) that live in plain functions:
  * CC18 — a missing interrupt_id matches NO decision (never an arbitrary one).
  * decision matching by interrupt_id + source.
  * _decisions_from — approve / reject(+message) / safe default.
  * _pick_trigger — source priority on a merged batch.
"""

from __future__ import annotations

from datetime import UTC, datetime

from pinai_agents.web.agent_core.mailbox import Message
from pinai_agents.web.agent_core.runs import Run
from pinai_agents.web.agent_core.worker import (
    InputRow,
    _decisions_from,
    _find_decision_message,
    _input_rows,
    _pick_trigger,
)

_TS = datetime(2026, 6, 5, tzinfo=UTC)


def _msg(
    id_: int,
    source: str,
    content: str | None = None,
    meta: dict | None = None,
    idempotency_key: str | None = None,
) -> Message:
    return Message(
        id=id_,
        session_id="s",
        role="user",
        source=source,
        content=content,
        meta=meta,
        enqueued_at=_TS,
        idempotency_key=idempotency_key,
    )


def _awaiting(interrupt_id: str | None) -> Run:
    return Run(
        id="r1",
        session_id="s",
        agent_kind="main_chat",
        trigger="user",
        status="awaiting_input",
        stop_reason="requires_action",
        pending_action={"interrupt_id": interrupt_id} if interrupt_id else {},
        result=None,
        error=None,
    )


def test_find_decision_matches_on_interrupt_id():
    found = _find_decision_message(
        [
            _msg(1, "user", "hi"),
            _msg(2, "tool_decision", meta={"tool_use_id": "int-1", "decision": "approve"}),
        ],
        _awaiting("int-1"),
    )
    assert found is not None and found.id == 2


def test_find_decision_ignores_non_matching_interrupt_id():
    msgs = [_msg(2, "tool_decision", meta={"tool_use_id": "OTHER", "decision": "approve"})]
    assert _find_decision_message(msgs, _awaiting("int-1")) is None


def test_find_decision_missing_interrupt_id_matches_nothing():
    # CC18: an awaiting run with no interrupt_id must NOT match an arbitrary
    # decision — that would resume against the wrong tool.
    msgs = [_msg(2, "tool_decision", meta={"tool_use_id": "int-1", "decision": "approve"})]
    assert _find_decision_message(msgs, _awaiting(None)) is None


def test_find_decision_ignores_non_decision_source():
    # A plain user message that happens to say "approve" is not a decision.
    msgs = [_msg(1, "user", "approve please")]
    assert _find_decision_message(msgs, _awaiting("int-1")) is None


def test_decisions_from_approve():
    m = _msg(2, "tool_decision", meta={"tool_use_id": "int-1", "decision": "approve"})
    assert _decisions_from(m) == [{"type": "approve"}]


def test_decisions_from_reject_carries_message():
    m = _msg(
        2,
        "tool_decision",
        content="not allowed",
        meta={"tool_use_id": "int-1", "decision": "reject"},
    )
    assert _decisions_from(m) == [{"type": "reject", "message": "not allowed"}]


def test_decisions_from_defaults_to_reject():
    # Missing decision → safe default (reject), never silently approve.
    assert _decisions_from(_msg(2, "tool_decision", meta={})) == [{"type": "reject"}]


def test_pick_trigger_user_wins_over_heartbeat():
    assert _pick_trigger([_msg(1, "heartbeat"), _msg(2, "user", "hi")]) == "user"


def test_pick_trigger_decision_over_heartbeat():
    assert _pick_trigger([_msg(1, "heartbeat"), _msg(2, "tool_decision")]) == "tool_decision"


def test_input_rows_split_by_source_and_carry_client_msg_id():
    # Each persisted input row keeps its message's idempotency_key (the FE's
    # client message id) so the history row stamps it; heartbeat inputs land as
    # role='heartbeat' and empty content (bare resume signal) is skipped.
    rows = _input_rows(
        [
            _msg(1, "user", "hi", idempotency_key="uuid-1"),
            _msg(2, "heartbeat", "[heartbeat] 10:00"),
            _msg(3, "user", "legacy send"),
            _msg(4, "tool_decision", content=None),
        ]
    )
    assert rows == [
        InputRow("user", "hi", "uuid-1"),
        InputRow("heartbeat", "[heartbeat] 10:00", None),
        InputRow("user", "legacy send", None),
    ]
