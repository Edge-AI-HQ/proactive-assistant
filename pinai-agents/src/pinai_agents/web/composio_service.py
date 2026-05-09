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
  3. Identity cache: 24h LRU enriching `list_connections` with user_info
     fetched via per-toolkit GET_PROFILE actions (best-effort, optional).

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
from typing import Any, Literal

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
from pydantic import BaseModel, Field

from ..config import get_web_settings

logger = logging.getLogger(__name__)


# ── Models ─────────────────────────────────────────────────────────────


type ConnectionStatus = Literal[
    "ACTIVE", "INITIALIZING", "INITIATED", "FAILED",
    "EXPIRED", "INACTIVE", "REVOKED",
]


class Connection(BaseModel):
    toolkit: str
    status: ConnectionStatus
    connected_account_id: str
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


def composio_user_id(internal_user_id: int) -> str:
    """Pin AI internal id → Composio user_id. Stable namespace prefix so
    a Composio dashboard query can identify pinai-agents users."""
    return f"pai-{internal_user_id}"


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


# ── Identity cache ─────────────────────────────────────────────────────


_IDENTITY_TTL_SEC = 24 * 60 * 60

# Toolkit slug → action that returns user identity. Only verified slugs
# are listed; speculative entries cause silent 404s on every connections
# fetch. Keep this minimal — adding here requires confirming the action
# exists for the toolkit's Composio version.
_IDENTITY_ACTIONS: dict[str, str] = {
    # Verified live against Composio 2026-05 catalog. Composio renames
    # action slugs occasionally — the original `SLACK_LIST_AUTH_IDENTITY`
    # and `LINKEDIN_LINKEDIN_GET_CURRENT_USER_PROFILE` 404 today.
    # Keep this list short; identity is decorative, every entry adds an
    # extra Composio call per `list_connections` for that toolkit.
    "gmail": "GMAIL_GET_PROFILE",
    "slack": "SLACK_RETRIEVE_A_USER_S_IDENTITY_DETAILS",
    "github": "GITHUB_GET_THE_AUTHENTICATED_USER",
    "linkedin": "LINKEDIN_GET_MY_INFO",
    "calendly": "CALENDLY_GET_USER",
}

_identity_cache: dict[str, tuple[dict[str, Any], float]] = {}
_identity_lock = asyncio.Lock()


async def _resolve_identity(
    toolkit: str, user_id: str, connected_account_id: str,
) -> dict[str, Any] | None:
    """Cache → fall back to identity action → cache. Returns None on any
    failure (best-effort; identity is decorative)."""
    now = time.time()
    async with _identity_lock:
        cached = _identity_cache.get(connected_account_id)
        if cached and (now - cached[1]) < _IDENTITY_TTL_SEC:
            return cached[0]

    action_slug = _IDENTITY_ACTIONS.get(toolkit)
    if not action_slug:
        return None
    try:
        resp = await _to_thread(
            _composio().tools.execute,
            action_slug,
            {},
            user_id=user_id,
            connected_account_id=connected_account_id,
            dangerously_skip_version_check=True,
        )
    except ComposioError:
        return None
    data = _normalize_response_data(resp)
    if not isinstance(data, dict) or not data:
        return None
    async with _identity_lock:
        _identity_cache[connected_account_id] = (data, now)
    return data


def _drop_stale_identity_cache_locked(active_ids: set[str]) -> None:
    """Caller holds `_identity_lock`. Removes cache entries whose
    connected account is no longer reported as active."""
    for stale in [k for k in _identity_cache if k not in active_ids]:
        _identity_cache.pop(stale, None)


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


async def list_connections(internal_user_id: int) -> list[Connection]:
    """List ACTIVE connected accounts for the user, enriched with
    cached / fresh user_info for the toolkits we know how to identify."""
    cx_user = composio_user_id(internal_user_id)

    def _list() -> Any:
        return _composio().connected_accounts.list(
            user_ids=[cx_user],
            statuses=["ACTIVE"],
            limit=100,
        )

    resp = await _to_thread(_list)
    items = getattr(resp, "items", None) or []

    out: list[Connection] = []
    active_ids: set[str] = set()
    for item in items:
        # Items can be dataclass-style or model — coerce to dict.
        d = item.model_dump() if hasattr(item, "model_dump") else dict(item)
        cid = d.get("id") or d.get("connected_account_id")
        if not cid:
            continue
        toolkit_slug = _toolkit_slug(d.get("toolkit"))
        status = str(d.get("status") or "INACTIVE").upper()

        info = d.get("user_info") or d.get("current_user_info")
        if not info:
            info = await _resolve_identity(toolkit_slug, cx_user, cid)

        out.append(Connection(
            toolkit=toolkit_slug,
            status=status,  # type: ignore[arg-type]
            connected_account_id=cid,
            user_info=info,
        ))
        active_ids.add(cid)

    async with _identity_lock:
        _drop_stale_identity_cache_locked(active_ids)

    return out


async def connect(internal_user_id: int, toolkit: str) -> ConnectInit:
    """Initiate OAuth: ensure auth_config exists for the toolkit, then
    link → returns a redirect URL the user opens to complete OAuth."""
    toolkit = toolkit.strip().lower()
    if not toolkit:
        msg = "toolkit required"
        raise ValueError(msg)
    cx_user = composio_user_id(internal_user_id)

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
    def _link() -> Any:
        return _composio().connected_accounts.link(
            user_id=cx_user, auth_config_id=auth_config_id,
        )

    link = await _to_thread(_link)
    cid = getattr(link, "id", None)
    redirect = getattr(link, "redirect_url", None)
    if not cid or not redirect:
        msg = "link response missing id / redirect_url"
        raise ComposioError(500, msg)
    return ConnectInit(
        toolkit=toolkit,
        connected_account_id=cid,
        redirect_url=redirect,
    )


