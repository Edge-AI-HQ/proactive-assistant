"""Composio REST client + identity cache.

We use Composio's REST API directly (not the Python SDK) because the
endpoint surface is small (/auth_configs, /connected_accounts) and the
SDK adds significant deps for what amounts to a few HTTP calls.

Multi-tenancy: pinai-agents runs one Composio org-level API key shared
across all users. Per-user separation comes from passing each user's
internal `user_id` (str) as Composio's `user_id` field — that scopes
their connected accounts on the Composio side.

Identity cache: connected_accounts often returns no user_info; we
optionally fetch it via a per-toolkit GET-style action (e.g.
GMAIL_GET_PROFILE) and cache for 24h. The TS plugin had a file-backed
cache; the Python port uses an in-memory dict (process-local). Lost on
restart, repopulated on next /connections call. Acceptable for the
side effect.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_BASE_V3 = "https://backend.composio.dev/api/v3"
_BASE_V2 = "https://backend.composio.dev/api/v2"
_IDENTITY_TTL_SEC = 24 * 60 * 60

# Toolkit slug → identity-fetch action id. Composio actions return
# {data: {response_data: {...}}} on success; we cache the inner dict.
# Only add a toolkit here if the action is verified to exist — speculative
# slugs cause silent 404s + cache misses every time the user opens the
# connections page. The plugin (TS) shipped with gmail/slack/github/linkedin
# only; calendly is added here because the connector ingest path already
# proves CALENDLY_GET_USER works.
_IDENTITY_ACTIONS: dict[str, str] = {
    "gmail": "GMAIL_GET_PROFILE",
    "slack": "SLACK_LIST_AUTH_IDENTITY",
    "github": "GITHUB_GET_THE_AUTHENTICATED_USER",
    "linkedin": "LINKEDIN_LINKEDIN_GET_CURRENT_USER_PROFILE",
    "calendly": "CALENDLY_GET_USER",
}

# In-memory cache: connectedAccountId → (userInfo, ts).
_identity_cache: dict[str, tuple[dict[str, Any], float]] = {}
_identity_lock = asyncio.Lock()


class ComposioError(Exception):
    """Raised on non-2xx Composio API responses."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"Composio API {status_code}: {message}")
        self.status_code = status_code


async def _request(
    api_key: str, path: str, *,
    method: str = "GET", json_body: dict[str, Any] | None = None,
    base: str = _BASE_V3,
) -> dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
    }
    async with httpx.AsyncClient(timeout=30.0) as cli:
        resp = await cli.request(
            method, f"{base}{path}", headers=headers, json=json_body,
        )
    text = resp.text
    if not resp.is_success:
        # Surface composio's error message verbatim — frontend may show it.
        try:
            data = resp.json()
            msg = str(data.get("message") or data.get("error") or text[:200])
        except Exception:
            msg = text[:200]
        raise ComposioError(resp.status_code, msg)
    if not text.strip():
        return {}
    return resp.json()


def composio_user_id(internal_user_id: int) -> str:
    """Pin AI internal id → Composio user_id. Stable namespace prefix
    so a Composio dashboard query can identify pinai-agents users."""
    return f"pai-{internal_user_id}"


async def status(api_key: str | None) -> dict[str, Any]:
    """Public — no Composio call. Just reports whether the env key is
    configured. Frontend uses this to gate the connect UX."""
    if not api_key:
        return {"configured": False, "keyPrefix": None}
    return {"configured": True, "keyPrefix": api_key[:6] + "…"}


async def list_connections(
    api_key: str, internal_user_id: int,
) -> list[dict[str, Any]]:
    """List ACTIVE connections for the user. Enriches each with
    user_info (from cache or per-toolkit identity action)."""
    user_id = composio_user_id(internal_user_id)
    data = await _request(
        api_key,
        f"/connected_accounts?user_ids={user_id}&statuses=ACTIVE&limit=100",
    )
    items = data.get("items") or []
    out: list[dict[str, Any]] = []
    for item in items:
        cid = item.get("id") or item.get("connected_account_id")
        toolkit = item.get("toolkit", {})
        toolkit_slug = (
            toolkit.get("slug") if isinstance(toolkit, dict) else toolkit
        ) or "unknown"
        toolkit_slug = str(toolkit_slug).lower()
        user_info = item.get("user_info") or item.get("current_user_info")
        if not user_info and cid:
            user_info = await _resolve_identity(api_key, toolkit_slug, user_id, cid)
        out.append({
            "toolkit": toolkit_slug,
            "status": str(item.get("status") or "NOT_CONNECTED").upper(),
            "connectedAccountId": cid,
            "userInfo": user_info,
        })
    # Drop cache entries for removed accounts.
    active_ids = {c["connectedAccountId"] for c in out if c["connectedAccountId"]}
    async with _identity_lock:
        for stale in [k for k in _identity_cache if k not in active_ids]:
            _identity_cache.pop(stale, None)
    return out


