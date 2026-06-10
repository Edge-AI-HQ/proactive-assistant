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
from .cards import cards_recent, generate_card
from .composio_meta import (
    composio_get_tool_schemas,
    composio_manage_connections,
    composio_multi_execute_tool,
    composio_search_tools,
)
from .development_feedback import development_feedback_log
from .feedback import feedback_list
from .memory import memory_add, memory_get, memory_list, memory_search
from .preferences import preference_add, set_generation_language
from .profile import (
    goal_upsert,
    profile_get,
    profile_preference_merge,
    profile_upsert,
)
from .raw import raw_gcal_today, raw_gcal_week, raw_gmail_recent, raw_list
from .scheduled_generators import (
    scheduled_generator_create,
    scheduled_generator_create_once,
    scheduled_generator_delete,
    scheduled_generator_list,
    scheduled_generator_pause,
    scheduled_generator_preview,
    scheduled_generator_resume,
)
from .signals import signals_get, signals_kinds, signals_recent
from .tavily import tavily_extract, tavily_search
from .timeline import (
    timeline_future,
    timeline_get,
    timeline_history,
    timeline_in_progress,
    timeline_past,
)
from .world import world_recent, world_search

ALL_TOOLS = [
    # Memory (long-term user fact layer)
    memory_list,
    memory_search,
    memory_get,
    memory_add,
    # Signals (increment layer — open / consumed / archived).
    # `signals_kinds` is the discovery entry point; `signals_recent` /
    # `signals_get` drill into a chosen kind.
    signals_kinds,
    signals_recent,
    signals_get,
    # Profile + goals (persona / trajectory) + world context
    profile_get,
    profile_upsert,
    profile_preference_merge,
    goal_upsert,
    world_recent,
    world_search,
    # Stated preferences (expression layer) + language switch. preference_add
    # is the high-weight content-preference write; set_generation_language
    # flips the deterministic output-language setting.
    preference_add,
    set_generation_language,
    # Raw (high-frequency named tools + generic long-tail). These read
    # the offline-ingested raw tables (gmail / gcal / etc.) — for
    # FRESH SaaS data the model goes through the Composio meta-tools.
    raw_gmail_recent,
    raw_gcal_today,
    raw_gcal_week,
    raw_list,
    # Cards + feedback (recency-bounded reference). generate_card lets the
    # user trigger a fresh Now-page card from chat (optional topic focus).
    cards_recent,
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
# autonomous writes (memory_add) are intentionally excluded — gating them would
# flood the user with approvals. Extend as new outbound/irreversible tools land.
SIDE_EFFECT_TOOL_NAMES = frozenset(
    {
        "COMPOSIO_MULTI_EXECUTE_TOOL",  # outbound SaaS action (send email / pay / …) — P0
        "preference_add",  # high-weight explicit stated-preference write
    }
)

# Ready-to-pass interrupt_on map (every side-effect tool → full HITL gate).
# `True` = all decisions allowed (approve / edit / reject / respond); the
# frontend currently surfaces approve / reject (plan §五). One source so main
# + card agents stay in sync.
HITL_INTERRUPT_ON: dict[str, bool] = {name: True for name in SIDE_EFFECT_TOOL_NAMES}

# Timeline read tools — the proactive agent's event source over
# pai_timeline_events (migration 064). Deliberately NOT in ALL_TOOLS: the
# main-chat agent keeps reading pai_personal_signals / pai_raw_* through
# signals_* / raw_*. The proactive agent factory composes its own list
# from the shared ALL_TOOLS members plus these (see chat/agents/proactive.py).
TIMELINE_TOOLS = [
    timeline_past,
    timeline_future,
    timeline_in_progress,
    timeline_get,
    timeline_history,
]


__all__ = [
    "ALL_TOOLS",
    "HITL_INTERRUPT_ON",
    "SIDE_EFFECT_TOOL_NAMES",
    "TIMELINE_TOOLS",
    "browser_tool",
    "cards_recent",
    "composio_get_tool_schemas",
    "composio_manage_connections",
    "composio_multi_execute_tool",
    "composio_search_tools",
    "development_feedback_log",
    "feedback_list",
    "goal_upsert",
    "memory_add",
    "memory_get",
    "memory_list",
    "memory_search",
    "preference_add",
    "profile_get",
    "profile_preference_merge",
    "profile_upsert",
    "set_generation_language",
    "raw_gcal_today",
    "raw_gcal_week",
    "raw_gmail_recent",
    "raw_list",
    "scheduled_generator_create",
    "scheduled_generator_create_once",
    "scheduled_generator_delete",
    "scheduled_generator_list",
    "scheduled_generator_pause",
    "scheduled_generator_preview",
    "scheduled_generator_resume",
    "signals_get",
    "signals_kinds",
    "signals_recent",
    "tavily_extract",
    "tavily_search",
    "timeline_future",
    "timeline_get",
    "timeline_history",
    "timeline_in_progress",
    "timeline_past",
    "world_recent",
    "world_search",
]
