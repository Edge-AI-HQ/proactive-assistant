"""Agent Core control plane (web side).

A thin layer that unifies the 7 agent kinds into one actor-model kernel —
Session(actor) / Message(mailbox) / Run(execution) — WITHOUT touching the
chat process or DB credentials it doesn't own. Frames stream live via
FrameBus (in-memory dev / Redis pub/sub prod), never persisted.

See docs/plans/2026-06-04-agentrun-control-plane.mdx.
"""

from __future__ import annotations

from .bus import AgentBus, agent_bus
from .client import ChatRunClient
from .framebus import FrameBus, InMemoryFrameBus
from .service import AgentRunService
from .worker import AgentRunWorker

__all__ = [
    "AgentBus",
    "AgentRunService",
    "AgentRunWorker",
    "ChatRunClient",
    "FrameBus",
    "InMemoryFrameBus",
    "agent_bus",
]
