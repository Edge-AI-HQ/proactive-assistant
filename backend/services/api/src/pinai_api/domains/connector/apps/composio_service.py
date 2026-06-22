"""Composio integration — single source of truth.

This module replaces the prior `web/composio.py` (manual REST calls).
It exposes three concern groups, all backed by the official Composio
Python SDK (sync) wrapped in `asyncio.to_thread`:

  1. SDK direct: connection lifecycle + tool discovery + execute.
     Used by the Programmatic path (workers, ingest_runner) and by the
     SDK code-mode path (sandbox `client.composio.*` HTTP-forwarded
     to `/api/agent/composio/{search,schema,execute,multi_execute}`).
  2. Session pool: per-user `ToolRouterSession` cached LRU + TTL, used
     to forward Composio meta-tool calls from chat process native @tools.
  3. Label resolution: per-toolkit "get me" actions whose result is
     persisted to `pai_connector_labels` (migration 040) at OAuth-
     completion time. Authoritative source for the per-account display
     name surfaced to the UI and (later) the chat agent's
     account-disambiguation prompt.

Trust split: lives in `web/` and reads `composio_api_key` only from web
settings. Chat / sandbox never import this module — they always go
through the HTTP routes in `web/routes/agent/composio.py`.

Side-effect gate: deferred this iteration. See
docs/plans/2026-05-07-composio-architecture-redesign.mdx Open questions.
The session-creation `tools=` allowlist (caller-supplied, not enforced
here) is the current physical guard against high-risk slugs.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, cast

from composio import Composio
from composio.exceptions import ComposioError as _SDKComposioError
from composio.exceptions import HTTPError as _SDKHTTPError

# composio_client errors are a parallel hierarchy from the underlying
# REST client. They derive from their own ComposioError base (NOT the
# composio.exceptions one), so a separate except clause is needed; we
# discovered this when SLACK_LIST_AUTH_IDENTITY raised
# composio_client.NotFoundError mid-request and propagated past our
# narrower handler. APIStatusError covers the 4xx/5xx surface
# (NotFoundError, BadRequestError, etc.); APIError is the broader base
# for non-HTTP failures.
from composio_client import APIError as _SDKClientAPIError
from composio_client import APIStatusError as _SDKClientStatusError
from composio_client._types import omit
from composio_client.types.auth_config_create_params import (
    AuthConfigUnionMember1,
    AuthConfigUnionMember1Credentials,
)
from pydantic import BaseModel, Field

from pinai_api.config import get_web_settings

from ....platform.auth.user_service import User

logger = logging.getLogger(__name__)

# Subset of the SDK's auth_scheme Literal we accept for custom auth.
_CustomAuthScheme = Literal["OAUTH2", "API_KEY", "BEARER_TOKEN", "BASIC"]


# ── Models ─────────────────────────────────────────────────────────────


type ConnectionStatus = Literal[
    "ACTIVE",
    "INITIALIZING",
    "INITIATED",
    "FAILED",
    "EXPIRED",
    "INACTIVE",
    "REVOKED",
]


class Connection(BaseModel):
    toolkit: str
    status: ConnectionStatus
    connected_account_id: str
    label: str | None = None
    user_info: dict[str, Any] | None = None


class ConnectInit(BaseModel):
    toolkit: str
    status: Literal["PENDING"] = "PENDING"
    connected_account_id: str = Field(alias="connectedAccountId")
    redirect_url: str = Field(alias="redirectUrl")

    model_config = {"populate_by_name": True}


class ToolHit(BaseModel):
    slug: str
    toolkit: str
    name: str
    description: str
    tags: list[str] = Field(default_factory=list)


class ToolSchema(BaseModel):
    slug: str
    toolkit: str
    name: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    tags: list[str] = Field(default_factory=list)
    scopes: list[str] = Field(default_factory=list)


class ExecuteCall(BaseModel):
    slug: str
    args: dict[str, Any] = Field(default_factory=dict)
    connected_account_id: str | None = None


class ExecuteResult(BaseModel):
    slug: str
    successful: bool
    data: Any | None = None
    error: str | None = None


# ── Exceptions ─────────────────────────────────────────────────────────


class ComposioError(Exception):
    """Normalized Composio-side failure. `status_code` is HTTP-shaped:
    0 = configuration error (no API key); 4xx for client errors; 5xx for
    upstream errors. Routes map to FastAPI HTTPException accordingly."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"Composio API {status_code}: {message}")
        self.status_code = status_code


# ── SDK client (lazy singleton) ────────────────────────────────────────


_client: Composio | None = None


