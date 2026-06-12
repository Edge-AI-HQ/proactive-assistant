"""AgentRunWorker pure helpers — HITL decision matching + resume decisions.

Unit-level (no DB, no agent, no chat import): pins the HITL-matrix corner
cases (plan §十六) that live in plain functions:
  * CC18 — a missing interrupt_id matches NO decision (never an arbitrary one).
  * decision matching by interrupt_id + source.
  * _decisions_from — approve / reject(+message) / safe default.
  * _pick_trigger — source priority on a merged batch.
  * _publish_terminal_frames — failure/cancel terminal frames to the FrameBus.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from pinai_agents.web.agent_core.framebus import Frame
from pinai_agents.web.agent_core.mailbox import Message
from pinai_agents.web.agent_core.runs import Run
from pinai_agents.web.agent_core.worker import (
    AgentRunWorker,
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


# ── _publish_terminal_frames ───────────────────────────────────────────


class _FakeFrameBus:
    def __init__(self, *, fail_types: set[str] | None = None) -> None:
        self.published: list[tuple[str, Frame]] = []
        self._fail_types = fail_types or set()

    async def publish(self, session_id: str, frame: Frame) -> None:
        if "*" in self._fail_types or frame.get("type") in self._fail_types:
            msg = "redis down"
            raise RuntimeError(msg)
        self.published.append((session_id, frame))


def _worker_with(framebus: _FakeFrameBus) -> AgentRunWorker:
    # The helper only touches self._framebus; the other deps are never
    # dereferenced in these unit tests (no DB / bus / chat client).
    return AgentRunWorker(pool=None, framebus=framebus, bus=None, chat_client=None)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_publish_terminal_frames_error_then_done():
    bus = _FakeFrameBus()
    await _worker_with(bus)._publish_terminal_frames("card-thread-x", "run-1", error="boom")
    assert [(s, f["type"]) for s, f in bus.published] == [
        ("card-thread-x", "chat:error"),
        ("card-thread-x", "chat:done"),
    ]
    err, done = (f for _, f in bus.published)
    assert err["data"] == {"error": "boom"}
    # traceId = run_id on every frame — the FE correlates the turn by it.
    assert err["traceId"] == "run-1" and done["traceId"] == "run-1"


@pytest.mark.asyncio
async def test_publish_terminal_frames_cancel_emits_done_only():
    bus = _FakeFrameBus()
    await _worker_with(bus)._publish_terminal_frames("card-thread-x", "run-2")
    assert [(s, f["type"]) for s, f in bus.published] == [("card-thread-x", "chat:done")]


@pytest.mark.asyncio
async def test_publish_terminal_frames_swallows_publish_failure():
    # Frames are best-effort UX on top of already-committed terminal DB state;
    # a Redis blip must not propagate into the worker's failure handling.
    await _worker_with(_FakeFrameBus(fail_types={"*"}))._publish_terminal_frames(
        "card-thread-x", "run-3", error="boom"
    )


@pytest.mark.asyncio
async def test_publish_terminal_frames_done_survives_error_publish_failure():
    # chat:done is what stops the client spinner — a failed chat:error publish
    # must not abort it.
    bus = _FakeFrameBus(fail_types={"chat:error"})
    await _worker_with(bus)._publish_terminal_frames("card-thread-x", "run-4", error="boom")
    assert [(s, f["type"]) for s, f in bus.published] == [("card-thread-x", "chat:done")]


# ── _relay_frames in-stream chat:error detection ───────────────────────


async def _frames(*frames: Frame):
    for f in frames:
        yield f


@pytest.mark.asyncio
async def test_relay_frames_surfaces_in_stream_chat_error():
    # chat's SSE layer swallows agent exceptions into chat:error + a finally
    # chat:done — the stream ends 'done' but the run must NOT land succeeded
    # (it's the /cards runStatus truth). _relay_frames reports the error; the
    # finalize path records the run as failed.
    bus = _FakeFrameBus()
    _, outcome, stream_error = await _worker_with(bus)._relay_frames(
        session_id="card-thread-x",
        user_id=1,
        owner="w1",
        run_id="run-1",
        frames=_frames(
            {"type": "chat:thinking", "ts": 1, "traceId": "run-1", "data": {}},
            {
                "type": "chat:error",
                "ts": 2,
                "traceId": "run-1",
                "data": {"error": "DaytonaError: boom"},
            },
            {"type": "chat:done", "ts": 3, "traceId": "run-1", "data": {}},
        ),
    )
    assert outcome == "done"
    assert stream_error == "DaytonaError: boom"
    # All frames still relayed to the FrameBus untouched.
    assert [f["type"] for _, f in bus.published] == ["chat:thinking", "chat:error", "chat:done"]


@pytest.mark.asyncio
async def test_relay_frames_clean_stream_has_no_error():
    bus = _FakeFrameBus()
    _, outcome, stream_error = await _worker_with(bus)._relay_frames(
        session_id="card-thread-x",
        user_id=1,
        owner="w1",
        run_id="run-2",
        frames=_frames(
            {"type": "chat:delta", "ts": 1, "traceId": "run-2", "data": {"delta": "hi"}},
            {"type": "chat:done", "ts": 2, "traceId": "run-2", "data": {}},
        ),
    )
    assert outcome == "done"
    assert stream_error is None
