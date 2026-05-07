"""Browser tool — Browserbase remote chromium + Playwright async + SSE.

Trust position: this module lives in the CHAT process. Browserbase API
key + per-session connect URLs are pulled from BROWSERBASE_API_KEY +
BROWSERBASE_PROJECT_ID env (held only by chat). The web process never
sees the api key — chat connects to Browserbase directly, frontend
embeds the Live View iframe by URL only.

Public surface:
  * BrowserManager (manager.py) — session lifecycle, single owner.
  * browser_tool      (tools.py) — LangChain @tool the chat agent calls.
  * router            (routes.py) — SSE + control mode endpoints.

Surface details:
  * Snapshot-first ref-based action API. Every page action returns a
    fresh aria snapshot with `eN` refs the agent uses for the next call.
  * Persistent context per user, lazy-provisioned in the web process
    and passed through the run JWT (`bbctx` claim).
  * Session id seen by the frontend is the chat `session_key`, never
    the Browserbase internal id — survives session re-creates.
  * Health check + idle GC are background tasks owned by the manager;
    SIGTERM cleanup runs through chat/app.py's lifespan.
"""

from __future__ import annotations

from .control_state import BrowserControlMode, assert_browser_action_allowed
from .events import browser_events
from .manager import BrowserSession, get_browser_manager

__all__ = [
    "BrowserControlMode",
    "BrowserSession",
    "assert_browser_action_allowed",
    "browser_events",
    "get_browser_manager",
]