def _composio() -> Composio:
    """Lazy singleton. First call validates that COMPOSIO_API_KEY is set;
    raises `ComposioError(0)` if not so callers get a clean 4xx surface
    instead of a TypeError deep in the SDK."""
    global _client
    if _client is None:
        s = get_web_settings()
        if not s.composio_api_key:
            msg = "COMPOSIO_API_KEY not configured"
            raise ComposioError(0, msg)
        _client = Composio(api_key=s.composio_api_key)
    return _client


def composio_user_id(user: User) -> str:
    """Pin AI user → Composio user_id. Uses Supabase UUID (not internal
    BIGINT) so the namespace is stable across environments and never
    collides with another env's recycled SERIAL id. Stable `pai-` prefix
    so a Composio dashboard query can identify backend users.
    See AGENTS.md "用户标识规约"."""
    return f"pai-{user.supabase_user_id}"


async def _to_thread(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Wrap sync SDK call in a thread. Translates SDK errors into
    `ComposioError`. Programmer bugs (TypeError / AttributeError) fall
    through so we don't mask logic errors as upstream failures."""
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except _SDKClientStatusError as e:
        # composio_client 4xx/5xx (NotFoundError, BadRequestError, etc.).
        # `status_code` attribute is reliably set on these.
        code = getattr(e, "status_code", None) or 502
        raise ComposioError(int(code), str(e)) from e
    except _SDKHTTPError as e:
        # composio.exceptions.HTTPError — the higher-level wrapper layer.
        code = getattr(e, "status_code", None) or 502
        raise ComposioError(int(code), str(e)) from e
    except _SDKClientAPIError as e:
        # composio_client non-HTTP errors (connection / timeout). Treat
        # as upstream-broken so callers retry rather than fail-fast.
        raise ComposioError(502, str(e)) from e
    except _SDKComposioError as e:
        # composio.* validation / missing-tool / etc. Caller's fault by
        # default; we don't attempt to discriminate further.
        raise ComposioError(400, str(e)) from e


# ── Identity / label resolution ────────────────────────────────────────
#
# Composio does NOT populate identity on the connected_account object —
# each toolkit needs its own "get me" action call. We resolve once at
# OAuth-completion time and persist to pai_connector_labels (migration
# 040); list_connections then joins from DB at ~0 latency.
#
# Per-toolkit spec: action slug + (often empty) extra args + extractor.
# The extractor reads the action's response shape and pulls out the
# most unique-and-stable label (typically email or handle).
#
# Stripe is intentionally absent — Composio's catalog doesn't expose an
# account-retrieve action. Stripe connections fall back to
# `fallback_label()` ("Stripe (...cid-suffix)").


@dataclass(frozen=True)
class _IdentitySpec:
    action: str
    args: dict[str, Any]
    extract: Callable[[dict[str, Any]], str | None]


def _gmail_label(d: dict[str, Any]) -> str | None:
    return _first_str(d.get("emailAddress"), d.get("email"))


def _slack_label(d: dict[str, Any]) -> str | None:
    user = d.get("user")
    user = user if isinstance(user, dict) else {}
    return _first_str(user.get("email"), user.get("real_name"), user.get("name"))


def _github_label(d: dict[str, Any]) -> str | None:
    return _first_str(d.get("login"), d.get("email"), d.get("name"))


def _linkedin_label(d: dict[str, Any]) -> str | None:
    name = d.get("name")
    if isinstance(name, dict):
        first = _first_str(name.get("first_name"), name.get("localized"))
        last = _first_str(name.get("last_name"))
        joined = " ".join(s for s in (first, last) if s)
        if joined:
            return joined
    return _first_str(d.get("email"), name if isinstance(name, str) else None)


def _calendly_label(d: dict[str, Any]) -> str | None:
    resource = d.get("resource")
    resource = resource if isinstance(resource, dict) else d
    return _first_str(resource.get("email"), resource.get("name"))


def _googledrive_label(d: dict[str, Any]) -> str | None:
    # GOOGLEDRIVE_GET_ABOUT response shape: {user: {emailAddress, displayName, ...}, ...}.
    user = d.get("user")
    user = user if isinstance(user, dict) else {}
    return _first_str(user.get("emailAddress"), user.get("displayName"))


def _googlecalendar_label(d: dict[str, Any]) -> str | None:
    # GOOGLECALENDAR_GET_CALENDAR(calendar_id="primary"): primary calendar's
    # `id` IS the user's email per Google Calendar API convention.
    return _first_str(d.get("id"), d.get("summary"))


def _youtube_label(d: dict[str, Any]) -> str | None:
    # YOUTUBE_GET_CHANNEL_STATISTICS(mine=true, part="snippet,statistics"):
    # response shape: {items: [{snippet: {title, customUrl, ...}, ...}, ...], ...}
    items = d.get("items")
    if not isinstance(items, list) or not items:
        return None
    first = items[0]
    if not isinstance(first, dict):
        return None
    snippet = first.get("snippet")
    snippet = snippet if isinstance(snippet, dict) else {}
    return _first_str(snippet.get("customUrl"), snippet.get("title"))


def _first_str(*values: Any) -> str | None:
    for v in values:
        if isinstance(v, str):
            s = v.strip()
            if s:
                return s
    return None


_IDENTITY_SPECS: dict[str, _IdentitySpec] = {
    "gmail": _IdentitySpec("GMAIL_GET_PROFILE", {}, _gmail_label),
    # googlesuper bundles gmail/gcal/gdrive behind one OAuth account; the
    # gmail profile action works on its token and yields the Google email
    # the fanned-out sub-sources share as their display identity.
    "googlesuper": _IdentitySpec("GMAIL_GET_PROFILE", {}, _gmail_label),
    "slack": _IdentitySpec("SLACK_RETRIEVE_A_USER_S_IDENTITY_DETAILS", {}, _slack_label),
    "github": _IdentitySpec("GITHUB_GET_THE_AUTHENTICATED_USER", {}, _github_label),
    "linkedin": _IdentitySpec("LINKEDIN_GET_MY_INFO", {}, _linkedin_label),
    "calendly": _IdentitySpec("CALENDLY_GET_USER", {}, _calendly_label),
    "googledrive": _IdentitySpec("GOOGLEDRIVE_GET_ABOUT", {}, _googledrive_label),
    "googlecalendar": _IdentitySpec(
        # No "get user info" action exists; Google Calendar API convention
        # is that primary calendar's id equals the user's email.
        "GOOGLECALENDAR_GET_CALENDAR",
        {"calendar_id": "primary"},
        _googlecalendar_label,
    ),
    "youtube": _IdentitySpec(
        "YOUTUBE_GET_CHANNEL_STATISTICS",
        {"mine": True, "part": "snippet,statistics"},
        _youtube_label,
    ),
}


def fallback_label(toolkit: str, connected_account_id: str) -> str:
    """Last-resort label when identity action is unavailable / failed.
    Stable + unique per connected_account_id."""
    suffix = connected_account_id[-6:] if connected_account_id else "?"
    return f"{toolkit} (...{suffix})"


async def _call_identity_action(
    toolkit: str,
    cx_user: str,
    connected_account_id: str,
) -> dict[str, Any] | None:
    """Fire the per-toolkit identity action, return its normalized data
    dict. Returns None if the toolkit has no spec; raises ComposioError
    on upstream failure so the caller can record the attempt."""
    spec = _IDENTITY_SPECS.get(toolkit)
    if spec is None:
        return None
    resp = await _to_thread(
        _composio().tools.execute,
        spec.action,
        dict(spec.args),
        user_id=cx_user,
        connected_account_id=connected_account_id,
        dangerously_skip_version_check=True,
    )
    data = _normalize_response_data(resp)
    return data if isinstance(data, dict) else None


async def resolve_and_persist_label(
    pool: Any,
    user: User,
    connected_account_id: str,
    toolkit: str,
) -> str | None:
    """Call this toolkit's identity action, extract the label, and write
    the result (success or failure) into pai_connector_labels. Returns
    the resolved label, or None if resolution failed / toolkit has no
    spec — callers should fall back to `fallback_label()` for UI.

    Failure modes are recorded (resolve_attempts + last_attempt_error)
    so /api/composio/connections can lazy-retry within a bounded budget.
    """
    from pinai_db.rls import user_scoped_tx  # noqa: PLC0415

    from .connector_labels import ConnectorLabelsRepository  # noqa: PLC0415

    spec = _IDENTITY_SPECS.get(toolkit)
    if spec is None:
        # No identity action exposed for this toolkit (e.g. Stripe). Still
        # write the row so list_connections sees a "resolved with None
        # label" entry and stops asking.
        async with user_scoped_tx(pool, user.id) as conn:
            await ConnectorLabelsRepository(user.id, conn).upsert_resolved(
                connected_account_id=connected_account_id,
                toolkit=toolkit,
                label=None,
                raw_user_info=None,
            )
        return None

    cx_user = composio_user_id(user)
    try:
        raw = await _call_identity_action(toolkit, cx_user, connected_account_id)
    except ComposioError as e:
        logger.warning(
            "composio: identity action failed user=%s tk=%s cid=%s: %s",
            user.id,
            toolkit,
            connected_account_id,
            e,
        )
        async with user_scoped_tx(pool, user.id) as conn:
            await ConnectorLabelsRepository(user.id, conn).record_attempt_failure(
                connected_account_id=connected_account_id,
                toolkit=toolkit,
                error=str(e),
            )
        return None

    from ....domains.billing.metering import (  # noqa: PLC0415
        estimate_composio_tool_call_charge,
        record_provider_usage_charge,
    )

    charge = estimate_composio_tool_call_charge(
        tool_calls=1,
        source="composio:identity",
        metadata={"toolkit": toolkit, "action": spec.action},
    )
    await record_provider_usage_charge(
        pool,
        user_id=user.id,
        supabase_user_id=user.supabase_user_id,
        charge=charge,
    )

    label = spec.extract(raw) if raw else None
    async with user_scoped_tx(pool, user.id) as conn:
        await ConnectorLabelsRepository(user.id, conn).upsert_resolved(
            connected_account_id=connected_account_id,
            toolkit=toolkit,
            label=label,
            raw_user_info=raw,
        )
    return label


async def delete_label(
    pool: Any,
    user: User,
    connected_account_id: str,
) -> None:
    from pinai_db.rls import user_scoped_tx  # noqa: PLC0415

    from .connector_labels import ConnectorLabelsRepository  # noqa: PLC0415

    async with user_scoped_tx(pool, user.id) as conn:
        await ConnectorLabelsRepository(user.id, conn).delete(
            connected_account_id,
        )


def _toolkit_slug(toolkit_field: Any) -> str:
    """Extract toolkit slug from the various shapes Composio returns:
    * dict {slug: ..., name: ..., logo: ...}
    * Pydantic model with .slug attribute (newer SDK versions)
    * raw string
    * None / unknown → 'unknown'
    """
    if toolkit_field is None:
        return "unknown"
    if isinstance(toolkit_field, str):
        return toolkit_field.lower()
    if isinstance(toolkit_field, dict):
        slug = toolkit_field.get("slug")
        return str(slug).lower() if slug else "unknown"
    slug = getattr(toolkit_field, "slug", None)
    if slug:
        return str(slug).lower()
    return "unknown"


def _normalize_response_data(resp: Any) -> dict[str, Any] | Any:
    """Composio responses wrap as `{data: {...}, successful, error}`.
    Walk to the inner data dict for downstream consumption; if it has
    a `response_data` deeper layer, prefer that."""
    if hasattr(resp, "model_dump"):
        resp = resp.model_dump()
    if not isinstance(resp, dict):
        return resp
    data = resp.get("data") if "data" in resp else resp
    if isinstance(data, dict) and "response_data" in data:
        rd = data["response_data"]
        if isinstance(rd, dict):
            return rd
    return data


# ── Connection lifecycle ───────────────────────────────────────────────


async def list_connections(user: User) -> list[Connection]:
    """List ACTIVE connected accounts for the user. Pure SDK call — does
    NOT enrich with labels; the route joins pai_connector_labels itself
    (see `composio_connections` in routes/ui/composio.py).

    Callers that need labels should go through the route or query the
    repository directly. Tool Router session building only needs cid +
    toolkit, so it's unaffected."""
    cx_user = composio_user_id(user)

    def _list() -> Any:
        return _composio().connected_accounts.list(
            user_ids=[cx_user],
            statuses=["ACTIVE"],
            limit=100,
        )

    resp = await _to_thread(_list)
    items = getattr(resp, "items", None) or []

    out: list[Connection] = []
    for item in items:
        d = item.model_dump() if hasattr(item, "model_dump") else dict(item)
        cid = d.get("id") or d.get("connected_account_id")
        if not cid:
            continue
        out.append(
            Connection(
                toolkit=_toolkit_slug(d.get("toolkit")),
                status=str(d.get("status") or "INACTIVE").upper(),  # type: ignore[arg-type]
                connected_account_id=cid,
                user_info=d.get("user_info") or d.get("current_user_info"),
            )
        )

    return out


async def connect(user: User, toolkit: str) -> ConnectInit:
    """Initiate OAuth: ensure auth_config exists for the toolkit, then
    link → returns a redirect URL the user opens to complete OAuth."""
    toolkit = toolkit.strip().lower()
    if not toolkit:
        msg = "toolkit required"
        raise ValueError(msg)
    cx_user = composio_user_id(user)

    # Step 1: find a Composio-managed auth_config for this toolkit.
    def _list_cfg() -> Any:
        return _composio().auth_configs.list(
            toolkit_slug=toolkit,
            is_composio_managed=True,
            limit=20,
        )

    cfg_resp = await _to_thread(_list_cfg)
    items = getattr(cfg_resp, "items", None) or []
    auth_config_id: str | None = None
    if items:
        first = items[0]
        d = first.model_dump() if hasattr(first, "model_dump") else dict(first)
        auth_config_id = d.get("id")

    if not auth_config_id:
        # Create one. Composio-managed = no credentials options needed
        # (Composio supplies the OAuth client).
        def _create_cfg() -> Any:
            return _composio().auth_configs.create(
                toolkit=toolkit,
                options={"type": "use_composio_managed_auth"},
            )

        created = await _to_thread(_create_cfg)
        d = created.model_dump() if hasattr(created, "model_dump") else dict(created)
        auth_config_id = d.get("id") or (d.get("auth_config") or {}).get("id")

    if not auth_config_id:
        msg = f"failed to resolve auth_config for {toolkit}"
        raise ComposioError(500, msg)

    # Step 2: link → redirect URL.
    # `allow_multiple=True`: Composio's SDK defaults to False, raising
    # ComposioMultipleConnectedAccountsError if this user already has an
    # ACTIVE connection on the same auth_config. We support N accounts
    # per (user, toolkit) — a user can connect multiple Gmail / Slack /
    # GitHub identities — so the dedup guard would block the second
    # `+add` click in the UI.
    def _link() -> Any:
        return _composio().connected_accounts.link(
            user_id=cx_user,
            auth_config_id=auth_config_id,
            allow_multiple=True,
        )

    link = await _to_thread(_link)
    cid = getattr(link, "id", None)
    redirect = getattr(link, "redirect_url", None)
    if not cid or not redirect:
        msg = "link response missing id / redirect_url"
        raise ComposioError(500, msg)
    # Construct via camelCase aliases — mypy's dataclass_transform view of
    # pydantic uses field aliases and ignores populate_by_name, so the
    # snake_case names (valid at runtime) are rejected statically.
    return ConnectInit(
        toolkit=toolkit,
        connectedAccountId=cid,
        redirectUrl=redirect,
    )


async def connect_custom(
    user: User,
    toolkit: str,
    *,
    auth_scheme: str,
    credentials: dict[str, str],
) -> ConnectInit:
    """Custom-auth connect: the user supplies their own OAuth client /
    API key instead of Composio's managed app. Creates a fresh
    use_custom_auth config (never reused across users — credentials are
    caller-scoped) and links the same way as `connect`."""
    toolkit = toolkit.strip().lower()
    if not toolkit:
        msg = "toolkit required"
        raise ValueError(msg)
    scheme = auth_scheme.strip().upper()
    if scheme not in ("OAUTH2", "API_KEY", "BEARER_TOKEN", "BASIC"):
        msg = f"unsupported auth_scheme: {auth_scheme}"
        raise ValueError(msg)
    if not credentials:
        msg = "credentials required for custom auth"
        raise ValueError(msg)
    cx_user = composio_user_id(user)

    def _create_cfg() -> Any:
        # The SDK's options TypedDict declares auth_scheme as a Literal and
        # credentials as a sparse (total=False) TypedDict that runtime-wise
        # accepts arbitrary credential keys (client_id / api_key / ...).
        # Both casts are backed by the validation above.
        options: AuthConfigUnionMember1 = {
            "type": "use_custom_auth",
            "auth_scheme": cast("_CustomAuthScheme", scheme),
            "credentials": cast("AuthConfigUnionMember1Credentials", dict(credentials)),
        }
        return _composio().auth_configs.create(
            toolkit=toolkit,
            options=options,
        )

    created = await _to_thread(_create_cfg)
    d = created.model_dump() if hasattr(created, "model_dump") else dict(created)
    auth_config_id = d.get("id") or (d.get("auth_config") or {}).get("id")
    if not auth_config_id:
        msg = f"failed to create custom auth_config for {toolkit}"
        raise ComposioError(500, msg)

    def _link() -> Any:
        return _composio().connected_accounts.link(
            user_id=cx_user,
            auth_config_id=auth_config_id,
            allow_multiple=True,
        )

    link = await _to_thread(_link)
    cid = getattr(link, "id", None)
    redirect = getattr(link, "redirect_url", None)
    if not cid:
        msg = "link response missing id"
        raise ComposioError(500, msg)
    return ConnectInit(
        toolkit=toolkit,
        connectedAccountId=cid,
        # API_KEY-style schemes can come back ACTIVE without a redirect;
        # surface an empty URL and let the caller's wait_active confirm.
        redirectUrl=redirect or "",
    )


class CatalogItem(BaseModel):
    slug: str
    name: str
    logo: str | None = None
    categories: list[str] = []
    auth_schemes: list[str] = []
    is_composio_managed: bool = False


class CatalogPage(BaseModel):
    items: list[CatalogItem]
    next_cursor: str | None = None
    total_count: int | None = None


async def list_catalog(
    *,
    category: str | None = None,
    query: str | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> CatalogPage:
    """Page through Composio's full toolkit directory (1000+). Read-only
    browse for the connector catalog UI / CLI; `connect` already accepts
    any slug, so this is purely discovery."""

    def _list() -> Any:
        return _composio().client.toolkits.list(
            category=category or omit,
            search=query or omit,
            cursor=cursor or omit,
            limit=float(limit),
            sort_by="usage",
        )

    resp = await _to_thread(_list)
    raw_items = getattr(resp, "items", None) or []
    items: list[CatalogItem] = []
    for it in raw_items:
        d = it.model_dump() if hasattr(it, "model_dump") else dict(it)
        slug = str(d.get("slug") or "").lower()
        if not slug:
            continue
        meta = d.get("meta") or {}
        auth = d.get("auth_schemes") or d.get("composio_managed_auth_schemes") or []
        items.append(
            CatalogItem(
                slug=slug,
                name=str(d.get("name") or slug),
                logo=(meta.get("logo") if isinstance(meta, dict) else None) or d.get("logo"),
                categories=[
                    str(c.get("name") if isinstance(c, dict) else c)
                    for c in (
                        (meta.get("categories") if isinstance(meta, dict) else None)
                        or d.get("categories")
                        or []
                    )
                ],
                auth_schemes=[str(a) for a in auth],
                is_composio_managed=bool(d.get("is_composio_managed")),
            )
        )
    next_cursor = getattr(resp, "next_cursor", None)
    raw_total = (
        getattr(resp, "total_count", None)
        or getattr(resp, "total", None)
        or getattr(resp, "count", None)
    )
    total_count = int(raw_total) if isinstance(raw_total, (int, float)) else None
    return CatalogPage(items=items, next_cursor=next_cursor, total_count=total_count)


async def wait_active(
    connected_account_id: str,
    *,
    timeout: float = 120.0,
) -> Connection:
    """Block until the connection is ACTIVE or `timeout` elapses.
    Returns the resulting Connection (status may still be non-ACTIVE on
    timeout — caller decides what to do)."""

    def _wait() -> Any:
        return _composio().connected_accounts.wait_for_connection(
            id=connected_account_id,
            timeout=timeout,
        )

    try:
        resp = await _to_thread(_wait)
    except ComposioError as e:
        # 408-style timeout: surface a Connection with current status,
        # don't raise — that matches the legacy /api/composio/wait
        # contract (UI keeps polling). Re-fetch current state.
        if e.status_code in (408, 504):
            return await _get_connection(connected_account_id)
        raise

    d = resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)
    cid = d.get("id") or connected_account_id
    return Connection(
        toolkit=_toolkit_slug(d.get("toolkit")),
        status=str(d.get("status") or "INACTIVE").upper(),  # type: ignore[arg-type]
        connected_account_id=cid,
    )


async def _get_connection(connected_account_id: str) -> Connection:
    def _get() -> Any:
        return _composio().connected_accounts.get(connected_account_id)

    resp = await _to_thread(_get)
    d = resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)
    return Connection(
        toolkit=_toolkit_slug(d.get("toolkit")),
        status=str(d.get("status") or "INACTIVE").upper(),  # type: ignore[arg-type]
        connected_account_id=connected_account_id,
    )


