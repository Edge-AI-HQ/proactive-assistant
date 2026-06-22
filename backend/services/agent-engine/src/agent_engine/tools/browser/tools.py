"""browser_tool — snapshot-first browser control for the chat agent.

Every action that interacts with the page returns a fresh aria snapshot
in the same response, so the agent never has to call `snapshot` separately.
Snapshots use Playwright's ai-mode aria tree (refs `e1`, `e2`, …);
subsequent actions address elements via `aria-ref=eN` selectors.

Action surface (~one tool, 14 actions):
  open(url?)                  — create session, optional initial nav
  close                       — destroy session
  snapshot                    — fresh aria tree (read-only, always allowed)
  click(ref)                  — click element by ref
  type(ref, text, clear?)     — fill / type into element by ref
  press_key(key)              — keyboard.press (Enter / Tab / Escape / …)
  wait(ms? | url_contains?)   — settle delay or URL-change wait
  scroll(dx, dy)              — page wheel scroll
  navigate(url)               — page.goto
  go_back / go_forward        — history navigation
  reload                      — page.reload
  get_text(ref)               — innerText of one element (OTPs, codes, …)
  console                     — recent JS console messages (debug)
  request_takeover(reason)    — hand control to user with a reason
"""

from __future__ import annotations

import logging
import time
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from ...harness.ctx import (
    current_browserbase_context_id,
    current_client_hints,
    current_session_key,
)
from ..usage_report import report_compute_usage
from .control_state import BrowserControlDenied, BrowserControlMode
from .manager import DeviceKind, get_browser_manager

logger = logging.getLogger(__name__)

_ACTION_PATTERN = (
    "^(open|close|snapshot|click|type|press_key|wait|scroll|navigate"
    "|go_back|go_forward|reload|get_text|console|request_takeover)$"
)


class BrowserToolInput(BaseModel):
    action: str = Field(
        pattern=_ACTION_PATTERN,
        description=(
            "open|close|snapshot|click|type|press_key|wait|scroll|navigate"
            "|go_back|go_forward|reload|get_text|console|request_takeover"
        ),
    )
    url: str | None = Field(default=None, description="For open/navigate.")
    ref: str | None = Field(
        default=None,
        description="Element ref from latest snapshot (e.g. 'e3'). "
        "Required for click / type / get_text.",
    )
    text: str | None = Field(default=None, description="For type.")
    clear: bool = Field(
        default=True,
        description="For type: True replaces existing value; False types after current cursor.",
    )
    key: str | None = Field(
        default=None,
        description="For press_key: Enter / Tab / Escape / ArrowDown / Backspace / a / …",
    )
    ms: int | None = Field(
        default=None, ge=0, le=30000, description="For wait: settle delay in ms."
    )
    url_contains: str | None = Field(
        default=None, description="For wait: wait until url contains substring (max 10s)."
    )
    dx: int = Field(default=0, description="For scroll: horizontal pixels.")
    dy: int = Field(default=0, description="For scroll: vertical pixels (positive=down).")
    reason: str | None = Field(
        default=None, description="For request_takeover: short reason shown to user."
    )


