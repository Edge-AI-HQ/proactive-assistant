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

from ...browser.tools import browser_tool
from .cards import cards_recent
from .composio_meta import (
    composio_get_tool_schemas,
    composio_manage_connections,
    composio_multi_execute_tool,
    composio_search_tools,
)
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
from .signals import signals_get, signals_kinds, signals_recent
from .tavily import tavily_extract, tavily_search
from .world import world_recent, world_search

ALL_TOOLS = [
    # Memory (long-term user fact layer)
    memory_list, memory_search, memory_get, memory_add,
    # Signals (increment layer — open / consumed / archived).
    # `signals_kinds` is the discovery entry point; `signals_recent` /
    # `signals_get` drill into a chosen kind.
    signals_kinds, signals_recent, signals_get,
    # Profile + goals (persona / trajectory) + world context
    profile_get, profile_upsert, profile_preference_merge, goal_upsert,
    world_recent, world_search,
    # Stated preferences (expression layer) + language switch. preference_add
    # is the high-weight content-preference write; set_generation_language
    # flips the deterministic output-language setting.
    preference_add, set_generation_language,
    # Raw (high-frequency named tools + generic long-tail). These read
    # the offline-ingested raw tables (gmail / gcal / etc.) — for
    # FRESH SaaS data the model goes through the Composio meta-tools.
    raw_gmail_recent, raw_gcal_today, raw_gcal_week, raw_list,
    # Cards + feedback (recency-bounded reference)
    cards_recent, feedback_list,
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


__all__ = [
    "ALL_TOOLS",
    "browser_tool",
    "cards_recent",
    "composio_get_tool_schemas",
    "composio_manage_connections",
    "composio_multi_execute_tool",
    "composio_search_tools",
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
    "signals_get",
    "signals_kinds",
    "signals_recent",
    "tavily_extract",
    "tavily_search",
    "world_recent",
    "world_search",
]