async def disconnect(connected_account_id: str) -> None:
    if not connected_account_id:
        msg = "connected_account_id required"
        raise ValueError(msg)

    def _delete() -> Any:
        return _composio().connected_accounts.delete(connected_account_id)

    await _to_thread(_delete)
    # pai_connector_labels cleanup happens in the disconnect route via
    # delete_label() — the route has the pool dep already and can scope
    # the DELETE under user_scoped_tx for RLS.


# ── Tool discovery ─────────────────────────────────────────────────────


async def search_tools(
    user: User,
    query: str,
    *,
    toolkit: str | None = None,
    limit: int = 10,
) -> list[ToolHit]:
    """Search Composio's tool catalog. `query` is free-text use-case
    description; `toolkit` optionally narrows to one app. Returns up to
    `limit` ranked ToolHit entries.

    `user` is accepted for symmetry with `execute` (and future filtering
    by what's connected) but not currently used by the SDK's search call."""
    _ = user  # currently unused; reserved

    def _search() -> Any:
        return _composio().tools.get_raw_composio_tools(
            search=query,
            toolkits=[toolkit] if toolkit else None,
            limit=limit,
        )

    tools = await _to_thread(_search)
    out: list[ToolHit] = []
    for t in tools or []:
        slug = getattr(t, "slug", None)
        if not slug:
            continue
        out.append(
            ToolHit(
                slug=slug,
                toolkit=_toolkit_slug(getattr(t, "toolkit", None)),
                name=getattr(t, "name", "") or slug,
                description=(
                    getattr(t, "description", None) or getattr(t, "human_description", "") or ""
                ),
                tags=list(getattr(t, "tags", None) or []),
            )
        )
    return out