async def wait_active(
    connected_account_id: str, *, timeout: float = 120.0,
) -> Connection:
    """Block until the connection is ACTIVE or `timeout` elapses.
    Returns the resulting Connection (status may still be non-ACTIVE on
    timeout — caller decides what to do)."""

    def _wait() -> Any:
        return _composio().connected_accounts.wait_for_connection(
            id=connected_account_id, timeout=timeout,
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
    async with _identity_lock:
        _identity_cache.pop(connected_account_id, None)


# ── Tool discovery ─────────────────────────────────────────────────────


async def search_tools(
    internal_user_id: int,
    query: str,
    *,
    toolkit: str | None = None,
    limit: int = 10,
) -> list[ToolHit]:
    """Search Composio's tool catalog. `query` is free-text use-case
    description; `toolkit` optionally narrows to one app. Returns up to
    `limit` ranked ToolHit entries.

    `internal_user_id` is accepted for symmetry with `execute` (and
    future filtering by what's connected) but not currently used by the
    SDK's search call."""
    _ = internal_user_id  # currently unused; reserved

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
        out.append(ToolHit(
            slug=slug,
            toolkit=_toolkit_slug(getattr(t, "toolkit", None)),
            name=getattr(t, "name", "") or slug,
            description=(getattr(t, "description", None)
                         or getattr(t, "human_description", "") or ""),
            tags=list(getattr(t, "tags", None) or []),
        ))
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
        description=(getattr(t, "description", None)
                     or getattr(t, "human_description", "") or ""),
        input_schema=getattr(t, "input_parameters", None) or {},
        output_schema=getattr(t, "output_parameters", None) or {},
        tags=list(getattr(t, "tags", None) or []),
        scopes=list(getattr(t, "scopes", None)
                    or getattr(t, "scope_requirements", None) or []),
    )


# ── Execution ──────────────────────────────────────────────────────────


async def execute(
    internal_user_id: int,
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
    cx_user = composio_user_id(internal_user_id)

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
        slug=slug, successful=successful, data=data, error=error,
    )


async def multi_execute(
    internal_user_id: int,
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
                internal_user_id, call.slug, call.args,
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


def _session_cache_key(internal_user_id: int, config_key: str) -> str:
    return f"{internal_user_id}:{config_key}"


async def get_or_create_session(
    internal_user_id: int,
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
    `user_ids=[pai-{X}]`) and pass them in. The connections fingerprint
    is folded into the cache key so adding/removing a connection
    invalidates any stale session naturally.

    Cross-user isolation invariant:
      * `cid`s only ever come from `list_connections(internal_user_id)`,
        which Composio filters server-side to this user — cids cannot
        cross user namespaces.
      * Cache key is prefixed by `internal_user_id`, so user A can never
        receive a session built for user B.
    """
    cx_user = composio_user_id(internal_user_id)

    # Resolve THIS user's ACTIVE connections. Filtered to `toolkits` if
    # the caller narrowed the session surface. First ACTIVE wins per
    # toolkit — Composio's `multi_account` config isn't wired yet, so
    # users with two accounts on the same toolkit get whichever the API
    # returns first; agent code can override per-call via the existing
    # `connected_account_id` arg on `execute()` / `multi_execute()`.
    user_conns = await list_connections(internal_user_id)
    connected_accounts: dict[str, str] = {}
    for c in user_conns:
        if c.status != "ACTIVE":
            continue
        if toolkits and c.toolkit not in toolkits:
            continue
        connected_accounts.setdefault(c.toolkit, c.connected_account_id)

    ca_fingerprint = ",".join(
        f"{tk}={cid}" for tk, cid in sorted(connected_accounts.items())
    )
    config_key = (
        f"tk={','.join(sorted(toolkits)) if toolkits else '*'}"
        f"|tl={','.join(sorted(tools)) if tools else '*'}"
        f"|mc={int(manage_connections)}"
        f"|ca={ca_fingerprint}"
    )
    cache_key = _session_cache_key(internal_user_id, config_key)
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
            session=session, last_used=now, config_key=config_key,
        )
        # Bound the cache.
        while len(_SESSION_REGISTRY) > _SESSION_MAX:
            _SESSION_REGISTRY.popitem(last=False)
    return session


async def execute_meta_tool(
    internal_user_id: int,
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
        internal_user_id, toolkits=toolkits, tools=tools,
    )

    def _exec() -> Any:
        return session.execute(tool_name, arguments=args or {})

    resp = await _to_thread(_exec)
    if hasattr(resp, "model_dump"):
        return resp.model_dump()
    if isinstance(resp, dict):
        return resp
    return {"data": resp}


async def evict_session(internal_user_id: int) -> None:
    """Drop all cached sessions for a user. Called after disconnect()
    so a new session reflects the new connection state."""
    prefix = f"{internal_user_id}:"
    async with _SESSION_LOCK:
        stale = [k for k in _SESSION_REGISTRY if k.startswith(prefix)]
        for k in stale:
            _SESSION_REGISTRY.pop(k, None)


# ── Diagnostics ────────────────────────────────────────────────────────


def metrics_snapshot() -> dict[str, int]:
    """Counters for diagnostics. No lock — counters are not strict."""
    return {
        "session_registry_size": len(_SESSION_REGISTRY),
        "session_registry_max": _SESSION_MAX,
        "identity_cache_size": len(_identity_cache),
    }
