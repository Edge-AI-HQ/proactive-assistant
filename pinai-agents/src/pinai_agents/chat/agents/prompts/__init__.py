"""Shared prompt blocks for chat sub-agents.

Per-agent prompts (`chat`, `generator`, `dream`, `evolve`, `crystallize`)
embed these constants via f-string. NOT a runtime composition framework
— just three text blocks that 4-5 agents would otherwise duplicate.

Pattern reference: Claude Code keeps each sub-agent's prompt fully
self-contained (`/src/tools/AgentTool/built-in/exploreAgent.ts`). We
follow that — each agent is one function returning one string — and
add this module only to keep the 3 truly identical blocks in sync.
"""

from .shared import (
    CODE_MODE_GUIDANCE,
    GROUNDING_POLICY,
    SANDBOX_PREAMBLE,
)

__all__ = [
    "CODE_MODE_GUIDANCE",
    "GROUNDING_POLICY",
    "SANDBOX_PREAMBLE",
]