async def get_tool_schema(slug: str) -> ToolSchema:
    """Full input/output JSON Schema for a single tool slug. Returned
    schemas are JSON Schema draft 7-ish (Composio's format)."""

    def _get() -> Any:
        return _composio().tools.get_raw_composio_tool_by_slug(slug)

    t = await _to_thread(_get)
    if t is None:
        msg = f"tool not found: {slug}"
        raise ComposioError(404, msg)
    return ToolSchema(
        slug=getattr(t, "slug", slug),
        toolkit=_toolkit_slug(getattr(t, "toolkit", None)),
        name=getattr(t, "name", "") or slug,
        description=(getattr(t, "description", None) or getattr(t, "human_description", "") or ""),
        input_schema=getattr(t, "input_parameters", None) or {},
        output_schema=getattr(t, "output_parameters", None) or {},
        tags=list(getattr(t, "tags", None) or []),
        scopes=list(getattr(t, "scopes", None) or getattr(t, "scope_requirements", None) or []),
    )


# ── Execution ──────────────────────────────────────────────────────────


async def execute(
    user: User,
    slug: str,
    args: dict[str, Any],
    *,
    connected_account_id: str | None = None,
) -> ExecuteResult:
    """Execute one Composio tool against the user's connected account.
    `args` matches the tool's `input_parameters` schema. Errors are
    captured into `ExecuteResult.error` rather than raised, so callers
    can batch-and-aggregate.

    `dangerously_skip_version_check=True` opts out of Composio's
    per-toolkit version pin requirement — manual execution can't pass
    `version="latest"` (Composio rejects it) and pinning each toolkit
    version in our config would be high-maintenance. Trade-off: tool
    semantics may shift on Composio's next major bump per toolkit;
    we accept that and rely on recipe drift alerts to catch breakages.
    """
    cx_user = composio_user_id(user)

    def _exec() -> Any:
        return _composio().tools.execute(
            slug,
            args or {},
            user_id=cx_user,
            connected_account_id=connected_account_id,
            dangerously_skip_version_check=True,
        )

    try:
        resp = await _to_thread(_exec)
    except ComposioError as e:
        return ExecuteResult(slug=slug, successful=False, error=str(e))

    d = resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)
    successful = bool(d.get("successful", True))
    data = _normalize_response_data(d) if successful else None
    error = d.get("error") if not successful else None
    return ExecuteResult(
        slug=slug,
        successful=successful,
        data=data,
        error=error,
    )


