"""`propose_action` native tool — chat-shaped pause for the card agent.

The card-execution agent calls this when it wants the user to make a
decision (approve / modify / disambiguate / etc.) on structured content:
an email draft, a plan to execute, a side-effect to confirm. The tool
itself does NOTHING at runtime — it just records the structured args
into the LangGraph trace, which become visible to the frontend via the
SSE ``chat:tool:start`` event's ``args`` payload.

Why a tool (and not a markdown-embedded JSON block in the agent's text):
  * Strongly-typed payload → frontend renders a stable chip / draft /
    plan UI without LLM-format-compliance risk
  * Tool calls show up in LangSmith with structured args (easier debug)
  * The conversation-history endpoint preserves the tool-call shape so
    the home drawer pre-review can read the latest args without any
    additional persistence layer

No ``interrupt()`` here on purpose:
  * An interrupt would hold the run open (`awaiting_input`) and demand a
    /decision round-trip (the HITL machinery exists for side-effect
    tools); a card pause is just "the agent asked, the user will answer
    eventually" — the natural turn boundary models that with zero pending
    state.
  * The agent is prompted to STOP its turn immediately after this tool
    call returns (short ack AIMessage, then end of turn). The natural
    chat-turn boundary IS the pause — when the run finishes its turn,
    the chat:done event fires and the FE knows it's waiting for input.
  * User reply is a normal next HumanMessage on the same thread; the
    agent reads it on its next turn and decides what to do per the
    ``<user_reply_contract>`` in the card_execution prompt.

``args_hash`` on each dangerous action is purely informational — shown
to the user so they can audit the plan in the home drawer. There is no
runtime gate that diffs it against actual tool-call args.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field


class ExecutionStep(BaseModel):
    """One row of the agent's plan. Surfaced in the home drawer's
    pre-review view (not in the chat scrollback)."""

    tool: str = Field(min_length=1, max_length=120)
    slug: str | None = Field(default=None, max_length=120)
    risk: Literal["read", "safe_write", "dangerous_write", "blocked"] = "read"
    summary: str = Field(min_length=1, max_length=600)


class Artifact(BaseModel):
    """A draft the agent prepared (email body, message, doc preview,
    …). Rendered as a structured card above the chat thread."""

    kind: Literal["email_draft", "message", "doc", "other"] = "other"
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(max_length=20000)
    meta: dict[str, Any] = Field(default_factory=dict)


class DangerousAction(BaseModel):
    """Each dangerous side-effect the plan intends to execute.

    ``args_preview`` is the literal kwargs the tool will be called with;
    the user sees this in the home drawer's pre-review view.
    ``args_hash`` is the canonical-JSON sha256 over those args, surfaced
    for audit/log purposes — not enforced at runtime.
    """

    slug: str = Field(min_length=1, max_length=120)
    args_preview: dict[str, Any] = Field(default_factory=dict)
    args_hash: str = Field(min_length=1, max_length=200)
    risk_label: str = Field(min_length=1, max_length=120)


class ProposeActionInput(BaseModel):
    message: str = Field(
        min_length=1,
        max_length=4000,
        description=(
            "Your chat message to the user explaining what you've "
            "prepared and what you want them to decide. 1-3 sentences "
            "typically; longer is fine when the trade-off genuinely "
            "warrants. Conversational, not robotic."
        ),
    )
    drafts: list[Artifact] | None = Field(
        default=None,
        description=(
            "Structured drafts you prepared (email body, message text, "
            "doc preview). Fill when you want the user to inspect "
            "concrete content. Leave None for plain follow-up asks."
        ),
    )
    options: list[str] | None = Field(
        default=None,
        description=(
            "Optional contextual quick-reply chip labels (2-4) that "
            "capture the most likely user replies. The FE renders these "
            "as tappable chips alongside a permanent free-text input — "
            "tapping a chip sends its label back as the user's reply. "
            "Generate fresh labels each time based on what you're "
            "asking; e.g. send confirmation: "
            "['Send it', \"Don't send\", 'Modify first']. Omit if no "
            "shortcuts make sense."
        ),
    )
    plan: list[ExecutionStep] = Field(
        default_factory=list,
        description=(
            "Audit metadata: ordered list of planned steps. ONLY fill on "
            "the first propose_action that introduces a plan with side-"
            "effects, so the home drawer's pre-review can show the user "
            "what they're approving. Subsequent calls (re-drafts, light "
            "follow-up questions) should leave this empty."
        ),
    )
    dangerous_actions: list[DangerousAction] = Field(
        default_factory=list,
        description=(
            "Audit metadata: side-effect calls the plan intends to "
            "execute. Same scope as `plan` — fill on the first plan-"
            "introduction call, omit on follow-ups."
        ),
    )
    risks: list[str] = Field(
        default_factory=list,
        description=(
            "Audit metadata: plain-language risks the user should know "
            "before approving. Same scope as `plan` — fill on the first "
            "plan-introduction call, omit on follow-ups."
        ),
    )


def canonical_args_hash(args: dict[str, Any] | None) -> str:
    """sha256 of canonical JSON. None and empty dict hash to the same
    value. Stable helper for the agent's ``dangerous_actions`` payload
    (audit / display only — no runtime enforcement)."""
    payload = args or {}
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


# Sentinel the agent receives back as the tool's return value. The
# system prompt instructs the agent to STOP its turn immediately on
# seeing this — output one short acknowledgement AIMessage (or none)
# and end the turn naturally. The chat turn's natural boundary
# IS the pause.
_AWAITING_REPLY_SENTINEL = (
    "PROPOSE_ACTION_DELIVERED: structured proposal has been surfaced to "
    "the user. End your turn now without further tool calls; wait for "
    "the user's next message before continuing."
)


@tool("propose_action", args_schema=ProposeActionInput)
def propose_action(
    message: str,
    drafts: list[Artifact] | None,
    options: list[str] | None,
    plan: list[ExecutionStep],
    dangerous_actions: list[DangerousAction],
    risks: list[str],
) -> str:
    """Surface a structured proposal to the user and wait for their reply.

    Call this whenever you want the user to make a decision —
    introducing a plan, showing a re-drafted artifact, asking a
    clarifying question, or confirming before a final side-effect.

    Include `drafts` for structured content the user should see.
    Include `options` for 2-4 obvious quick-reply chips. Include
    `plan` / `dangerous_actions` / `risks` ONLY on the first call
    that introduces a plan with side-effects — they feed the home
    drawer's pre-review view, not the chat scrollback.

    After this tool returns the AWAITING_REPLY sentinel, end your
    turn immediately. The user's reply comes back as a normal
    HumanMessage on your next turn; interpret it per the prompt's
    user-reply contract (affirmative → execute; otherwise → treat
    as a modification instruction).
    """
    # Touch the args so static analyzers know they're consumed —
    # the real "effect" of this tool is the structured args being
    # captured in the LangGraph trace (on_tool_start event), not
    # anything the function body does.
    del message, drafts, options, plan, dangerous_actions, risks
    return _AWAITING_REPLY_SENTINEL
