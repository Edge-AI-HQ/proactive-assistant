"""RunProfile — per-kind execution strategy (single source of truth).

Pure data: no DB, no deepagents. The web control plane reads these to
decide a run's execution model and double-texting policy. Complements the
chat-side AgentSpec (prompt/tools): the profile says *how it's scheduled*,
the spec says *what the agent is*. See
docs/plans/2026-06-04-agentrun-control-plane.mdx §七/§八.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ...shared.agent_run import AgentKind

Execution = Literal["conversational", "batch"]
# Double-texting policy — what to do when a new message arrives while a Run
# is in flight. Mirrors LangGraph Platform's multitask_strategy (per-kind
# here rather than per-run). enqueue: queue + merge next drain (default).
# interrupt: abort current + start new. reject: drop the new trigger.
Multitask = Literal["enqueue", "interrupt", "reject"]


@dataclass(frozen=True, slots=True)
class RunProfile:
    """How one agent kind's runs are executed and surfaced.

    - ``execution`` — ``conversational`` (Session + mailbox, per-session
      串行) vs ``batch`` (one-shot, no Session/mailbox, per-run).
    - ``triggers`` — which trigger sources may start this kind.
    - ``multitask`` — double-text policy (see ``Multitask``).

    Output transport is uniformly streaming for every kind (live via
    FrameBus, never persisted), so there is no transport field — see plan
    §四.4.
    """

    kind: AgentKind
    execution: Execution
    triggers: frozenset[str]
    multitask: Multitask = "enqueue"


# The 7 kinds. Conversational = main/card/proactive; batch = the rest.
# batch kinds reject re-triggers (don't double-fire a generation);
# conversational kinds enqueue+merge (a user's rapid follow-ups become one
# next drain).
_PROFILES: dict[str, RunProfile] = {
    "main_chat": RunProfile(
        kind="main_chat",
        execution="conversational",
        triggers=frozenset({"user"}),
        multitask="enqueue",
    ),
    "card_execution": RunProfile(
        kind="card_execution",
        execution="conversational",
        triggers=frozenset({"user"}),
        multitask="enqueue",
    ),
    "proactive": RunProfile(
        kind="proactive",
        execution="conversational",
        triggers=frozenset({"user", "heartbeat"}),
        multitask="enqueue",
    ),
    "generator": RunProfile(
        kind="generator",
        execution="batch",
        triggers=frozenset({"user", "cron"}),
        multitask="reject",
    ),
    "dream": RunProfile(
        kind="dream",
        execution="batch",
        triggers=frozenset({"cron", "system_event"}),
        multitask="reject",
    ),
    "evolve": RunProfile(
        kind="evolve",
        execution="batch",
        triggers=frozenset({"system_event"}),
        multitask="reject",
    ),
    "crystallize": RunProfile(
        kind="crystallize",
        execution="batch",
        triggers=frozenset({"system_event"}),
        multitask="reject",
    ),
}


def get_profile(kind: str) -> RunProfile:
    """Return the profile for ``kind``, or raise ``ValueError`` if unknown."""
    try:
        return _PROFILES[kind]
    except KeyError as exc:
        raise ValueError(f"unknown agent kind: {kind!r}") from exc


def all_profiles() -> tuple[RunProfile, ...]:
    """All registered profiles (stable insertion order)."""
    return tuple(_PROFILES.values())


# Convenience sets — e.g. the worker dispatches conversational vs batch
# differently (mailbox drain vs one-shot run).
BATCH_KINDS: frozenset[str] = frozenset(k for k, p in _PROFILES.items() if p.execution == "batch")
CONVERSATIONAL_KINDS: frozenset[str] = frozenset(
    k for k, p in _PROFILES.items() if p.execution == "conversational"
)
