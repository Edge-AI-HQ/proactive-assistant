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
browser_tool drives Browserbase.
"""

from __future__ import annotations

from ...browser.tools import browser_tool
from .cards import cards_recent
from .feedback import feedback_list
from .memory import memory_add, memory_get, memory_list, memory_search
from .personal_exec import personal_exec
from .profile import goal_upsert, profile_get, profile_upsert
from .raw import raw_gcal_today, raw_gcal_week, raw_gmail_recent, raw_list
from .signals import signals_get, signals_recent
from .tavily import tavily_search
from .world import world_recent

ALL_TOOLS = [
    # Memory (long-term user fact layer)
    memory_list, memory_search, memory_get, memory_add,
    # Signals (increment layer — open / consumed / archived)
    signals_recent, signals_get,
    # Profile + goals (persona / trajectory) + world context
    profile_get, profile_upsert, goal_upsert, world_recent,
    # Raw (high-frequency named tools + generic long-tail)
    raw_gmail_recent, raw_gcal_today, raw_gcal_week, raw_list,
    # Cards + feedback (recency-bounded reference)
    cards_recent, feedback_list,
    # Web search (Tavily)
    tavily_search,
    # Side-effect surface
    personal_exec,
    # Stateful + escalation. Code execution comes from DeepAgents
    # middleware (`execute` / `write_file` / etc.), not this list.
    browser_tool,
]


__all__ = [
    "ALL_TOOLS",
    "browser_tool",
    "cards_recent",
    "feedback_list",
    "goal_upsert",
    "memory_add",
    "memory_get",
    "memory_list",
    "memory_search",
    "personal_exec",
    "profile_get",
    "profile_upsert",
    "raw_gcal_today",
    "raw_gcal_week",
    "raw_gmail_recent",
    "raw_list",
    "signals_get",
    "signals_recent",
    "tavily_search",
    "world_recent",
]
