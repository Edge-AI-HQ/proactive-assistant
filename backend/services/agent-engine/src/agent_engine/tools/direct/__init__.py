"""Native @tool surface for the chat agent.

`ALL_TOOLS` is the wiring point — chat agent factory passes this list
to create_deep_agent so we register tools in one place.

Code execution is NOT in this list — DeepAgents' FilesystemMiddleware
auto-mounts `execute(command)` + `write_file` / `read_file` / `ls` /
`glob` / `grep` / `edit_file` when a SandboxBackendProtocol backend is
attached. For multi-line Python the canonical pattern is
`write_file('/tmp/x.py', source)` then `execute('python3 /tmp/x.py')`,
matching Claude Code / Codex CLI / DeepAgents canonical Code Mode
(industry-standard Pattern A — single shell-shaped exec primitive,
Python invoked through it).

Each tool below is a LangChain BaseTool. Most call back to web
/api/agent/* via http_client; tavily_search calls Tavily directly;
browser_tool drives Browserbase. Composio meta-tools forward to
/api/agent/composio/meta/{NAME} which uses a per-user Tool Router
session to reach Composio Cloud — see
docs/plans/2026-05-07-composio-architecture-redesign.mdx.
"""

from __future__ import annotations

from ..browser.tools import browser_tool
from .cards import generate_card
from .composio_meta import (
    composio_get_tool_schemas,
    composio_manage_connections,
    composio_multi_execute_tool,
    composio_search_tools,
)
from .development_feedback import development_feedback_log
from .events import event_append, event_source, events_search
from .feedback import feedback_list
from .preferences import set_generation_language
from .scheduled_generators import (
    scheduled_generator_create,
    scheduled_generator_create_once,
    scheduled_generator_delete,
    scheduled_generator_list,
    scheduled_generator_pause,
    scheduled_generator_preview,
    scheduled_generator_resume,
)
from .tavily import tavily_extract, tavily_search
from .user_strings import memory_edit

ALL_TOOLS = [
    # Memory — unified layers. events_search/event_append are the L1 timeline
    # (supersede the old memory_search / signals_recent / raw reads); memory_edit
    # maintains the L2 portrait (USER/GOALS), which is also injected into
    # the system prompt by PortraitMiddleware.
    events_search,
    event_source,
    event_append,
    memory_edit,
    # World news now lives in the unified events stream (event_type=world_news);
    # the agent reads it via events_search like any other event (W5: the dedicated
    # world_recent / world_search tools are retired). Persona / facts / goals /
    # stated preferences live in the L2 portrait (written via memory_edit).
    # Output-language switch — a deterministic runtime setting, not a portrait edit.
    set_generation_language,
    # generate_card lets the user trigger a fresh Now-page card from chat
    # (optional topic focus). Recently-proposed cards are agent_decision
    # events — read them via events_search, not a dedicated cards tool.
    generate_card,
    feedback_list,
    # Product-team triage suggestions. This is not a personalization signal.
    development_feedback_log,
    # Scheduled generators — user-created recurring card generation. preview
    # builds a confirmable draft; create writes it only AFTER the user replies
    # to confirm (reply-gated, so deliberately NOT in SIDE_EFFECT_TOOL_NAMES);
    # create_once writes ONE-OFF tasks directly (low-risk, instantly undoable,
    # so no confirmation round); list / pause / resume / delete manage
    # existing tasks.
    scheduled_generator_preview,
    scheduled_generator_create,
    scheduled_generator_create_once,
    scheduled_generator_list,
    scheduled_generator_pause,
    scheduled_generator_resume,
    scheduled_generator_delete,
    # Web search + read (Tavily). search returns ranked snippets;
    # extract pulls full markdown for 1-20 URLs in one call.
    tavily_search,
    tavily_extract,
    # Composio Tool Router meta-tools (discovery + execution across
    # 1000+ SaaS apps in one constant-token surface).
    composio_search_tools,
    composio_get_tool_schemas,
    composio_multi_execute_tool,
    composio_manage_connections,
    # Stateful + escalation. Code execution comes from DeepAgents
    # middleware (`execute` / `write_file` / etc.), not this list.
    browser_tool,
]

# HITL side-effect gate — tools the agent calls to act FOR the user, gated
# behind human approval. build_agent(interrupt_on=...) wires
# HumanInTheLoopMiddleware: the run pauses on interrupt() BEFORE the call, web
# surfaces a requires_action frame, a human decision resumes via
# Command(resume=) (plan §五). Scope is deliberately narrow to protect UX:
# outbound SaaS actions + high-weight EXPLICIT user writes only. Frequent
# autonomous writes (memory_edit / event_append) are intentionally excluded —
# gating them would flood the user with approvals. Extend as new
# outbound/irreversible tools land.
SIDE_EFFECT_TOOL_NAMES = frozenset(
    {
        "COMPOSIO_MULTI_EXECUTE_TOOL",  # outbound SaaS action (send email / pay / …) — P0
    }
)

# Ready-to-pass interrupt_on map (every side-effect tool → full HITL gate).
# `True` = all decisions allowed (approve / edit / reject / respond); the
# frontend currently surfaces approve / reject (plan §五). One source so main
# + card agents stay in sync.
HITL_INTERRUPT_ON: dict[str, bool] = {name: True for name in SIDE_EFFECT_TOOL_NAMES}

__all__ = [
    "ALL_TOOLS",
    "HITL_INTERRUPT_ON",
    "SIDE_EFFECT_TOOL_NAMES",
    "browser_tool",
    "composio_get_tool_schemas",
    "composio_manage_connections",
    "composio_multi_execute_tool",
    "composio_search_tools",
    "development_feedback_log",
    "event_append",
    "events_search",
    "feedback_list",
    "memory_edit",
    "set_generation_language",
    "scheduled_generator_create",
    "scheduled_generator_create_once",
    "scheduled_generator_delete",
    "scheduled_generator_list",
    "scheduled_generator_pause",
    "scheduled_generator_preview",
    "scheduled_generator_resume",
    "tavily_extract",
    "tavily_search",
]
