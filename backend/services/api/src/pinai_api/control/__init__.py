"""Agent Core control plane (web side).

A thin layer that unifies the 7 agent kinds into one actor-model kernel —
Session(actor) / Message(mailbox) / Run(execution) — WITHOUT touching the
chat process or DB credentials it doesn't own. Frames stream live + resumable
via FrameBus (Redis Streams; cursored so a reconnect replays missed frames).

See docs/plans/2026-06-04-agentrun-control-plane.mdx.
"""

from __future__ import annotations

from .bus import AgentBus, agent_bus
from .execution_client import ChatRunClient
from .framebus import FrameBus, RedisFrameBus
from .kernel import AgentRunService
from .worker import AgentRunWorker

__all__ = [
    "AgentBus",
    "AgentRunService",
    "AgentRunWorker",
    "ChatRunClient",
    "FrameBus",
    "RedisFrameBus",
    "agent_bus",
]
