"""Agent Core shared protocol (web ↔ chat).

Pure types only — NO logic, NO deepagents/langgraph, NO DB. Both the web
control plane (`web/agent_core/`) and the chat execution plane
(`chat/transport/routes/run.py`) import from here, so it must stay a leaf
with no side of the trust boundary leaking into the other.

See docs/plans/2026-06-04-agentrun-control-plane.mdx §三/§七/§八.
"""

from __future__ import annotations

from typing import Literal

# The 7 agent kinds. Conversational (Session + mailbox): main_chat /
# card_execution / proactive. Batch (one-shot, no Session): generator /
# dream / evolve / crystallize.
AgentKind = Literal[
    "main_chat",
    "card_execution",
    "proactive",
    "generator",
    "dream",
    "evolve",
    "crystallize",
]

# What the worker routes/accounts on (NOT what the LLM sees — message.role
# is always 'user'). proactive silent/cursor bookkeeping keys off this.
MessageSource = Literal[
    "user",
    "heartbeat",
    "cron",
    "system_event",
    "tool_decision",
]

RunStatus = Literal[
    "pending",
    "running",
    "awaiting_input",  # HITL: blocked on a tool decision
    "succeeded",
    "failed",
    "cancelled",
]

# awaiting_input: 'requires_action'. terminal: 'end_turn' / 'error' / 'cancelled'.
RunStopReason = Literal["requires_action", "end_turn", "error", "cancelled"]

# cancel(reason) discriminates whether partial output is kept (interrupt) or
# discarded (cancel) — see plan §十一.
CancelReason = Literal["user_cancel", "user_interrupt"]