async def _resolve_identity(
    api_key: str, toolkit: str, user_id: str, connected_account_id: str,
) -> dict[str, Any] | None:
    """Cache → fall back to identity action. None on failure."""
    now = time.time()
    async with _identity_lock:
        cached = _identity_cache.get(connected_account_id)
        if cached and (now - cached[1]) < _IDENTITY_TTL_SEC:
            return cached[0]

    action_id = _IDENTITY_ACTIONS.get(toolkit)
    if not action_id:
        return None
    try:
        result = await _request(
            api_key, f"/actions/{action_id}/execute",
            method="POST",
            json_body={"appName": toolkit, "entityId": user_id, "input": {}},
            base=_BASE_V2,
        )
    except ComposioError:
        return None
    data = result.get("data") or {}
    response_data = data.get("response_data") if isinstance(data, dict) else None
    final = response_data if response_data else data
    if not isinstance(final, dict) or not final:
        return None
    async with _identity_lock:
        _identity_cache[connected_account_id] = (final, now)
    return final


async def connect_toolkit(
    api_key: str, internal_user_id: int, toolkit: str,
) -> dict[str, Any]:
    """Initiate OAuth: get/create auth_config, then /link to get the
    redirect URL the user has to follow. Returns
    {toolkit, status, connectedAccountId, redirectUrl}."""
    toolkit = toolkit.strip().lower()
    if not toolkit:
        msg = "toolkit required"
        raise ValueError(msg)
    user_id = composio_user_id(internal_user_id)

    # Step 1: find or create auth config for this toolkit (Composio-managed).
    cfg_list = await _request(
        api_key,
        f"/auth_configs?toolkit_slug={toolkit}&is_composio_managed=true&limit=20",
    )
    items = cfg_list.get("items") or []
    auth_config_id = items[0].get("id") if items else None
    if not auth_config_id:
        created = await _request(
            api_key, "/auth_configs", method="POST",
            json_body={"toolkit": {"slug": toolkit}},
        )
        nested = created.get("auth_config") or {}
        auth_config_id = nested.get("id") or created.get("id")
    if not auth_config_id:
        msg = f"failed to resolve auth_config for {toolkit}"
        raise ComposioError(500, msg)

    # Step 2: link → returns redirect URL + connectedAccountId.
    linked = await _request(
        api_key, "/connected_accounts/link", method="POST",
        json_body={"auth_config_id": auth_config_id, "user_id": user_id},
    )
    cid = (
        linked.get("connected_account_id")
        or linked.get("connectedAccountId")
        or linked.get("id")
    )
    redirect = linked.get("redirect_url") or linked.get("redirectUrl")
    if not cid or not redirect:
        msg = f"link response missing fields (keys={list(linked.keys())})"
        raise ComposioError(500, msg)
    return {
        "toolkit": toolkit, "status": "PENDING",
        "connectedAccountId": cid, "redirectUrl": redirect,
    }


async def disconnect(api_key: str, connected_account_id: str) -> None:
    if not connected_account_id:
        msg = "connectedAccountId required"
        raise ValueError(msg)
    await _request(
        api_key, f"/connected_accounts/{connected_account_id}",
        method="DELETE",
    )
    async with _identity_lock:
        _identity_cache.pop(connected_account_id, None)


async def wait_for_active(
    api_key: str, connected_account_id: str,
    *, timeout_sec: float = 120.0, poll_sec: float = 2.0,
) -> dict[str, Any]:
    """Poll /connected_accounts/{id} until status=ACTIVE or timeout.

    Returns {status, connectedAccountId, toolkit?}. Caller can dispatch
    a connector-init background task on ACTIVE detection.
    """
    started = time.monotonic()
    last_toolkit: str | None = None
    while (time.monotonic() - started) < timeout_sec:
        try:
            account = await _request(
                api_key, f"/connected_accounts/{connected_account_id}",
            )
            status_v = str(account.get("status") or "").upper()
            toolkit = account.get("toolkit", {})
            last_toolkit = (
                toolkit.get("slug") if isinstance(toolkit, dict) else toolkit
            ) or last_toolkit
            if status_v == "ACTIVE":
                return {
                    "status": "ACTIVE",
                    "connectedAccountId": connected_account_id,
                    "toolkit": str(last_toolkit).lower() if last_toolkit else None,
                }
        except ComposioError as e:
            # 404 — account not yet visible. Keep polling.
            logger.debug("composio wait poll: %s", e)
        await asyncio.sleep(poll_sec)
    return {
        "status": "TIMEOUT",
        "connectedAccountId": connected_account_id,
        "toolkit": str(last_toolkit).lower() if last_toolkit else None,
    }