async def multi_execute(
    user: User,
    calls: list[ExecuteCall],
    *,
    parallelism: int = 8,
) -> list[ExecuteResult]:
    """Run up to `parallelism` execute calls concurrently. Always
    returns one ExecuteResult per input call (errors land in the result,
    not raised). Order matches input order."""
    sem = asyncio.Semaphore(parallelism)

    async def _one(call: ExecuteCall) -> ExecuteResult:
        async with sem:
            return await execute(
                user,
                call.slug,
                call.args,
                connected_account_id=call.connected_account_id,
            )

    return await asyncio.gather(*[_one(c) for c in calls])


# ── Session pool (Tool Router) ─────────────────────────────────────────


@dataclass
class _SessionEntry:
    session: Any  # ToolRouterSession (sync object held across calls)
    last_used: float
    config_key: str  # cache key for invalidation when config changes


_SESSION_REGISTRY: OrderedDict[str, _SessionEntry] = OrderedDict()
_SESSION_LOCK = asyncio.Lock()
_SESSION_MAX = 256
_SESSION_IDLE_TTL_SEC = 60 * 60  # 1h idle


def _session_cache_key(supabase_user_id: str, config_key: str) -> str:
    return f"{supabase_user_id}:{config_key}"


async def get_or_create_session(
    user: User,
    *,
    toolkits: list[str] | None = None,
    tools: list[str] | None = None,
    manage_connections: bool = True,
) -> Any:
    """Return a Composio Tool Router session for the user, creating one
    on first call. The session exposes the 6 meta tools (SEARCH_TOOLS /
    GET_TOOL_SCHEMAS / MULTI_EXECUTE_TOOL / MANAGE_CONNECTIONS /
    REMOTE_WORKBENCH / REMOTE_BASH_TOOL).

    `toolkits` / `tools` lists let callers physically filter the slug
    surface at session creation (the current side-effect guard).

    Per-user connection wiring: Composio Tool Router does NOT auto-derive
    `connected_accounts` from `user_id` — without an explicit dict the
    session reports every toolkit as unconnected and the LLM falls into
    a `MANAGE_CONNECTIONS` re-OAuth loop. We resolve this user's ACTIVE
    connections via `list_connections` (server-side filtered to
    `user_ids=[pai-{supabase_uuid}]`) and pass them in. The connections
    fingerprint is folded into the cache key so adding/removing a
    connection invalidates any stale session naturally.

    Cross-user isolation invariant:
      * `cid`s only ever come from `list_connections(user)`, which
        Composio filters server-side to this user's supabase UUID
        namespace — cids cannot cross user namespaces.
      * Cache key is prefixed by the supabase UUID, so user A can never
        receive a session built for user B.
    """
    cx_user = composio_user_id(user)

    # Resolve THIS user's ACTIVE connections. Filtered to `toolkits` if
    # the caller narrowed the session surface. First ACTIVE wins per
    # toolkit — Composio's `multi_account` config isn't wired yet, so
    # users with two accounts on the same toolkit get whichever the API
    # returns first; agent code can override per-call via the existing
    # `connected_account_id` arg on `execute()` / `multi_execute()`.
    user_conns = await list_connections(user)
    connected_accounts: dict[str, str] = {}
    for c in user_conns:
        if c.status != "ACTIVE":
            continue
        if toolkits and c.toolkit not in toolkits:
            continue
        connected_accounts.setdefault(c.toolkit, c.connected_account_id)

    ca_fingerprint = ",".join(f"{tk}={cid}" for tk, cid in sorted(connected_accounts.items()))
    config_key = (
        f"tk={','.join(sorted(toolkits)) if toolkits else '*'}"
        f"|tl={','.join(sorted(tools)) if tools else '*'}"
        f"|mc={int(manage_connections)}"
        f"|ca={ca_fingerprint}"
    )
    cache_key = _session_cache_key(user.supabase_user_id, config_key)
    now = time.monotonic()

    async with _SESSION_LOCK:
        entry = _SESSION_REGISTRY.get(cache_key)
        if entry is not None and (now - entry.last_used) < _SESSION_IDLE_TTL_SEC:
            _SESSION_REGISTRY.move_to_end(cache_key)
            entry.last_used = now
            return entry.session
        # Stale or missing — drop and recreate below.
        if entry is not None:
            _SESSION_REGISTRY.pop(cache_key, None)

    def _create() -> Any:
        kwargs: dict[str, Any] = {
            "user_id": cx_user,
            "manage_connections": manage_connections,
        }
        if toolkits:
            kwargs["toolkits"] = list(toolkits)
        if tools:
            # SDK accepts dict[toolkit_slug, ToolRouterToolsConfig]; for
            # a flat slug allowlist we pass them all under "*" so the
            # server interprets it as "exactly these slugs across any
            # connected toolkit". If your SDK version requires per-
            # toolkit grouping, group on caller side and pass via
            # `toolkits=` instead.
            kwargs["tools"] = {"*": {"allowed": list(tools)}}
        if connected_accounts:
            kwargs["connected_accounts"] = connected_accounts
        return _composio().create(**kwargs)

    session = await _to_thread(_create)
    async with _SESSION_LOCK:
        _SESSION_REGISTRY[cache_key] = _SessionEntry(
            session=session,
            last_used=now,
            config_key=config_key,
        )
        # Bound the cache.
        while len(_SESSION_REGISTRY) > _SESSION_MAX:
            _SESSION_REGISTRY.popitem(last=False)
    return session


async def execute_meta_tool(
    user: User,
    tool_name: str,
    args: dict[str, Any],
    *,
    toolkits: list[str] | None = None,
    tools: list[str] | None = None,
) -> dict[str, Any]:
    """Forward a Composio meta-tool call (COMPOSIO_SEARCH_TOOLS / etc.)
    through the user's Tool Router session. Returns the raw response
    as a dict. Session-level errors raise ComposioError; tool-level
    errors come back inside the result envelope."""
    session = await get_or_create_session(
        user,
        toolkits=toolkits,
        tools=tools,
    )

    def _exec() -> Any:
        return session.execute(tool_name, arguments=args or {})

    resp = await _to_thread(_exec)
    if hasattr(resp, "model_dump"):
        return resp.model_dump()
    if isinstance(resp, dict):
        return resp
    return {"data": resp}


async def evict_session(user: User) -> None:
    """Drop all cached sessions for a user. Called after disconnect()
    so a new session reflects the new connection state."""
    prefix = f"{user.supabase_user_id}:"
    async with _SESSION_LOCK:
        stale = [k for k in _SESSION_REGISTRY if k.startswith(prefix)]
        for k in stale:
            _SESSION_REGISTRY.pop(k, None)