@tool("browser_tool", args_schema=BrowserToolInput)
async def browser_tool(
    action: str,
    url: str | None = None,
    ref: str | None = None,
    text: str | None = None,
    clear: bool = True,
    key: str | None = None,
    ms: int | None = None,
    url_contains: str | None = None,
    dx: int = 0,
    dy: int = 0,
    reason: str | None = None,
) -> dict[str, Any]:
    """Drive a Browserbase remote browser. Snapshot-first workflow:

      1. Call `open` (optionally with url). Returns liveViewUrl + the
         page's aria snapshot with element refs.
      2. Use refs (e.g. 'e3') from the LATEST snapshot for click / type /
         get_text. Each action returns the new post-action snapshot —
         use those new refs for the next step. Old refs from a previous
         snapshot are invalid.
      3. When you hit captcha / 2FA / payment confirm / OAuth, call
         `request_takeover` with a reason and STOP — wait for the user
         to drive and return control before continuing.
      4. Call `close` when done.

    Safety: a `click` whose target looks like an irreversible / payment
    action (Pay / Place Order / Confirm / Transfer / Delete / 付款 / 下单
    / 删除 …) is NOT executed — the browser is handed to the user for
    confirmation and the result comes back with `requiresTakeover: true`.
    Treat that exactly like your own `request_takeover`: stop and wait for
    the user (pair it with `propose_action`), don't retry the click.

    Element refs only work via this tool's actions — do NOT pass
    `aria-ref=eN` directly to `execute()` or any other tool.
    """
    session_key = current_session_key.get()
    if not session_key:
        return {"ok": False, "error": "no session_key — chat is running outside a thread"}

    mgr = get_browser_manager()

    start = time.monotonic()
    try:
        if action == "open":
            ctx_id = current_browserbase_context_id.get() or None
            hints = current_client_hints.get()
            viewport: tuple[int, int] | None = None
            device_kind: DeviceKind = "desktop"
            if hints:
                w = hints.get("viewport_width")
                h = hints.get("viewport_height")
                if w and h:
                    viewport = (int(w), int(h))
                dk = hints.get("device_kind")
                if dk in ("mobile", "tablet", "desktop"):
                    device_kind = dk
            opened = await mgr.open(
                session_key,
                url=url,
                persistent_context_id=ctx_id,
                viewport=viewport,
                device_kind=device_kind,
            )
            return {"ok": True, "action": "open", **opened}

        if action == "close":
            await mgr.destroy(session_key)
            return {"ok": True, "action": "close"}

        if action == "request_takeover":
            await mgr.set_control_mode(
                session_key,
                BrowserControlMode.USER,
                reason=reason or "user input required",
            )
            return {"ok": True, "action": "request_takeover", "reason": reason}

        if action == "snapshot":
            snap = await mgr.aria_snapshot(session_key)
            return {"ok": True, "action": "snapshot", **snap}

        if action == "navigate":
            if not url:
                return {"ok": False, "error": "navigate requires url"}
            return await mgr.navigate(session_key, url)

        if action == "click":
            if not ref:
                return {"ok": False, "error": "click requires ref (from latest snapshot)"}
            return await mgr.click_ref(session_key, ref)

        if action == "type":
            if not ref or text is None:
                return {"ok": False, "error": "type requires ref + text"}
            return await mgr.type_ref(session_key, ref, text, clear=clear)

        if action == "press_key":
            if not key:
                return {"ok": False, "error": "press_key requires key"}
            return await mgr.press_key(session_key, key)

        if action == "scroll":
            return await mgr.scroll(session_key, dx, dy)

        if action == "wait":
            return await mgr.wait_for(session_key, ms=ms, url_contains=url_contains)

        if action == "go_back":
            return await mgr.go_back(session_key)

        if action == "go_forward":
            return await mgr.go_forward(session_key)

        if action == "reload":
            return await mgr.reload_page(session_key)

        if action == "get_text":
            if not ref:
                return {"ok": False, "error": "get_text requires ref"}
            t = await mgr.get_text(session_key, ref)
            return {"ok": True, "action": "get_text", "text": t}

        if action == "console":
            entries = await mgr.get_console(session_key, limit=50)
            return {"ok": True, "action": "console", "entries": entries}

        return {"ok": False, "error": f"unknown action: {action}"}

    except BrowserControlDenied as e:
        return {"ok": False, "action": action, "error": str(e), "controlMode": "user"}
    except Exception as e:
        logger.exception("browser_tool action=%s failed", action)
        return {"ok": False, "action": action, "error": f"{type(e).__name__}: {e}"}
    finally:
        # Bill active browser-session time to the run's user (credits).
        report_compute_usage(
            provider="browserbase",
            duration_seconds=time.monotonic() - start,
            source=f"browser:{action}",
            metadata={"sessionKey": session_key},
        )
