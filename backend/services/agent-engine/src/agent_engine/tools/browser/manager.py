"""Browserbase session manager.

Single owner of session lifecycle, identified by chat `session_key`
(NOT Browserbase's internal id — keeps the frontend's URL stable across
session re-creates within the same chat thread).

Concurrency: per-session-key creator-coalesce via shared Future. Public
mutators are locked. Background tasks: idle GC + health check.

Persistent context: when a `persistent_context_id` is supplied, the BB
session is created with `context.id=...` so cookies / login persist
across sessions for the same user. Web/services/browserbase_provisioning
mints these per-user.

Device profile: when the chat caller passes `viewport=(w, h)` and/or
`device_kind ∈ {mobile, tablet}`, those map directly onto Browserbase's
`browserSettings.viewport` (renders at that CSS px) and
`browserSettings.os` (sets the stealth user-agent so target sites serve
mobile/tablet layouts). isMobile/hasTouch can't be flipped post-hoc
through Playwright over CDP, so we have to wire this at session create
time. See docs/plans/2026-05-04-tool-calling-paradigms.mdx and
browserbase SDK types/session_create_params.py for the field surface.

If a session is reused for a chat thread and the requested device profile
differs from the cached one, we destroy + recreate — same `session_key`
must mean same device profile from the agent's perspective.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import OrderedDict, deque
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import urlparse

from browserbase import Browserbase
from pinai_contracts.sse_envelope import (
    EV_BROWSER_CLOSED,
    EV_BROWSER_NAVIGATED,
    EV_BROWSER_OPENED,
    SSEEvent,
)
from playwright.async_api import (
    Browser,
    BrowserContext,
    CDPSession,
    ConsoleMessage,
    Page,
    async_playwright,
)
from playwright.async_api import (
    Error as PlaywrightError,
)

from .control_state import (
    BrowserControlMode,
    assert_browser_action_allowed,
)
from .events import browser_events

logger = logging.getLogger(__name__)

# ── Tunables ──
_IDLE_TIMEOUT_SEC = int(os.environ.get("BROWSERBASE_IDLE_TIMEOUT_SEC", 300))
_MAX_SESSIONS = int(os.environ.get("BROWSERBASE_MAX_SESSIONS", 5))
_BB_SESSION_TIMEOUT_SEC = int(os.environ.get("BROWSERBASE_SESSION_TIMEOUT", 900))
_CDP_CONNECT_TIMEOUT_SEC = 15
_HEALTH_CHECK_INTERVAL_SEC = 60
# BB session statuses that mean the remote browser is gone — health check
# tears down the local Playwright handle on these.
_DEAD_BB_STATUSES = frozenset({"COMPLETED", "TIMED_OUT", "ERROR"})
_CONSOLE_BUFFER_MAX = 200

# Mobile / tablet emulation goes through Playwright's `devices` registry
# (which is itself a thin wrapper over the CDP commands documented at
# https://chromedevtools.github.io/devtools-protocol/tot/Emulation/).
# We pick a Playwright preset to get a realistic UA + DPR + touch flags,
# but use the caller-supplied viewport (the user's panel CSS px) instead
# of the preset's so the live view is a 1:1 of the user's screen.
_DEVICE_PRESET: dict[str, str] = {
    "mobile": "iPhone 14 Pro",
    "tablet": "iPad (gen 7)",
}
# After a write action (click / type / nav), wait this long before
# returning the post-action snapshot. Lets SPA frameworks settle DOM
# without making the agent script its own arbitrary `wait`.
_POST_ACTION_SETTLE_MS = 400

# Viewport guardrails — sites get confused by sub-phone widths and
# Browserbase rejects unreasonable values. Clamp before forwarding.
_VIEWPORT_W_MIN, _VIEWPORT_W_MAX = 320, 2560
_VIEWPORT_H_MIN, _VIEWPORT_H_MAX = 480, 1600

# After a tap, does the focused element accept text? Drives whether the
# frontend raises the soft keyboard. Excludes button-like <input> types.
_IS_EDITABLE_JS = """() => {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    const nonText = ['checkbox','radio','button','submit','reset','range','color','file','image'];
    return !el.disabled && !el.readOnly && !nonText.includes(t);
  }
  if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly;
  return el.isContentEditable === true;
}"""

# Cookie name fragments that signal a real auth/session cookie. Some sites set
# HttpOnly consent / analytics cookies even when logged out (e.g. google's
# NID / AEC), so "has any HttpOnly cookie" over-reports. We additionally
# require the cookie name to look auth-ish. Covers session / JSESSIONID /
# PHPSESSID (sess), google SID (sid), oauth (auth/token), etc. Trade-off: may
# miss sites that use an unusual login cookie name.
_AUTH_COOKIE_HINTS = (
    "sess",
    "sid",
    "auth",
    "token",
    "login",
    "jwt",
    "credential",
    "remember",
)

DeviceKind = Literal["mobile", "tablet", "desktop"]

# Default viewport per device kind when the caller didn't pass one.
# Desktop matches BB's own default surface. Mobile/tablet picked to
# match the most common iPhone Pro / iPad CSS sizes so sites that
# device-sniff via UA see a coherent layout.
_DEFAULT_VIEWPORT: dict[DeviceKind, tuple[int, int]] = {
    "desktop": (1280, 800),
    "tablet": (820, 1180),
    "mobile": (390, 844),
}


def _clamp_viewport(w: int, h: int) -> tuple[int, int]:
    return (
        max(_VIEWPORT_W_MIN, min(_VIEWPORT_W_MAX, int(w))),
        max(_VIEWPORT_H_MIN, min(_VIEWPORT_H_MAX, int(h))),
    )


def _normalize_profile(
    viewport: tuple[int, int] | None,
    device_kind: DeviceKind,
) -> tuple[tuple[int, int], DeviceKind]:
    """Resolve caller-provided hints to a concrete (viewport, device_kind).

    Caller passes the *desired* viewport (frontend's panel CSS px on
    mobile) and device kind; we fill in defaults and clamp. Result is
    the cache key for session reuse.
    """
    if viewport is None:
        viewport = _DEFAULT_VIEWPORT[device_kind]
    return _clamp_viewport(*viewport), device_kind


@dataclass
class BrowserSession:
    """Public handle — what we hand back to tools and serialize over SSE."""

    session_key: str
    bb_session_id: str
    live_view_url: str
    viewport: dict[str, int]
    device_kind: DeviceKind
    control_mode: BrowserControlMode
    takeover_reason: str | None
    current_url: str
    created_at: float
    last_used_at: float


@dataclass
class _Internal:
    """Per-session bookkeeping kept inside the manager."""

    session: BrowserSession
    browser: Browser
    context: BrowserContext
    page: Page
    pw_stop: Any  # async () -> None
    # Persistent CDP session for user input dispatch (Input.dispatchTouchEvent
    # etc.). Created once at session create, reused for device emulation, and
    # detached on teardown. Playwright's page.tap/touchscreen can't be used over
    # connectOverCDP (hasTouch can't be set on an attached context), so user
    # touch input goes through raw CDP on this handle.
    cdp: CDPSession
    console: deque = field(default_factory=lambda: deque(maxlen=_CONSOLE_BUFFER_MAX))


class BrowserManager:
    def __init__(self) -> None:
        self._sessions: OrderedDict[str, _Internal] = OrderedDict()
        self._creating: dict[str, asyncio.Future] = {}
        self._lock = asyncio.Lock()
        self._bb: Browserbase | None = None
        self._gc_task: asyncio.Task | None = None
        self._health_task: asyncio.Task | None = None

    def _bb_client(self) -> Browserbase:
        if self._bb is None:
            api_key = os.environ.get("BROWSERBASE_API_KEY")
            if not api_key:
                raise RuntimeError("BROWSERBASE_API_KEY not configured")
            self._bb = Browserbase(api_key=api_key)
        return self._bb

    def _project_id(self) -> str:
        pid = os.environ.get("BROWSERBASE_PROJECT_ID")
        if not pid:
            raise RuntimeError("BROWSERBASE_PROJECT_ID not configured")
        return pid

    # ── public API ──

    async def get_or_create(
        self,
        session_key: str,
        *,
        persistent_context_id: str | None = None,
        viewport: tuple[int, int] | None = None,
        device_kind: DeviceKind = "desktop",
    ) -> BrowserSession:
        """Get the cached session for `session_key`, or create one.

        If a session already exists but the requested `(viewport, device_kind)`
        differs from the cached profile, the existing session is destroyed
        and a fresh one is created. This is necessary because Playwright
        over CDP can't flip isMobile/hasTouch on an attached context —
        the only clean way to change device profile is a new BB session.
        """
        requested = _normalize_profile(viewport, device_kind)
        is_creator = False
        async with self._lock:
            existing = self._sessions.get(session_key)
            if existing is not None:
                cached = (
                    (existing.session.viewport["width"], existing.session.viewport["height"]),
                    existing.session.device_kind,
                )
                if cached == requested:
                    self._sessions.move_to_end(session_key)
                    existing.session.last_used_at = time.monotonic()
                    return existing.session
                # Profile mismatch — fall through to recreate. Pop now so
                # the teardown happens outside the lock.
                self._sessions.pop(session_key, None)
                logger.info(
                    "browser: profile change sk=%s cached=%s requested=%s — recreating",
                    session_key,
                    cached,
                    requested,
                )
                asyncio.create_task(self._teardown(session_key, existing))
            in_flight = self._creating.get(session_key)
            if in_flight is None:
                in_flight = asyncio.get_running_loop().create_future()
                self._creating[session_key] = in_flight
                is_creator = True
        if not is_creator:
            return await in_flight
        try:
            session = await self._create(
                session_key,
                persistent_context_id,
                viewport=requested[0],
                device_kind=requested[1],
            )
            if not in_flight.done():
                in_flight.set_result(session)
            return session
        except Exception as e:
            if not in_flight.done():
                in_flight.set_exception(e)
            raise
        finally:
            async with self._lock:
                self._creating.pop(session_key, None)

    async def open(
        self,
        session_key: str,
        *,
        url: str | None = None,
        persistent_context_id: str | None = None,
        viewport: tuple[int, int] | None = None,
        device_kind: DeviceKind = "desktop",
    ) -> dict[str, Any]:
        """Get-or-create a session and (optionally) navigate to `url`.
        Returns liveViewUrl + the post-load aria snapshot — the agent's
        single entry point for browser_tool action=open."""
        session = await self.get_or_create(
            session_key,
            persistent_context_id=persistent_context_id,
            viewport=viewport,
            device_kind=device_kind,
        )
        internal = await self.get(session_key)
        if internal is None:
            raise RuntimeError("session vanished mid-create")
        if url:
            await internal.page.goto(url, wait_until="domcontentloaded")
            await self._on_nav(session_key, internal)
        snap = await self.aria_snapshot(session_key)
        return {"liveViewUrl": session.live_view_url, **snap}

    async def get(self, session_key: str) -> _Internal | None:
        async with self._lock:
            internal = self._sessions.get(session_key)
            if internal is not None:
                self._sessions.move_to_end(session_key)
                internal.session.last_used_at = time.monotonic()
        return internal

    async def destroy(self, session_key: str) -> None:
        async with self._lock:
            internal = self._sessions.pop(session_key, None)
        if internal is None:
            return
        await self._teardown(session_key, internal)

    async def heartbeat(self, session_key: str) -> bool:
        internal = await self.get(session_key)
        return internal is not None

    async def check_current_login(self, session_key: str) -> dict[str, Any]:
        """Does the current page carry a login cookie, and which site does it
        belong to? Heuristic: a login exists iff there's an HttpOnly cookie
        applying to the current host (server-set session / auth cookies are
        almost always HttpOnly; analytics / ad cookies usually aren't).

        The site key is the cookie's own declared domain (leading dot
        stripped), broadest match wins — so one login spanning subdomains
        (`.google.com` across www/drive/mail) collapses to a single
        `google.com` entry instead of one row per visited host. Returns
        {hasLogin, host, loginDomain}; loginDomain is "" when not logged in."""
        empty = {"hasLogin": False, "host": "", "loginDomain": ""}
        internal = await self.get(session_key)
        if internal is None:
            return empty
        url = internal.page.url
        host = (urlparse(url).hostname or "").lower()
        if not host:
            return empty
        try:
            cookies = await internal.context.cookies([url])
        except Exception:
            return {"hasLogin": False, "host": host, "loginDomain": ""}
        login_domains: list[str] = []
        for c in cookies:
            if not c.get("httpOnly"):
                continue
            name = str(c.get("name") or "").lower()
            if not any(h in name for h in _AUTH_COOKIE_HINTS):
                continue
            dom = str(c.get("domain") or "").lstrip(".").lower()
            if dom and (host == dom or host.endswith("." + dom)):
                login_domains.append(dom)
        if not login_domains:
            return {"hasLogin": False, "host": host, "loginDomain": ""}
        # Broadest (shortest) domain the login cookie is scoped to = the site.
        login_domain = min(login_domains, key=len)
        return {"hasLogin": True, "host": host, "loginDomain": login_domain}

    async def clear_site_cookies(self, context_id: str, site_domain: str) -> None:
        """Clear one site's cookies + storage from a persistent Browserbase
        context. Opens a throwaway session bound to the context
        (persist:True), runs CDP `Storage.clearDataForOrigin` for the site
        origin, then releases so the deletion is written back to the context.

        One-shot maintenance op — independent of the session cache (not a
        user-facing session). Caveat: if the user has a live session on the
        same context concurrently, behavior is whatever Browserbase does for
        concurrent context use; in practice deletion happens while the user
        isn't actively browsing that site.
        """
        bb = self._bb_client()
        project_id = self._project_id()
        bb_session = await asyncio.to_thread(
            bb.sessions.create,
            project_id=project_id,
            keep_alive=False,
            timeout=_BB_SESSION_TIMEOUT_SEC,
            browser_settings={"context": {"id": context_id, "persist": True}},
        )
        pw_ctx = async_playwright()
        pw = await pw_ctx.__aenter__()
        try:
            browser = await pw.chromium.connect_over_cdp(
                bb_session.connect_url,
                timeout=_CDP_CONNECT_TIMEOUT_SEC * 1000,
            )
            contexts = browser.contexts
            if not contexts:
                raise RuntimeError(f"browserbase session {bb_session.id} has no context")
            context = contexts[0]
            page = context.pages[0] if context.pages else await context.new_page()
            cdp = await context.new_cdp_session(page)
            # cookies are domain-scoped, not origin-scoped — clear both schemes
            # so an http-set cookie doesn't survive an https delete.
            for scheme in ("https", "http"):
                with suppress(Exception):
                    await cdp.send(
                        "Storage.clearDataForOrigin",
                        {"origin": f"{scheme}://{site_domain}", "storageTypes": "all"},
                    )
            with suppress(Exception):
                await cdp.detach()
            with suppress(Exception):
                await browser.close()
            logger.info("browser: cleared site data ctx=%s domain=%s", context_id, site_domain)
        finally:
            with suppress(Exception):
                await pw_ctx.__aexit__(None, None, None)
            # Release the throwaway session so persist writes the deletion back.
            with suppress(Exception):
                await asyncio.to_thread(
                    bb.sessions.update,
                    bb_session.id,
                    project_id=project_id,
                    status="REQUEST_RELEASE",
                )

    async def shutdown_all(self) -> None:
        for task in (self._gc_task, self._health_task):
            if task is not None:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        self._gc_task = None
        self._health_task = None
        async with self._lock:
            items = list(self._sessions.items())
            self._sessions.clear()
        for sk, internal in items:
            await self._teardown(sk, internal)

    # ── control mode ──

    async def set_control_mode(
        self,
        session_key: str,
        mode: BrowserControlMode,
        *,
        reason: str | None = None,
    ) -> None:
        internal = await self.get(session_key)
        if internal is None:
            return
        internal.session.control_mode = mode
        internal.session.takeover_reason = reason if mode == BrowserControlMode.USER else None
        evt_type = "browser:control:takeover" if reason else "browser:control:granted"
        await self._publish(
            session_key,
            evt_type,
            {
                "sessionKey": session_key,
                "controlMode": mode.value,
                "reason": reason,
            },
        )

    async def release_to_ai_if_user_driving(self, session_key: str) -> bool:
        """Hand control back to the AI iff the user is currently driving.

        Called when the user sends a chat message: coming back to the
        conversation to tell the agent what to do next means they're done
        touching the browser, so we lift the takeover lock without making
        them click "give control back" first. Mirror image of
        `apply_user_input`'s "any user input implicitly takes control".
        No-op when there's no session or the AI already holds control;
        returns whether a release actually happened (for logging)."""
        internal = await self.get(session_key)
        if internal is None:
            return False
        if internal.session.control_mode != BrowserControlMode.USER:
            return False
        await self.set_control_mode(session_key, BrowserControlMode.AI)
        return True

    # ── live-view URL refresh (Browserbase signed URL TTL is short) ──

    async def refresh_live_view(self, session_key: str) -> str | None:
        internal = await self.get(session_key)
        if internal is None:
            return None
        bb = self._bb_client()
        debug = await asyncio.to_thread(bb.sessions.debug, internal.session.bb_session_id)
        url = (
            getattr(debug, "debugger_fullscreen_url", None)
            or getattr(debug, "debuggerFullscreenUrl", None)
            or ""
        )
        if not url:
            return None
        internal.session.live_view_url = url
        await self._emit_opened(internal)
        return url

    # ── device emulation (mobile/tablet; applied once at session create) ──

    @staticmethod
    async def _send_device_metrics(
        cdp: CDPSession,
        viewport: tuple[int, int],
        device_kind: DeviceKind,
        device_scale_factor: float,
    ) -> None:
        """Push viewport + DPR + mobile/touch flags over CDP at create so the
        page lays out for the device. NOTE: this does NOT resize a live
        Browserbase screencast — the capture surface is the window fixed at
        `browserSettings.viewport`; emulation only reflows layout. (Resizing
        the emulated viewport wider than the capture surface at runtime is
        exactly what crops the live view — so we never do it post-create; the
        live-view player downscales the fixed frame to fit the panel.)"""
        await cdp.send(
            "Emulation.setDeviceMetricsOverride",
            {
                "width": viewport[0],
                "height": viewport[1],
                "deviceScaleFactor": device_scale_factor,
                "mobile": device_kind != "desktop",
                "screenWidth": viewport[0],
                "screenHeight": viewport[1],
            },
        )
        if device_kind != "desktop":
            await cdp.send(
                "Emulation.setTouchEmulationEnabled",
                {"enabled": True, "maxTouchPoints": 5},
            )

    # ── snapshot + tool actions ──

    async def aria_snapshot(self, session_key: str) -> dict[str, Any]:
        """Returns ai-mode aria snapshot with refs (e1, e2, …). Use
        `aria-ref=eN` selectors for subsequent click / type / etc."""
        internal = await self.get(session_key)
        if internal is None:
            raise RuntimeError("no active browser session — call open first")
        page = internal.page
        snapshot = await page.locator("body").aria_snapshot(mode="ai", timeout=10_000)
        return {
            "url": page.url,
            "title": await page.title(),
            "tree": snapshot,
        }

    async def navigate(self, session_key: str, url: str) -> dict[str, Any]:
        internal = await self._gate(session_key, "navigate")
        await internal.page.goto(url, wait_until="domcontentloaded")
        await self._on_nav(session_key, internal)
        return await self._post_action_snapshot(session_key, "navigate")

    async def click_ref(self, session_key: str, ref: str) -> dict[str, Any]:
        internal = await self._gate(session_key, "click")
        await internal.page.locator(f"aria-ref={ref}").click(timeout=10_000)
        return await self._post_action_snapshot(session_key, "click")

    async def type_ref(
        self,
        session_key: str,
        ref: str,
        text: str,
        *,
        clear: bool = True,
    ) -> dict[str, Any]:
        internal = await self._gate(session_key, "type")
        loc = internal.page.locator(f"aria-ref={ref}")
        if clear:
            await loc.fill(text, timeout=10_000)
        else:
            await loc.click(timeout=10_000)
            await internal.page.keyboard.type(text)
        return await self._post_action_snapshot(session_key, "type")

    async def press_key(self, session_key: str, key: str) -> dict[str, Any]:
        internal = await self._gate(session_key, "press_key")
        await internal.page.keyboard.press(key)
        return await self._post_action_snapshot(session_key, "press_key")

    async def scroll(self, session_key: str, dx: int, dy: int) -> dict[str, Any]:
        internal = await self._gate(session_key, "scroll")
        await internal.page.mouse.wheel(dx, dy)
        return await self._post_action_snapshot(session_key, "scroll")

    async def wait_for(
        self,
        session_key: str,
        *,
        ms: int | None = None,
        url_contains: str | None = None,
    ) -> dict[str, Any]:
        internal = await self._gate(session_key, "wait")
        if url_contains:
            await internal.page.wait_for_url(
                f"**{url_contains}**",
                timeout=10_000,
            )
        else:
            await internal.page.wait_for_timeout(ms or 500)
        return await self._post_action_snapshot(session_key, "wait")

    async def go_back(self, session_key: str) -> dict[str, Any]:
        internal = await self._gate(session_key, "go_back")
        await internal.page.go_back(wait_until="domcontentloaded")
        await self._on_nav(session_key, internal)
        return await self._post_action_snapshot(session_key, "go_back")

    async def go_forward(self, session_key: str) -> dict[str, Any]:
        internal = await self._gate(session_key, "go_forward")
        await internal.page.go_forward(wait_until="domcontentloaded")
        await self._on_nav(session_key, internal)
        return await self._post_action_snapshot(session_key, "go_forward")

    async def reload_page(self, session_key: str) -> dict[str, Any]:
        internal = await self._gate(session_key, "reload")
        await internal.page.reload(wait_until="domcontentloaded")
        await self._on_nav(session_key, internal)
        return await self._post_action_snapshot(session_key, "reload")

    async def get_text(self, session_key: str, ref: str) -> str:
        internal = await self.get(session_key)
        if internal is None:
            raise RuntimeError("no active browser session")
        return (await internal.page.locator(f"aria-ref={ref}").inner_text(timeout=10_000)).strip()

    async def get_console(self, session_key: str, limit: int = 50) -> list[dict[str, Any]]:
        internal = await self.get(session_key)
        if internal is None:
            return []
        return list(internal.console)[-limit:]

    # ── user-driven input from the BrowserPanel UI ──

    async def apply_user_input(
        self,
        session_key: str,
        type_: str,
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Frontend POST /input dispatch. ANY user input implicitly takes
        control from AI (the user touching the page = the user driving), so
        they never have to click 'Take over' first. Touch input (`tap`) goes
        through raw CDP Input on the persistent cdp session — Playwright's
        page.tap can't be used over connectOverCDP. `tap` returns
        {editableFocused} so the frontend knows whether to raise the soft
        keyboard."""
        internal = await self.get(session_key)
        if internal is None:
            raise RuntimeError("session not found")
        if internal.session.control_mode != BrowserControlMode.USER:
            await self.set_control_mode(
                session_key,
                BrowserControlMode.USER,
                reason="You took control of the browser",
            )
        page = internal.page
        if type_ == "tap":
            x = float(payload["x"])
            y = float(payload["y"])
            await internal.cdp.send(
                "Input.dispatchTouchEvent",
                {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]},
            )
            await internal.cdp.send(
                "Input.dispatchTouchEvent",
                {"type": "touchEnd", "touchPoints": []},
            )
            # Frameworks often focus on the synthesized click after touchend —
            # let it settle, then report whether an editable element took focus
            # so the frontend can raise the soft keyboard.
            await page.wait_for_timeout(60)
            editable = await page.evaluate(_IS_EDITABLE_JS)
            return {"editableFocused": bool(editable)}
        if type_ == "text":
            text = str(payload.get("text") or "")
            if text:
                await page.keyboard.type(text)
        elif type_ == "key":
            await page.keyboard.press(str(payload.get("key") or ""))
        elif type_ == "click":
            await page.mouse.click(float(payload["x"]), float(payload["y"]))
        elif type_ == "scroll":
            await page.mouse.wheel(float(payload.get("dx") or 0), float(payload.get("dy") or 0))
        elif type_ == "navigate":
            await page.goto(str(payload["url"]), wait_until="domcontentloaded")
            await self._on_nav(session_key, internal)
        elif type_ == "back":
            await page.go_back(wait_until="domcontentloaded")
            await self._on_nav(session_key, internal)
        elif type_ == "forward":
            await page.go_forward(wait_until="domcontentloaded")
            await self._on_nav(session_key, internal)
        elif type_ == "reload":
            await page.reload(wait_until="domcontentloaded")
            await self._on_nav(session_key, internal)
        else:
            raise ValueError(f"unknown input type: {type_}")
        return None

    # ── internal: session bootstrap + teardown ──

    async def _create(
        self,
        session_key: str,
        persistent_context_id: str | None,
        *,
        viewport: tuple[int, int],
        device_kind: DeviceKind,
    ) -> BrowserSession:
        async with self._lock:
            while len(self._sessions) >= _MAX_SESSIONS:
                victim_key, victim = self._sessions.popitem(last=False)
                logger.info("browser: LRU evict %s", victim_key)
                asyncio.create_task(self._teardown(victim_key, victim))

        bb = self._bb_client()
        project_id = self._project_id()
        create_kwargs: dict[str, Any] = {
            "project_id": project_id,
            "keep_alive": False,
            "timeout": _BB_SESSION_TIMEOUT_SEC,
        }
        # Browserbase browserSettings — `viewport` sets the remote
        # chromium window size, which is what the live-view stream
        # captures. We deliberately don't use BB's `os` field for mobile
        # because it's gated behind Advanced Stealth (paid Scale plan);
        # instead we do full device emulation via CDP after the CDP
        # connect below, which works on any BB tier.
        bb_settings: dict[str, Any] = {
            "viewport": {"width": viewport[0], "height": viewport[1]},
        }
        if persistent_context_id:
            bb_settings["context"] = {"id": persistent_context_id, "persist": True}
        create_kwargs["browser_settings"] = bb_settings
        bb_session = await asyncio.to_thread(bb.sessions.create, **create_kwargs)
        debug = await asyncio.to_thread(bb.sessions.debug, bb_session.id)
        live_view_url = (
            getattr(debug, "debugger_fullscreen_url", None)
            or getattr(debug, "debuggerFullscreenUrl", None)
            or ""
        )

        pw_ctx = async_playwright()
        pw = await pw_ctx.__aenter__()
        try:
            browser = await pw.chromium.connect_over_cdp(
                bb_session.connect_url,
                timeout=_CDP_CONNECT_TIMEOUT_SEC * 1000,
            )
        except Exception:
            await pw_ctx.__aexit__(None, None, None)
            raise

        contexts = browser.contexts
        if not contexts:
            await pw_ctx.__aexit__(None, None, None)
            raise RuntimeError(f"browserbase session {bb_session.id} has no context")
        context = contexts[0]
        page = context.pages[0] if context.pages else await context.new_page()

        # One persistent CDP session, kept for the session's life: used here
        # for mobile/tablet device emulation and later for user touch input
        # dispatch (Input.*). It's the same command set Playwright's
        # `browser.new_context(**devices[...])` emits internally — works on any
        # Browserbase tier (no Advanced Stealth): realistic UA, mobile=true
        # (sets isMobile / maxTouchPoints), touch enabled, and a CSS-px viewport
        # matching the user's panel. The BB window was created at `viewport`
        # size, so the streamed live view matches what we override here.
        cdp = await context.new_cdp_session(page)
        device_scale_factor = 1.0
        if device_kind != "desktop":
            preset = pw.devices.get(_DEVICE_PRESET[device_kind], {})
            device_scale_factor = float(preset.get("device_scale_factor", 2))
            await self._send_device_metrics(cdp, viewport, device_kind, device_scale_factor)
            ua = preset.get("user_agent")
            if ua:
                await cdp.send(
                    "Network.setUserAgentOverride",
                    {"userAgent": ua, "acceptLanguage": "en-US,en;q=0.9"},
                )

        # The viewport we requested is authoritative — page.viewport_size
        # over CDP can return None or stale defaults before the first
        # render commits. The frontend uses this for fit-to-height scaling
        # so it has to match what BB is actually rendering at.
        now = time.monotonic()
        session = BrowserSession(
            session_key=session_key,
            bb_session_id=bb_session.id,
            live_view_url=live_view_url,
            viewport={"width": viewport[0], "height": viewport[1]},
            device_kind=device_kind,
            control_mode=BrowserControlMode.AI,
            takeover_reason=None,
            current_url=page.url,
            created_at=now,
            last_used_at=now,
        )

        async def _stop_pw() -> None:
            with suppress(Exception):
                await pw_ctx.__aexit__(None, None, None)

        internal = _Internal(
            session=session,
            browser=browser,
            context=context,
            page=page,
            pw_stop=_stop_pw,
            cdp=cdp,
        )

        # Capture page console messages for the `console` tool action.
        def _on_console(msg: ConsoleMessage) -> None:
            internal.console.append(
                {
                    "at": int(time.time() * 1000),
                    "level": msg.type,
                    "text": msg.text,
                }
            )

        page.on("console", _on_console)

        async with self._lock:
            self._sessions[session_key] = internal
            self._sessions.move_to_end(session_key)

        await self._emit_opened(internal)
        logger.info(
            "browser: created sk=%s bb=%s ctx=%s",
            session_key,
            bb_session.id,
            persistent_context_id or "ephemeral",
        )
        self._ensure_background_tasks()
        return session

    async def _teardown(
        self,
        session_key: str,
        internal: _Internal,
    ) -> None:
        with suppress(Exception):
            await internal.cdp.detach()
        with suppress(Exception):
            await internal.browser.close()
        await internal.pw_stop()
        bb = self._bb
        if bb is not None:
            with suppress(Exception):
                await asyncio.to_thread(
                    bb.sessions.update,
                    internal.session.bb_session_id,
                    project_id=self._project_id(),
                    status="REQUEST_RELEASE",
                )
        await self._publish(
            session_key,
            EV_BROWSER_CLOSED,
            {
                "sessionKey": session_key,
                "bbSessionId": internal.session.bb_session_id,
            },
        )
        browser_events.clear_session(session_key)
        logger.info("browser: destroyed sk=%s", session_key)

    # ── helpers ──

    async def _gate(self, session_key: str, action: str) -> _Internal:
        internal = await self.get(session_key)
        if internal is None:
            raise RuntimeError("no active browser session — call open first")
        assert_browser_action_allowed(internal.session.control_mode, action)
        return internal

    async def _on_nav(self, session_key: str, internal: _Internal) -> None:
        url = internal.page.url
        internal.session.current_url = url
        title = ""
        with suppress(PlaywrightError):
            title = await internal.page.title()
        await self._publish(
            session_key,
            EV_BROWSER_NAVIGATED,
            {
                "sessionKey": session_key,
                "url": url,
                "title": title,
            },
        )

    async def _post_action_snapshot(
        self,
        session_key: str,
        action: str,
    ) -> dict[str, Any]:
        # SPA frameworks (React/Vue/Svelte) commit DOM after a microtask;
        # 400ms catches all but the slowest XHR-driven re-renders.
        internal = await self.get(session_key)
        if internal is None:
            return {"ok": False, "action": action, "error": "session destroyed"}
        await internal.page.wait_for_timeout(_POST_ACTION_SETTLE_MS)
        snap = await self.aria_snapshot(session_key)
        return {"ok": True, "action": action, **snap}

    async def _emit_opened(self, internal: _Internal) -> None:
        s = internal.session
        await self._publish(
            s.session_key,
            EV_BROWSER_OPENED,
            {
                "sessionKey": s.session_key,
                "bbSessionId": s.bb_session_id,
                "liveViewUrl": s.live_view_url,
                "viewport": s.viewport,
                "deviceKind": s.device_kind,
                "controlMode": s.control_mode.value,
                "takeoverReason": s.takeover_reason,
                "url": s.current_url,
            },
        )

    async def _publish(
        self,
        session_key: str,
        evt_type: str,
        data: dict,
    ) -> None:
        # Construct via the camelCase alias: mypy models pydantic through
        # dataclass_transform, which uses field aliases and does not honor
        # populate_by_name, so `trace_id=` (valid at runtime) is rejected
        # statically. The alias works under both configs.
        ev = SSEEvent(
            type=evt_type,
            ts=int(time.time() * 1000),
            traceId=session_key,
            data=data,
        )
        await browser_events.publish(session_key, ev.to_wire())

    def _ensure_background_tasks(self) -> None:
        if self._gc_task is None or self._gc_task.done():
            self._gc_task = asyncio.create_task(
                self._idle_gc_loop(),
                name="browser-idle-gc",
            )
        if self._health_task is None or self._health_task.done():
            self._health_task = asyncio.create_task(
                self._health_check_loop(),
                name="browser-health-check",
            )

    async def _idle_gc_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(60)
                now = time.monotonic()
                evictions: list[tuple[str, _Internal]] = []
                async with self._lock:
                    for sk, internal in list(self._sessions.items()):
                        if (now - internal.session.last_used_at) > _IDLE_TIMEOUT_SEC:
                            evictions.append((sk, internal))
                            self._sessions.pop(sk, None)
                for sk, internal in evictions:
                    logger.info("browser: idle GC sk=%s", sk)
                    await self._teardown(sk, internal)
        except asyncio.CancelledError:
            return

    async def _health_check_loop(self) -> None:
        """Poll BB session status every 60s. Tear down locally when the
        remote browser is gone (Browserbase session_timeout, network
        partition, manual release) so we don't keep handing out a dead
        live_view_url to the frontend."""
        try:
            while True:
                await asyncio.sleep(_HEALTH_CHECK_INTERVAL_SEC)
                snapshot: list[tuple[str, str]] = []
                async with self._lock:
                    snapshot = [
                        (sk, internal.session.bb_session_id)
                        for sk, internal in self._sessions.items()
                    ]
                if not snapshot:
                    continue
                bb = self._bb
                if bb is None:
                    continue
                for sk, bb_id in snapshot:
                    try:
                        info = await asyncio.to_thread(bb.sessions.retrieve, bb_id)
                    except Exception as e:
                        logger.warning("health check sk=%s err: %s", sk, e)
                        continue
                    status = getattr(info, "status", None)
                    if status in _DEAD_BB_STATUSES:
                        logger.info("browser: health detected dead sk=%s status=%s", sk, status)
                        await self.destroy(sk)
        except asyncio.CancelledError:
            return


_singleton: BrowserManager | None = None


def get_browser_manager() -> BrowserManager:
    global _singleton
    if _singleton is None:
        _singleton = BrowserManager()
    return _singleton
