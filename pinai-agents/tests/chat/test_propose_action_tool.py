"""propose_action — schema validation + interrupt-free tool body.

The tool's runtime job is purely "record structured args into the
LangGraph trace so the FE sees them via SSE chat:tool:start". It does
NOT pause the graph (no interrupt) — the agent's prompt disciplines
the turn to end after this tool returns. So unlike a `send_message`-
style interrupt tool, the tool function should always return the
sentinel string synchronously.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from pinai_agents.chat.tools.native.propose_action import (
    Artifact,
    DangerousAction,
    ExecutionStep,
    ProposeActionInput,
    canonical_args_hash,
    propose_action,
)


def test_canonical_hash_stable_across_key_order():
    h1 = canonical_args_hash({"to": "a@x.com", "subject": "hi"})
    h2 = canonical_args_hash({"subject": "hi", "to": "a@x.com"})
    assert h1 == h2


def test_canonical_hash_prefix():
    assert canonical_args_hash({"x": 1}).startswith("sha256:")


def test_canonical_hash_empty_args():
    assert canonical_args_hash(None) == canonical_args_hash({})


def test_propose_action_accepts_full_payload():
    payload = ProposeActionInput(
        message="I drafted a reply — send or tweak?",
        plan=[
            ExecutionStep(
                tool="COMPOSIO_MULTI_EXECUTE_TOOL",
                slug="GMAIL_SEND_DRAFT",
                risk="dangerous_write",
                summary="Send the draft.",
            ),
        ],
        drafts=[
            Artifact(kind="email_draft", title="Re: Q4 plan",
                     body="Hi Alex, ...", meta={"draftId": "r123"}),
        ],
        dangerous_actions=[
            DangerousAction(
                slug="GMAIL_SEND_DRAFT",
                args_preview={"draft_id": "r123"},
                args_hash=canonical_args_hash({"draft_id": "r123"}),
                risk_label="send email",
            ),
        ],
        risks=["Email will go out immediately."],
        options=["Send it", "Don't send", "Modify first"],
    )
    dump = payload.model_dump()
    assert dump["plan"][0]["risk"] == "dangerous_write"
    assert dump["dangerous_actions"][0]["args_hash"].startswith("sha256:")
    assert dump["options"] == ["Send it", "Don't send", "Modify first"]


def test_propose_action_accepts_minimal_payload():
    """Audit fields (plan / dangerous_actions / risks) default to empty
    lists; drafts + options default to None. Agent fills them only when
    relevant — a lightweight follow-up should be able to pass `message`
    alone."""
    payload = ProposeActionInput(message="Want me to also Slack the team?")
    dump = payload.model_dump()
    assert dump["message"]
    assert dump["plan"] == []
    assert dump["dangerous_actions"] == []
    assert dump["risks"] == []
    assert dump["drafts"] is None
    assert dump["options"] is None


def test_propose_action_rejects_empty_message():
    with pytest.raises(ValidationError):
        ProposeActionInput(message="")


def test_propose_action_rejects_bad_step_risk():
    with pytest.raises(ValidationError):
        ProposeActionInput(
            message="m",
            plan=[
                ExecutionStep(tool="x", risk="random_string", summary="s"),  # type: ignore[arg-type]
            ],
        )


def test_propose_action_func_returns_pause_sentinel():
    """The tool function body MUST return a sentinel string telling the
    agent to end its turn. This sentinel is what the agent receives as
    the tool's "return value" — without it the agent might keep calling
    tools instead of stopping. The exact text isn't load-bearing
    elsewhere; the agent's prompt instructs it to stop on any return
    from propose_action.
    """
    result = propose_action.func(
        message="Send it?",
        drafts=None,
        options=["Send it", "Cancel"],
        plan=[],
        dangerous_actions=[],
        risks=[],
    )
    assert isinstance(result, str)
    assert "PROPOSE_ACTION_DELIVERED" in result
    # No interrupt was raised — call must return synchronously. (If a
    # future refactor adds interrupt(), it'd raise GraphInterrupt here
    # and this assert would never run; the test catches that
    # regression.)
