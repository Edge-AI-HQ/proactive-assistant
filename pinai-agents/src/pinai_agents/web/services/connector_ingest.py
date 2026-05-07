"""connector.init / connector.sync handler — fetch a connector's items
from Composio, upsert into the typed pai_raw_* tables, then enqueue a
connector.evolve task so the LLM agent distills them into signals + memory.

Adapters are registered in `_ADAPTERS` (one per toolkit). Adding a new
toolkit is a 3-step localized change:
  1. Write `_fetch_<toolkit>` (Composio call + envelope unwrap).
  2. Write `_upsert_<toolkit>` (insert into the typed pai_raw_* table).
  3. Append a `ToolkitAdapter` entry to `_ADAPTERS`.

Anything not in `_ADAPTERS` hits the "skipped (unsupported_v0)" path so
the scheduler treats the task as done — the frontend chip shows
"初始化跳过 · unsupported_v0" and the reconciler doesn't keep poking.

Design notes:
  * Stage transitions are written to pai_scheduled_tasks.progress between
    Composio fetch / raw ingest / enqueue evolve so the frontend chip
    can surface where we are.
  * connector.evolve is enqueued with a deterministic id so reconnect
    doesn't pile up duplicate evolve rows; `requeue_once` resets it.
  * Failures bubble. The dispatcher's record_failure_and_decide handles
    retry/backoff. We don't catch anything here — the only catch points
    are dispatcher-level so that retries respect attempts/max_attempts.
  * Fetcher signature accepts an optional `since: datetime` for incremental
    sync (PR2). Init mode always passes `since=None` and adapters fall back
    to a toolkit-natural recent window.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from ...config import get_web_settings
from ..composio import composio_user_id
from ..db.repositories.connectors import ConnectorsRepository
from ..db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    requeue_once,
    update_progress,
)
from ..db.rls import user_scoped_tx

logger = logging.getLogger(__name__)

_DEFAULT_LIMIT = 100
_MAX_LIMIT = 500
_COMPOSIO_BASE_V3 = "https://backend.composio.dev/api/v3"

# After init succeeds, we schedule a periodic connector.sync for the same
# (toolkit, cid). 30 minutes balances freshness (chat answers feel current)
# vs. Composio API quota (7 connectors × N users × 48 syncs/day). Tune
# per-toolkit later if needed.
_SYNC_CRON_EXPR = "*/30 * * * *"

# First sync after init: cursor doesn't exist yet, so we look back this
# far. Init already pulled the most recent items, so this window mostly
# overlaps — raw-table dedupe absorbs duplicates. Set to 24h matching the
# plugin's BOOTSTRAP_LOOKBACK_MS.
_BOOTSTRAP_LOOKBACK = timedelta(hours=24)


# ──────────────────────────────────────────────────────────────────────
# Adapter registry
# ──────────────────────────────────────────────────────────────────────

# Fetcher: (api_key, cx_user_id, connectedAccountId, limit, since) → list[dict]
# `since` is optional; init mode passes None (toolkit picks a default
# recent window), sync mode passes the cursor's last_synced_at.
Fetcher = Callable[
    [str, str, str, int, datetime | None],
    Awaitable[list[dict[str, Any]]],
]

# Upserter: (conn, user_id, items) → newly-inserted count.
Upserter = Callable[
    [AsyncConnection, int, list[dict[str, Any]]],
    Awaitable[int],
]


@dataclass(frozen=True)
class ToolkitAdapter:
    """One entry per supported toolkit. Bundling fetch + upsert means the
    fetched payload shape is locked to its consumer — no implicit contract
    drift between the two halves."""
    toolkit: str         # canonical Composio toolkit slug (lowercase)
    raw_table: str       # for logs/diagnostics; SQL is inside upsert
    fetch: Fetcher
    upsert: Upserter


# Populated below after fetcher/upsert defs (forward-ref dance).
_ADAPTERS: dict[str, ToolkitAdapter] = {}


def _clamp_limit(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return _DEFAULT_LIMIT
    return max(1, min(n, _MAX_LIMIT))


async def run(
    pool: AsyncConnectionPool,
    task: ScheduledTaskRow,
    run_id: str,
) -> None:
    """Entry point invoked by the dispatcher. Routes by `task.kind`:
      * connector.init — bootstrap pull, no cursor read, ensures a
        recurring sync schedule on success.
      * connector.sync — incremental pull driven by the cursor's
        last_synced_at; writes the cursor forward on raw-insert success.

    Both modes:
      * Mutate task.progress as stages advance (fetch / raw / evolve).
      * Enqueue connector.evolve when raw rows are inserted.
      * Raise on Composio / DB errors so the dispatcher's failure path
        records backoff + retry.

    Resolves the right adapter via `_ADAPTERS[toolkit]`. Unknown toolkits
    short-circuit to "skipped (unsupported_v0)"."""
    if task.kind == "connector.sync":
        await _run_sync(pool, task, run_id)
    else:  # connector.init or backward-compat (caller routed here)
        await _run_init(pool, task, run_id)


def _validate_payload(task: ScheduledTaskRow) -> tuple[str, str, int]:
    """Returns (toolkit, connected_account_id, limit). Raises ValueError
    on missing required fields — dispatcher records as failure."""
    payload = task.payload or {}
    toolkit_raw = str(payload.get("toolkit") or "").strip().lower()
    cid = str(payload.get("connectedAccountId") or "").strip()
    limit = _clamp_limit(payload.get("limit"))
    if not toolkit_raw:
        msg = f"{task.kind} payload missing toolkit"
        raise ValueError(msg)
    if not cid:
        msg = f"{task.kind} payload missing connectedAccountId"
        raise ValueError(msg)
    return toolkit_raw, cid, limit


async def _mark_skipped(
    pool: AsyncConnectionPool, task: ScheduledTaskRow, toolkit: str, *,
    log_prefix: str,
) -> None:
    """Common path: registry miss → success-with-skip so reconciler
    doesn't keep poking and the frontend chip can render meaningfully."""
    async with user_scoped_tx(pool, task.user_id) as conn:
        await update_progress(
            conn, user_id=task.user_id, task_id=task.id,
            progress={
                "stage": "skipped",
                "reason": "unsupported_v0",
                "toolkit": toolkit,
            },
        )
    logger.info(
        "%s skipped user=%d toolkit=%s — unsupported_v0",
        log_prefix, task.user_id, toolkit,
    )


async def _enqueue_evolve(
    conn: AsyncConnection, *, user_id: int, toolkit: str, cid: str,
) -> str:
    """Reset-or-insert connector.evolve task and return its id."""
    evolve_task_id = f"evolve.{toolkit}.{cid}"
    await requeue_once(
        conn, user_id=user_id, task_id=evolve_task_id,
        kind="connector.evolve",
        payload={"connector": toolkit, "connectedAccountId": cid},
        max_attempts=2,
    )
    return evolve_task_id


async def _ensure_sync_schedule(
    conn: AsyncConnection, *, user_id: int, toolkit: str, cid: str,
) -> None:
    """After init succeeds, ensure a recurring connector.sync schedule
    for this (toolkit, cid). Idempotent — re-running init for the same
    connection does NOT reset the cron's next_run_at (avoids storming
    Composio after a reconnect)."""
    sync_task_id = f"sync.{toolkit}.{cid}"
    # Compute first fire = NOW() + cron interval. We use 30min later as
    # a safe initial delay; the scheduler will compute next_run_at via
    # croniter on subsequent fires.
    first_fire = datetime.now(UTC) + timedelta(minutes=30)
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_scheduled_tasks
              (user_id, id, kind, trigger_kind, cron_expr,
               next_run_at, payload, status, max_attempts)
            VALUES (%s, %s, 'connector.sync', 'schedule', %s,
                    %s, %s::jsonb, 'active', 3)
            ON CONFLICT (user_id, id) DO NOTHING
            """,
            (
                user_id, sync_task_id, _SYNC_CRON_EXPR,
                first_fire,
                json.dumps({"toolkit": toolkit, "connectedAccountId": cid}),
            ),
        )


async def _run_init(
    pool: AsyncConnectionPool,
    task: ScheduledTaskRow,
    run_id: str,
) -> None:
    """Bootstrap pull: full recent window, no cursor. Ensures a
    recurring connector.sync schedule on success."""
    toolkit_raw, cid, limit = _validate_payload(task)
    user_id = task.user_id

    adapter = _ADAPTERS.get(toolkit_raw)
    if adapter is None:
        await _mark_skipped(pool, task, toolkit_raw, log_prefix="[connector.init]")
        return

    settings = get_web_settings()
    api_key = settings.composio_api_key
    if not api_key:
        msg = "COMPOSIO_API_KEY not configured"
        raise RuntimeError(msg)
    cx_user_id = composio_user_id(user_id)

    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn, user_id=user_id, task_id=task.id,
            progress={"stage": "fetch", "toolkit": toolkit_raw, "limit": limit},
        )

    # Init mode: since=None — adapter picks its toolkit-natural default window.
    items = await adapter.fetch(api_key, cx_user_id, cid, limit, None)

    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn, user_id=user_id, task_id=task.id,
            progress={"stage": "raw", "toolkit": toolkit_raw, "fetched": len(items)},
        )
        inserted = await adapter.upsert(conn, user_id, items)

        evolve_task_id = await _enqueue_evolve(
            conn, user_id=user_id, toolkit=toolkit_raw, cid=cid,
        )
        await _ensure_sync_schedule(
            conn, user_id=user_id, toolkit=toolkit_raw, cid=cid,
        )
        await update_progress(
            conn, user_id=user_id, task_id=task.id,
            progress={
                "stage": "evolve",
                "toolkit": toolkit_raw,
                "fetched": len(items),
                "rawInserted": inserted,
                "evolveTaskId": evolve_task_id,
            },
        )

    logger.info(
        "[connector.init] done user=%d toolkit=%s fetched=%d inserted=%d "
        "evolve_task=%s sync_schedule=sync.%s.%s",
        user_id, toolkit_raw, len(items), inserted, evolve_task_id,
        toolkit_raw, cid,
    )


async def _run_sync(
    pool: AsyncConnectionPool,
    task: ScheduledTaskRow,
    run_id: str,
) -> None:
    """Incremental pull: cursor.last_synced_at → fetcher's `since`. On
    raw-insert success, advances cursor to this run's start time. On
    failure (anywhere — fetch, raw, evolve enqueue), the cursor stays
    put so the next attempt re-pulls; raw dedupe absorbs the overlap."""
    toolkit_raw, cid, limit = _validate_payload(task)
    user_id = task.user_id
    started_at = datetime.now(UTC)  # cursor advances to this on success

    adapter = _ADAPTERS.get(toolkit_raw)
    if adapter is None:
        await _mark_skipped(pool, task, toolkit_raw, log_prefix="[connector.sync]")
        return

    settings = get_web_settings()
    api_key = settings.composio_api_key
    if not api_key:
        msg = "COMPOSIO_API_KEY not configured"
        raise RuntimeError(msg)
    cx_user_id = composio_user_id(user_id)

    # ── Stage: read cursor ──
    async with user_scoped_tx(pool, user_id) as conn:
        cursor = await ConnectorsRepository(user_id, conn).get_cursor(
            toolkit=toolkit_raw, connected_account_id=cid,
        )
    since = (
        cursor.last_synced_at if cursor is not None
        else started_at - _BOOTSTRAP_LOOKBACK
    )

    # ── Stage: fetch ──
    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn, user_id=user_id, task_id=task.id,
            progress={
                "stage": "fetch", "toolkit": toolkit_raw,
                "limit": limit, "since": since.isoformat(),
            },
        )

    items = await adapter.fetch(api_key, cx_user_id, cid, limit, since)

    # ── Stage: raw + cursor ──
    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn, user_id=user_id, task_id=task.id,
            progress={"stage": "raw", "toolkit": toolkit_raw, "fetched": len(items)},
        )
        inserted = await adapter.upsert(conn, user_id, items)
        # Advance cursor to started_at (NOT now()) — captures the lower
        # bound for the *next* sync. Using now() would skip events created
        # during this run.
        await ConnectorsRepository(user_id, conn).set_cursor(
            toolkit=toolkit_raw, connected_account_id=cid,
            last_synced_at=started_at,
        )

        # Only enqueue evolve if we actually inserted something — empty
        # syncs are common (cron fires every 30min) and don't need an LLM.
        if inserted > 0:
            evolve_task_id = await _enqueue_evolve(
                conn, user_id=user_id, toolkit=toolkit_raw, cid=cid,
            )
        else:
            evolve_task_id = None

        await update_progress(
            conn, user_id=user_id, task_id=task.id,
            progress={
                "stage": "done",
                "toolkit": toolkit_raw,
                "fetched": len(items),
                "rawInserted": inserted,
                "since": since.isoformat(),
                "syncedThrough": started_at.isoformat(),
                **({"evolveTaskId": evolve_task_id} if evolve_task_id else {}),
            },
        )

    logger.info(
        "[connector.sync] done user=%d toolkit=%s fetched=%d inserted=%d "
        "since=%s synced_through=%s",
        user_id, toolkit_raw, len(items), inserted,
        since.isoformat(), started_at.isoformat(),
    )


# ──────────────────────────────────────────────────────────────────────
# Composio fetch helpers
# ──────────────────────────────────────────────────────────────────────


async def _composio_execute(
    api_key: str, slug: str, body: dict[str, Any],
) -> dict[str, Any]:
    """POST to Composio /tools/execute/<slug>. Returns the parsed JSON
    body verbatim; caller unwraps via _unwrap_data_paths because the
    envelope nesting depth varies across toolkits.

    Errors include the slug + status so retries / failure logs are
    actionable. We deliberately don't import the existing _request from
    composio.py because that function is GET-defaulted and tied to the
    /connected_accounts subset — keeping fetch logic close to the
    handler avoids cross-coupling."""
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
    }
    timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as cli:
        resp = await cli.post(
            f"{_COMPOSIO_BASE_V3}/tools/execute/{slug}",
            headers=headers, json=body,
        )
    if not resp.is_success:
        text = resp.text[:500]
        msg = f"Composio /tools/execute/{slug} {resp.status_code}: {text}"
        raise RuntimeError(msg)
    if not resp.text.strip():
        return {}
    return resp.json()


def _unwrap_data_paths(response: Any) -> list[dict[str, Any]]:
    """Walk Composio's variable nesting. Returns candidate dicts ordered
    deepest-first so toolkit-specific extractors find the actual payload
    before the outer envelope. Mirrors the TS plugin's unwrapDataPaths
    helper — Composio wraps payloads as {data:{response_dict|response_data:...}}
    or directly as {response_data:...}."""
    if not isinstance(response, dict):
        return []
    out: list[dict[str, Any]] = []
    seen: list[int] = []

    def push(v: Any) -> None:
        if isinstance(v, dict) and id(v) not in seen:
            out.append(v)
            seen.append(id(v))

    data = response.get("data")
    response_data = response.get("response_data")
    if isinstance(data, dict):
        push(data.get("response_dict"))
        push(data.get("response_data"))
    if isinstance(response_data, dict):
        push(response_data.get("response_dict"))
        push(response_data.get("response_data"))
    push(response.get("response_dict"))
    push(response_data)
    push(data)
    push(response)
    return out


async def _fetch_gmail(
    api_key: str, cx_user_id: str, cid: str, limit: int,
    since: datetime | None = None,
) -> list[dict[str, Any]]:
    """GMAIL_FETCH_EMAILS with verbose=false (smaller payload, avoids the
    413 cap that hits at ~30 messages with verbose=true) +
    include_payload=true so the body is preserved for evolve.

    Sync mode passes `since` → translated to Gmail's `q='after:<unix>'`
    syntax (Gmail's only timestamp filter). Init mode (since=None) uses
    Gmail's default ordering (most-recent-first) capped at `limit`."""
    arguments: dict[str, Any] = {
        "max_results": limit,
        "verbose": False,
        "include_payload": True,
    }
    if since is not None:
        # Gmail's `after:` operator takes seconds-since-epoch.
        arguments["query"] = f"after:{int(since.timestamp())}"
    response = await _composio_execute(
        api_key, "GMAIL_FETCH_EMAILS",
        {
            "user_id": cx_user_id,
            "connected_account_id": cid,
            "arguments": arguments,
        },
    )
    for candidate in _unwrap_data_paths(response):
        msgs = candidate.get("messages") if isinstance(candidate, dict) else None
        if isinstance(msgs, list):
            return [m for m in msgs if isinstance(m, dict)]
        items = candidate.get("items") if isinstance(candidate, dict) else None
        if isinstance(items, list):
            return [m for m in items if isinstance(m, dict)]
    return []


async def _fetch_gcal(
    api_key: str, cx_user_id: str, cid: str, limit: int,
    since: datetime | None = None,
) -> list[dict[str, Any]]:
    """GOOGLECALENDAR_EVENTS_LIST primary calendar.

    Init mode: ±30/+90 day window so the user sees recent past + near
    future when the chip flips green.
    Sync mode (`since` set): uses `updatedMin=since` so we pick up edits
    + new events created since last sync — different from `timeMin`,
    which would miss past events that were added/edited after creation."""
    now = datetime.now(UTC)
    arguments: dict[str, Any] = {
        "calendarId": "primary",
        "singleEvents": True,
        "maxResults": limit,
    }
    if since is not None:
        arguments["updatedMin"] = since.isoformat()
    else:
        arguments["timeMin"] = (now - timedelta(days=30)).isoformat()
        arguments["timeMax"] = (now + timedelta(days=90)).isoformat()
    response = await _composio_execute(
        api_key, "GOOGLECALENDAR_EVENTS_LIST",
        {
            "user_id": cx_user_id,
            "connected_account_id": cid,
            "arguments": arguments,
        },
    )
    for candidate in _unwrap_data_paths(response):
        events = candidate.get("events") if isinstance(candidate, dict) else None
        if isinstance(events, list):
            return [e for e in events if isinstance(e, dict)][:limit]
        items = candidate.get("items") if isinstance(candidate, dict) else None
        if isinstance(items, list):
            return [e for e in items if isinstance(e, dict)][:limit]
    return []


# ──────────────────────────────────────────────────────────────────────
# Composio response → typed raw row mappers
# ──────────────────────────────────────────────────────────────────────


def _parse_address_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(s) for s in value if isinstance(s, str)]
    if isinstance(value, str):
        return [s.strip() for s in value.split(",") if s.strip()]
    return []


def _parse_gmail_timestamp(value: Any) -> datetime | None:
    """Composio returns ISO ('2026-04-24T00:50:54Z'); raw Gmail returns
    ms-as-string; defensive parsing for both. None on unparsable so
    the row falls back to ingested_at (NOW) at insert time."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # Heuristic: > 10^11 → ms, else seconds.
        secs = float(value) / 1000.0 if value > 1e11 else float(value)
        return datetime.fromtimestamp(secs, tz=UTC)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if s.isdigit():
            ms = int(s)
            secs = ms / 1000.0 if ms > 1e11 else float(ms)
            return datetime.fromtimestamp(secs, tz=UTC)
        # ISO. fromisoformat handles trailing Z only on Python 3.11+.
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _read_gmail_headers(msg: dict[str, Any]) -> dict[str, str]:
    payload = msg.get("payload") or {}
    headers = payload.get("headers") if isinstance(payload, dict) else None
    if not isinstance(headers, list):
        headers = msg.get("headers") if isinstance(msg.get("headers"), list) else []
    out: dict[str, str] = {}
    for h in headers or []:
        if isinstance(h, dict):
            name = h.get("name")
            val = h.get("value")
            if isinstance(name, str) and isinstance(val, str):
                out[name.lower()] = val
    return out


def _map_gmail_message(msg: dict[str, Any]) -> dict[str, Any] | None:
    raw_id = msg.get("id") or msg.get("messageId")
    message_id = str(raw_id).strip() if raw_id is not None else ""
    if not message_id:
        return None
    headers = _read_gmail_headers(msg)
    to_list = (
        msg.get("to") if isinstance(msg.get("to"), list) else None
    )
    if to_list is None:
        to_list = (
            _parse_address_list(msg.get("to"))
            if msg.get("to") is not None
            else _parse_address_list(headers.get("to"))
        )
    cc_list = (
        msg.get("cc") if isinstance(msg.get("cc"), list) else None
    )
    if cc_list is None:
        cc_list = (
            _parse_address_list(msg.get("cc"))
            if msg.get("cc") is not None
            else _parse_address_list(headers.get("cc"))
        )
    snippet = msg.get("snippet")
    if not isinstance(snippet, str):
        preview = msg.get("preview")
        if isinstance(preview, str):
            snippet = preview
        elif isinstance(preview, dict) and isinstance(preview.get("body"), str):
            snippet = preview.get("body")
        else:
            snippet = None
    body = msg.get("messageText") or msg.get("body")
    if not isinstance(body, str):
        body = None
    occurred = _parse_gmail_timestamp(
        msg.get("messageTimestamp")
        or msg.get("internalDate")
        or msg.get("internal_date"),
    )
    label_ids = msg.get("labelIds")
    if not isinstance(label_ids, list):
        label_ids = []
    sender = msg.get("sender") or msg.get("from") or headers.get("from")
    subject = msg.get("subject") or headers.get("subject")
    return {
        "message_id": message_id,
        "thread_id": msg.get("threadId") or msg.get("thread_id"),
        "from_addr": sender if isinstance(sender, str) else None,
        "to_addrs": [s for s in to_list if isinstance(s, str)],
        "cc_addrs": [s for s in cc_list if isinstance(s, str)],
        "subject": subject if isinstance(subject, str) else None,
        "snippet": snippet,
        "body": body,
        "label_ids": [str(x) for x in label_ids],
        "internal_date": occurred,
        "occurred_at": occurred or datetime.now(UTC),
    }


def _extract_gcal_timestamp(node: Any) -> datetime | None:
    if not isinstance(node, dict):
        return None
    raw = node.get("dateTime") or node.get("date")
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _map_gcal_event(evt: dict[str, Any]) -> dict[str, Any] | None:
    raw_id = evt.get("id") or evt.get("eventId")
    event_id = str(raw_id).strip() if raw_id is not None else ""
    if not event_id:
        return None
    organizer = evt.get("organizer")
    organizer_email = (
        organizer.get("email") if isinstance(organizer, dict) else None
    )
    calendar_id = str(
        evt.get("calendarId")
        or evt.get("calendar_id")
        or organizer_email
        or "primary",
    ).strip()
    if not calendar_id:
        return None
    attendees_raw = evt.get("attendees")
    attendees: list[str] = []
    if isinstance(attendees_raw, list):
        for a in attendees_raw:
            if isinstance(a, dict):
                email = a.get("email")
                if isinstance(email, str):
                    attendees.append(email)
            elif isinstance(a, str):
                attendees.append(a)
    start_at = _extract_gcal_timestamp(evt.get("start"))
    end_at = _extract_gcal_timestamp(evt.get("end"))
    occurred = start_at or datetime.now(UTC)
    return {
        "event_id": event_id,
        "calendar_id": calendar_id,
        "title": evt.get("summary") or evt.get("title"),
        "description": evt.get("description"),
        "location": evt.get("location"),
        "start_at": start_at,
        "end_at": end_at,
        "attendees": attendees,
        "status": evt.get("status"),
        "occurred_at": occurred,
    }


# ──────────────────────────────────────────────────────────────────────
# Raw upserts
# ──────────────────────────────────────────────────────────────────────


def _gen_raw_id() -> str:
    """Stable enough for raw row PK. The (user_id, message_id) /
    (user_id, calendar_id, event_id) UNIQUE constraints are the actual
    dedupe; this is just a shape requirement of the PK."""
    return f"raw_{int(time.time() * 1_000_000):x}"


async def _upsert_gmail(
    conn: AsyncConnection, user_id: int, items: list[dict[str, Any]],
) -> int:
    """ON CONFLICT (user_id, message_id) DO NOTHING. Composio re-fetches
    the same Gmail thread on subsequent inits — we keep the first row,
    skip the rest. Returns count newly inserted."""
    inserted = 0
    for item in items:
        mapped = _map_gmail_message(item)
        if mapped is None:
            continue
        row_id = _gen_raw_id()
        dedupe = f"gmail:msg:{mapped['message_id']}"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_gmail_messages (
                  user_id, id, message_id, thread_id, from_addr,
                  to_addrs, cc_addrs, subject, snippet, body, label_ids,
                  internal_date, occurred_at, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s,
                  %s::jsonb, %s::jsonb, %s, %s, %s, %s::jsonb,
                  %s, %s, %s
                )
                ON CONFLICT (user_id, message_id) DO NOTHING
                """,
                (
                    user_id, row_id,
                    mapped["message_id"], mapped["thread_id"], mapped["from_addr"],
                    json.dumps(mapped["to_addrs"]), json.dumps(mapped["cc_addrs"]),
                    mapped["subject"], mapped["snippet"], mapped["body"],
                    json.dumps(mapped["label_ids"]),
                    mapped["internal_date"], mapped["occurred_at"], dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


async def _upsert_gcal(
    conn: AsyncConnection, user_id: int, items: list[dict[str, Any]],
) -> int:
    """ON CONFLICT (user_id, calendar_id, event_id) DO NOTHING."""
    inserted = 0
    for item in items:
        mapped = _map_gcal_event(item)
        if mapped is None:
            continue
        row_id = _gen_raw_id()
        dedupe = f"gcal:evt:{mapped['calendar_id']}:{mapped['event_id']}"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_gcal_events (
                  user_id, id, calendar_id, event_id, title, description,
                  location, start_at, end_at, attendees, status,
                  occurred_at, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s::jsonb, %s,
                  %s, %s
                )
                ON CONFLICT (user_id, calendar_id, event_id) DO NOTHING
                """,
                (
                    user_id, row_id,
                    mapped["calendar_id"], mapped["event_id"],
                    mapped["title"], mapped["description"], mapped["location"],
                    mapped["start_at"], mapped["end_at"],
                    json.dumps(mapped["attendees"]), mapped["status"],
                    mapped["occurred_at"], dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


# ──────────────────────────────────────────────────────────────────────
# GitHub
# ──────────────────────────────────────────────────────────────────────


async def _fetch_github(
    api_key: str, cx_user_id: str, cid: str, limit: int,
    since: datetime | None = None,
) -> list[dict[str, Any]]:
    """GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER (note the
    LIST_ prefix — the non-LIST form 404s).

    Scope: only issues assigned to the user (high signal density per
    user — exactly what they're being held accountable for).
    `state='all'` includes both open and closed; `direction='desc'`
    returns most-recently-updated first.

    `since` is GitHub's native `since` param (filter on updated_at >=
    since). Init mode (since=None) omits it for the full recent window."""
    arguments: dict[str, Any] = {
        "state": "all",
        "filter": "all",
        "per_page": limit,
        "direction": "desc",
    }
    if since is not None:
        # GitHub accepts ISO8601; strip microseconds for cleaner logs.
        arguments["since"] = since.replace(microsecond=0).isoformat()
    response = await _composio_execute(
        api_key, "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER",
        {
            "user_id": cx_user_id,
            "connected_account_id": cid,
            "arguments": arguments,
        },
    )
    # Raw GitHub API form (response.data is itself a list).
    # _unwrap_data_paths drops non-dict values, so check it directly first.
    if isinstance(response, dict):
        data = response.get("data")
        if isinstance(data, list):
            return [m for m in data if isinstance(m, dict)][:limit]
    # Composio wraps under data.issues (verified in plugin live tests).
    for candidate in _unwrap_data_paths(response):
        if not isinstance(candidate, dict):
            continue
        for key in ("issues", "items"):
            v = candidate.get(key)
            if isinstance(v, list):
                return [m for m in v if isinstance(m, dict)][:limit]
    return []


_GITHUB_REPO_URL_RE = re.compile(r"repos/([^/]+/[^/]+)$")


def _parse_iso(value: Any) -> datetime | None:
    """GitHub returns ISO with trailing Z. Defensive parse — None keeps
    the row out only if the column is NOT NULL (occurred_at)."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _map_github_issue(issue: dict[str, Any]) -> dict[str, Any] | None:
    """GitHub Issue → pai_raw_github_issues row. Returns None for issues
    without an id (caller filters)."""
    raw_id = issue.get("id") or issue.get("issue_id")
    issue_id = str(raw_id).strip() if raw_id is not None else ""
    if not issue_id:
        return None

    # repo_full_name: prefer repository_url (e.g.
    # https://api.github.com/repos/owner/repo), fall back to nested
    # repository.full_name.
    repo_full_name: str | None = None
    repo_url = issue.get("repository_url")
    if isinstance(repo_url, str):
        m = _GITHUB_REPO_URL_RE.search(repo_url)
        if m:
            repo_full_name = m.group(1)
    if not repo_full_name:
        repo = issue.get("repository")
        if isinstance(repo, dict):
            full = repo.get("full_name")
            if isinstance(full, str):
                repo_full_name = full

    body = issue.get("body")
    body_preview = body[:800] if isinstance(body, str) else None

    # Labels: GitHub sends [{name: 'bug', ...}, ...] but sometimes strings.
    labels: list[str] = []
    raw_labels = issue.get("labels")
    if isinstance(raw_labels, list):
        for label in raw_labels:
            if isinstance(label, str):
                labels.append(label)
            elif isinstance(label, dict):
                name = label.get("name")
                if isinstance(name, str):
                    labels.append(name)

    assignees: list[str] = []
    raw_assignees = issue.get("assignees")
    if isinstance(raw_assignees, list):
        for a in raw_assignees:
            if isinstance(a, dict):
                login = a.get("login")
                if isinstance(login, str):
                    assignees.append(login)

    created_at = _parse_iso(issue.get("created_at"))
    updated_at = _parse_iso(issue.get("updated_at"))
    # occurred_at picks the most-recent activity for this issue. Falls
    # back to created_at if updated_at is missing, then NOW() since the
    # column is NOT NULL.
    occurred = updated_at or created_at or datetime.now(UTC)

    return {
        "issue_id": issue_id,
        "number": issue.get("number") if isinstance(issue.get("number"), int) else None,
        "repo_full_name": repo_full_name,
        "title": issue.get("title") if isinstance(issue.get("title"), str) else None,
        "body_preview": body_preview,
        "state": issue.get("state") if isinstance(issue.get("state"), str) else None,
        "html_url": issue.get("html_url") if isinstance(issue.get("html_url"), str) else None,
        "is_pull_request": bool(issue.get("pull_request")),
        "labels": labels,
        "assignees": assignees,
        "created_at_remote": created_at,
        "updated_at_remote": updated_at,
        "occurred_at": occurred,
    }


async def _upsert_github_issues(
    conn: AsyncConnection, user_id: int, items: list[dict[str, Any]],
) -> int:
    """ON CONFLICT (user_id, issue_id) DO UPDATE — GitHub issues *change*
    (state flips, comments arrive, labels added). Re-syncs should refresh
    the row, not silently skip it. Distinguishes from gmail/gcal which
    are immutable-by-id."""
    inserted = 0
    for item in items:
        mapped = _map_github_issue(item)
        if mapped is None:
            continue
        row_id = _gen_raw_id()
        dedupe = f"github:issue:{mapped['issue_id']}"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_github_issues (
                  user_id, id, issue_id, number, repo_full_name,
                  title, body_preview, state, html_url, is_pull_request,
                  labels, assignees,
                  created_at_remote, updated_at_remote, occurred_at,
                  dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s,
                  %s, %s, %s, %s, %s,
                  %s::jsonb, %s::jsonb,
                  %s, %s, %s,
                  %s
                )
                ON CONFLICT (user_id, issue_id) DO UPDATE SET
                  state = EXCLUDED.state,
                  title = EXCLUDED.title,
                  body_preview = EXCLUDED.body_preview,
                  labels = EXCLUDED.labels,
                  assignees = EXCLUDED.assignees,
                  updated_at_remote = EXCLUDED.updated_at_remote,
                  occurred_at = EXCLUDED.occurred_at
                """,
                (
                    user_id, row_id,
                    mapped["issue_id"], mapped["number"], mapped["repo_full_name"],
                    mapped["title"], mapped["body_preview"], mapped["state"],
                    mapped["html_url"], mapped["is_pull_request"],
                    json.dumps(mapped["labels"]), json.dumps(mapped["assignees"]),
                    mapped["created_at_remote"], mapped["updated_at_remote"],
                    mapped["occurred_at"], dedupe,
                ),
            )
            # cur.rowcount is 1 for both INSERT and UPDATE under ON CONFLICT.
            # We count the UPDATE path as "inserted" too — for the caller
            # ("did this run produce work for evolve?") an updated state
            # flip is just as meaningful as a brand-new issue.
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


# ──────────────────────────────────────────────────────────────────────
# Adapter registration
# ──────────────────────────────────────────────────────────────────────
# Append a new ToolkitAdapter row when adding a connector. Toolkit slugs
# must match Composio's canonical lowercase slug (e.g. "googlecalendar"
# not "gcal" — the latter is just our raw-table prefix). Adding here is
# the only place outside the toolkit's own fetch/upsert that needs to
# change.

# ──────────────────────────────────────────────────────────────────────
# Slack
# ──────────────────────────────────────────────────────────────────────


async def _fetch_slack(
    api_key: str, cx_user_id: str, cid: str, limit: int,
    since: datetime | None = None,
) -> list[dict[str, Any]]:
    """SLACK_SEARCH_MESSAGES with query='*' — pulls recent messages from
    every channel the user has access to, sorted by timestamp DESC. The
    plugin verified this slug live 2026-04-24.

    Per-channel fairness was considered (list channels then fetch
    history per channel) but rejected: it requires Composio slugs we
    can't verify without hitting their docs, and timestamp-ordered
    results across channels naturally interleave busy + quiet channels
    in a way that matches what the memory layer wants (signal-density
    weighted).

    Slack's search API has no native "since" filter — we filter
    client-side after the response. Init mode (since=None) keeps
    everything; sync mode trims by occurred_at."""
    response = await _composio_execute(
        api_key, "SLACK_SEARCH_MESSAGES",
        {
            "user_id": cx_user_id,
            "connected_account_id": cid,
            "arguments": {
                "query": "*",
                "count": limit,
                "sort": "timestamp",
                "sort_dir": "desc",
                "include_bots": False,
            },
        },
    )
    messages = _extract_slack_messages(response)
    if since is None:
        return messages[:limit]
    # Slack ts is "1234567890.123456" — seconds-since-epoch as string.
    since_ts = since.timestamp()
    out: list[dict[str, Any]] = []
    for m in messages:
        try:
            mts = float(str(m.get("ts") or m.get("timestamp") or 0))
        except (TypeError, ValueError):
            continue
        if mts >= since_ts:
            out.append(m)
        if len(out) >= limit:
            break
    return out


def _extract_slack_messages(response: Any) -> list[dict[str, Any]]:
    """Slack's search response wraps under messages.matches[]."""
    for c in _unwrap_data_paths(response):
        if not isinstance(c, dict):
            continue
        msgs = c.get("messages")
        if isinstance(msgs, dict):
            matches = msgs.get("matches")
            if isinstance(matches, list):
                return [m for m in matches if isinstance(m, dict)]
        for key in ("matches", "messages", "items"):
            v = c.get(key)
            if isinstance(v, list):
                return [m for m in v if isinstance(m, dict)]
    return []


def _slack_ts_to_datetime(ts: str) -> datetime | None:
    """Slack ts is seconds-since-epoch with microsecond fractional part
    encoded as '<sec>.<frac>'. Returns None on malformed input — caller
    falls back to NOW() since occurred_at is NOT NULL."""
    if not isinstance(ts, str):
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=UTC)
    except (TypeError, ValueError):
        return None


def _map_slack_message(msg: dict[str, Any]) -> dict[str, Any] | None:
    """Slack search nests channel under .channel.{id,name}; raw API has
    channel as a string. Same nesting for user."""
    ts_raw = msg.get("ts") or msg.get("timestamp")
    ts = str(ts_raw).strip() if ts_raw is not None else ""

    channel_obj = msg.get("channel")
    if isinstance(channel_obj, dict):
        channel_id = str(channel_obj.get("id") or "").strip()
        channel_name = (
            channel_obj.get("name")
            if isinstance(channel_obj.get("name"), str)
            else None
        )
    else:
        channel_id = str(channel_obj or msg.get("channel_id") or "").strip()
        channel_name = None

    if not ts or not channel_id:
        return None

    user_obj = msg.get("user")
    if isinstance(user_obj, dict):
        slack_user_id = (
            user_obj.get("id") if isinstance(user_obj.get("id"), str) else None
        )
        slack_user_name = (
            user_obj.get("name") or user_obj.get("real_name")
            if isinstance(user_obj.get("name"), str)
            or isinstance(user_obj.get("real_name"), str)
            else None
        )
    elif isinstance(user_obj, str):
        slack_user_id = user_obj
        username = msg.get("username")
        slack_user_name = username if isinstance(username, str) else None
    else:
        slack_user_id = None
        username = msg.get("username")
        slack_user_name = username if isinstance(username, str) else None

    occurred = _slack_ts_to_datetime(ts) or datetime.now(UTC)
    text = msg.get("text") if isinstance(msg.get("text"), str) else None
    permalink = (
        msg.get("permalink") if isinstance(msg.get("permalink"), str) else None
    )
    thread_ts = (
        msg.get("thread_ts")
        if isinstance(msg.get("thread_ts"), str)
        else None
    )

    return {
        "channel_id": channel_id,
        "channel_name": channel_name,
        "ts": ts,
        "thread_ts": thread_ts,
        "slack_user_id": slack_user_id,
        "slack_user_name": slack_user_name,
        "text": text,
        "permalink": permalink,
        "occurred_at": occurred,
    }


async def _upsert_slack_messages(
    conn: AsyncConnection, user_id: int, items: list[dict[str, Any]],
) -> int:
    """ON CONFLICT (user_id, channel_id, ts) DO NOTHING. Slack messages
    are immutable (edits get a separate ts); first insert wins."""
    inserted = 0
    for item in items:
        mapped = _map_slack_message(item)
        if mapped is None:
            continue
        row_id = _gen_raw_id()
        dedupe = f"slack:msg:{mapped['channel_id']}:{mapped['ts']}"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_slack_messages (
                  user_id, id, channel_id, channel_name, ts, thread_ts,
                  slack_user_id, slack_user_name, text, permalink,
                  occurred_at, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s,
                  %s, %s
                )
                ON CONFLICT (user_id, channel_id, ts) DO NOTHING
                """,
                (
                    user_id, row_id,
                    mapped["channel_id"], mapped["channel_name"],
                    mapped["ts"], mapped["thread_ts"],
                    mapped["slack_user_id"], mapped["slack_user_name"],
                    mapped["text"], mapped["permalink"],
                    mapped["occurred_at"], dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


# ──────────────────────────────────────────────────────────────────────
# Notion
# ──────────────────────────────────────────────────────────────────────


async def _fetch_notion(
    api_key: str, cx_user_id: str, cid: str, limit: int,
    since: datetime | None = None,
) -> list[dict[str, Any]]:
    """NOTION_FETCH_DATA with get_pages=true. Composio's slug expects a
    boolean flag picker (one of get_pages/get_databases/get_all), NOT a
    fetch_type string — the schema docs are misleading; the live error
    is "Exactly one data fetch option must be selected".

    Returns a SLIM shape: data.values: [{id, title, type}] only. No
    last_edited_time, no body content. The mapper picks up just what's
    there.

    Notion has no `since` parameter on this endpoint; sync mode falls
    back to client-side filtering by last_edited_time on the mapper
    output (most pages won't have it, so we bias toward inclusion)."""
    response = await _composio_execute(
        api_key, "NOTION_FETCH_DATA",
        {
            "user_id": cx_user_id,
            "connected_account_id": cid,
            "arguments": {
                "get_pages": True,
                "page_size": limit,
            },
        },
    )
    pages = _extract_notion_pages(response)
    return pages[:limit]


def _extract_notion_pages(response: Any) -> list[dict[str, Any]]:
    """Composio NOTION_FETCH_DATA returns { data: { values: [...] } }
    primary; raw Notion API uses { results: [...] }. Accept both."""
    for c in _unwrap_data_paths(response):
        if not isinstance(c, dict):
            continue
        for key in ("values", "results", "pages", "items"):
            v = c.get(key)
            if isinstance(v, list):
                return [p for p in v if isinstance(p, dict)]
    return []


def _extract_notion_title(page: dict[str, Any]) -> str | None:
    """Try common title locations in order."""
    direct = page.get("title")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    props = page.get("properties")
    if isinstance(props, dict):
        for key in ("title", "Title", "Name", "name"):
            prop = props.get(key)
            if isinstance(prop, dict):
                arr = prop.get("title")
                if isinstance(arr, list) and arr:
                    head = arr[0]
                    if isinstance(head, dict):
                        plain = head.get("plain_text")
                        if isinstance(plain, str) and plain.strip():
                            return plain.strip()
    return None


def _map_notion_page(page: dict[str, Any]) -> dict[str, Any] | None:
    """Notion page → pai_raw_notion_pages row.

    Composio's slim shape ({id, title, type}) supplies most fields; raw
    Notion API rich shape (with parent / icon / properties) is also
    handled for future direct calls."""
    raw_id = page.get("id") or page.get("page_id")
    page_id = str(raw_id).strip() if raw_id is not None else ""
    if not page_id:
        return None

    title = _extract_notion_title(page)

    parent = page.get("parent") if isinstance(page.get("parent"), dict) else {}
    parent_type = (
        parent.get("type")
        if isinstance(parent.get("type"), str)
        else (page.get("type") if isinstance(page.get("type"), str) else None)
    )
    parent_id = (
        parent.get("page_id") or parent.get("database_id")
        if isinstance(parent.get("page_id"), str)
        or isinstance(parent.get("database_id"), str)
        else None
    )

    icon: str | None = None
    icon_node = page.get("icon")
    if isinstance(icon_node, dict):
        icon = (
            icon_node.get("emoji")
            or (icon_node.get("external") or {}).get("url")
            or (icon_node.get("file") or {}).get("url")
        )
        if not isinstance(icon, str):
            icon = None

    last_edited = _parse_iso(page.get("last_edited_time"))
    created = _parse_iso(page.get("created_time"))
    occurred = last_edited or created or datetime.now(UTC)
    content_preview = (
        page.get("content_preview")
        if isinstance(page.get("content_preview"), str)
        else None
    )

    return {
        "page_id": page_id,
        "title": title,
        "url": page.get("url") if isinstance(page.get("url"), str) else None,
        "parent_id": parent_id,
        "parent_type": parent_type,
        "icon": icon,
        "last_edited_time": last_edited,
        "created_time": created,
        "content_preview": content_preview,
        "archived": bool(page.get("archived")),
        "occurred_at": occurred,
    }


async def _upsert_notion_pages(
    conn: AsyncConnection, user_id: int, items: list[dict[str, Any]],
) -> int:
    """ON CONFLICT (user_id, page_id) DO UPDATE — Notion pages get
    re-edited, archived, renamed; treat them like github issues
    (mutable-by-id), not like gmail (immutable)."""
    inserted = 0
    for item in items:
        mapped = _map_notion_page(item)
        if mapped is None:
            continue
        row_id = _gen_raw_id()
        dedupe = f"notion:page:{mapped['page_id']}"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_notion_pages (
                  user_id, id, page_id, title, url, parent_id, parent_type,
                  icon, last_edited_time, created_time, content_preview,
                  archived, occurred_at, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s,
                  %s, %s, %s
                )
                ON CONFLICT (user_id, page_id) DO UPDATE SET
                  title = EXCLUDED.title,
                  url = EXCLUDED.url,
                  parent_id = EXCLUDED.parent_id,
                  parent_type = EXCLUDED.parent_type,
                  icon = EXCLUDED.icon,
                  last_edited_time = EXCLUDED.last_edited_time,
                  content_preview = EXCLUDED.content_preview,
                  archived = EXCLUDED.archived,
                  occurred_at = EXCLUDED.occurred_at
                """,
                (
                    user_id, row_id,
                    mapped["page_id"], mapped["title"], mapped["url"],
                    mapped["parent_id"], mapped["parent_type"],
                    mapped["icon"], mapped["last_edited_time"],
                    mapped["created_time"], mapped["content_preview"],
                    mapped["archived"], mapped["occurred_at"], dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


# ──────────────────────────────────────────────────────────────────────
# Google Drive + Google Docs (Drive metadata variants)
# ──────────────────────────────────────────────────────────────────────


def _flatten_drive_owners(file: dict[str, Any]) -> list[str]:
    """Drive's owners[] shape: [{emailAddress, displayName, ...}, ...].
    Prefer email; fall back to displayName. Skip entries with neither."""
    raw = file.get("owners")
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for o in raw:
        if not isinstance(o, dict):
            continue
        email = o.get("emailAddress")
        if isinstance(email, str) and email:
            out.append(email)
            continue
        display = o.get("displayName")
        if isinstance(display, str) and display:
            out.append(display)
    return out


def _flatten_drive_last_modifying_user(file: dict[str, Any]) -> str | None:
    lmu = file.get("lastModifyingUser")
    if not isinstance(lmu, dict):
        return None
    val = lmu.get("emailAddress") or lmu.get("displayName")
    return val if isinstance(val, str) else None


async def _fetch_gdrive(
    api_key: str, cx_user_id: str, cid: str, limit: int,
    since: datetime | None = None,
) -> list[dict[str, Any]]:
    """GOOGLEDRIVE_FIND_FILE — Drive's `q` syntax filters by modifiedTime.
    Init mode looks back 90 days; sync mode uses the cursor's
    last_synced_at as the lower bound. corpora=user restricts to files
    owned/shared with the user (vs. domain-wide)."""
    cutoff = since if since is not None else (datetime.now(UTC) - timedelta(days=90))
    cutoff_iso = cutoff.replace(microsecond=0).isoformat()
    response = await _composio_execute(
        api_key, "GOOGLEDRIVE_FIND_FILE",
        {
            "user_id": cx_user_id,
            "connected_account_id": cid,
            "arguments": {
                "q": f"modifiedTime > '{cutoff_iso}' and trashed = false",
                "page_size": limit,
                "spaces": "drive",
                "corpora": "user",
            },
        },
    )
    files = _extract_drive_files(response)
    return files[:limit]


def _extract_drive_files(response: Any) -> list[dict[str, Any]]:
    """Drive API: { files: [...] }. Composio wraps + sometimes nests."""
    for c in _unwrap_data_paths(response):
        if not isinstance(c, dict):
            continue
        for key in ("files", "items"):
            v = c.get(key)
            if isinstance(v, list):
                return [f for f in v if isinstance(f, dict)]
    return []


def _map_gdrive_file(file: dict[str, Any]) -> dict[str, Any] | None:
    raw_id = file.get("id") or file.get("file_id")
    file_id = str(raw_id).strip() if raw_id is not None else ""
    if not file_id:
        return None

    size_raw = file.get("size")
    if isinstance(size_raw, int):
        size_bytes: int | None = size_raw
    elif isinstance(size_raw, str) and size_raw.isdigit():
        size_bytes = int(size_raw)
    else:
        size_bytes = None

    modified = _parse_iso(file.get("modifiedTime") or file.get("modified_time"))
    created = _parse_iso(file.get("createdTime") or file.get("created_time"))
    occurred = modified or created or datetime.now(UTC)

    return {
        "file_id": file_id,
        "name": file.get("name") if isinstance(file.get("name"), str) else None,
        "mime_type": (
            file.get("mimeType") or file.get("mime_type")
            if isinstance(file.get("mimeType"), str)
            or isinstance(file.get("mime_type"), str)
            else None
        ),
        "modified_time": modified,
        "created_time": created,
        "size_bytes": size_bytes,
        "web_view_link": (
            file.get("webViewLink") or file.get("web_view_link")
            if isinstance(file.get("webViewLink"), str)
            or isinstance(file.get("web_view_link"), str)
            else None
        ),
        "owners": _flatten_drive_owners(file),
        "trashed": bool(file.get("trashed")),
        "occurred_at": occurred,
    }


async def _upsert_gdrive_files(
    conn: AsyncConnection, user_id: int, items: list[dict[str, Any]],
) -> int:
    """ON CONFLICT (user_id, file_id) DO UPDATE — Drive files mutate
    (rename / re-share / trash / re-edit)."""
    inserted = 0
    for item in items:
        mapped = _map_gdrive_file(item)
        if mapped is None:
            continue
        row_id = _gen_raw_id()
        dedupe = f"gdrive:file:{mapped['file_id']}"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_gdrive_files (
                  user_id, id, file_id, name, mime_type,
                  modified_time, created_time, size_bytes, web_view_link,
                  owners, trashed, occurred_at, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s,
                  %s, %s, %s, %s,
                  %s::jsonb, %s, %s, %s
                )
                ON CONFLICT (user_id, file_id) DO UPDATE SET
                  name = EXCLUDED.name,
                  mime_type = EXCLUDED.mime_type,
                  modified_time = EXCLUDED.modified_time,
                  size_bytes = EXCLUDED.size_bytes,
                  web_view_link = EXCLUDED.web_view_link,
                  owners = EXCLUDED.owners,
                  trashed = EXCLUDED.trashed,
                  occurred_at = EXCLUDED.occurred_at
                """,
                (
                    user_id, row_id,
                    mapped["file_id"], mapped["name"], mapped["mime_type"],
                    mapped["modified_time"], mapped["created_time"],
                    mapped["size_bytes"], mapped["web_view_link"],
                    json.dumps(mapped["owners"]), mapped["trashed"],
                    mapped["occurred_at"], dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


async def _fetch_gdocs(
    api_key: str, cx_user_id: str, cid: str, limit: int,
    since: datetime | None = None,
) -> list[dict[str, Any]]:
    """GOOGLEDOCS_SEARCH_DOCUMENTS — verified live in plugin 2026-04-24.
    Returns Drive-API rows under data.documents. Default sort
    (`order_by='modifiedTime desc'`) matches "what has the user been
    writing lately".

    No native `since`; sync mode filters client-side after extraction."""
    response = await _composio_execute(
        api_key, "GOOGLEDOCS_SEARCH_DOCUMENTS",
        {
            "user_id": cx_user_id,
            "connected_account_id": cid,
            "arguments": {
                "max_results": limit,
                "order_by": "modifiedTime desc",
                "include_trashed": False,
            },
        },
    )
    docs = _extract_gdocs_documents(response)
    if since is None:
        return docs[:limit]
    out: list[dict[str, Any]] = []
    for d in docs:
        modified = _parse_iso(d.get("modifiedTime") or d.get("modified_time"))
        if modified is None or modified >= since:
            out.append(d)
        if len(out) >= limit:
            break
    return out


def _extract_gdocs_documents(response: Any) -> list[dict[str, Any]]:
    """Composio docs wrap under data.documents; raw Drive API uses
    .files. Both observed in plugin tests."""
    for c in _unwrap_data_paths(response):
        if not isinstance(c, dict):
            continue
        for key in ("documents", "files", "items"):
            v = c.get(key)
            if isinstance(v, list):
                return [d for d in v if isinstance(d, dict)]
    return []


def _map_gdocs_document(doc: dict[str, Any]) -> dict[str, Any] | None:
    raw_id = doc.get("id") or doc.get("document_id")
    document_id = str(raw_id).strip() if raw_id is not None else ""
    if not document_id:
        return None

    modified = _parse_iso(doc.get("modifiedTime") or doc.get("modified_time"))
    created = _parse_iso(doc.get("createdTime") or doc.get("created_time"))
    occurred = modified or created or datetime.now(UTC)

    return {
        "document_id": document_id,
        "name": doc.get("name") if isinstance(doc.get("name"), str) else None,
        "modified_time": modified,
        "created_time": created,
        "web_view_link": (
            doc.get("webViewLink") or doc.get("web_view_link")
            if isinstance(doc.get("webViewLink"), str)
            or isinstance(doc.get("web_view_link"), str)
            else None
        ),
        "owners": _flatten_drive_owners(doc),
        "last_modifying_user": _flatten_drive_last_modifying_user(doc),
        "starred": bool(doc.get("starred")),
        "trashed": bool(doc.get("trashed")),
        "shared": bool(doc.get("shared")),
        "occurred_at": occurred,
    }


async def _upsert_gdocs_documents(
    conn: AsyncConnection, user_id: int, items: list[dict[str, Any]],
) -> int:
    """ON CONFLICT (user_id, document_id) DO UPDATE — same mutability
    semantics as gdrive."""
    inserted = 0
    for item in items:
        mapped = _map_gdocs_document(item)
        if mapped is None:
            continue
        row_id = _gen_raw_id()
        dedupe = f"gdocs:doc:{mapped['document_id']}"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_gdocs_documents (
                  user_id, id, document_id, name,
                  modified_time, created_time, web_view_link,
                  owners, last_modifying_user,
                  starred, trashed, shared,
                  occurred_at, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s,
                  %s, %s, %s,
                  %s::jsonb, %s,
                  %s, %s, %s,
                  %s, %s
                )
                ON CONFLICT (user_id, document_id) DO UPDATE SET
                  name = EXCLUDED.name,
                  modified_time = EXCLUDED.modified_time,
                  web_view_link = EXCLUDED.web_view_link,
                  owners = EXCLUDED.owners,
                  last_modifying_user = EXCLUDED.last_modifying_user,
                  starred = EXCLUDED.starred,
                  trashed = EXCLUDED.trashed,
                  shared = EXCLUDED.shared,
                  occurred_at = EXCLUDED.occurred_at
                """,
                (
                    user_id, row_id,
                    mapped["document_id"], mapped["name"],
                    mapped["modified_time"], mapped["created_time"],
                    mapped["web_view_link"],
                    json.dumps(mapped["owners"]), mapped["last_modifying_user"],
                    mapped["starred"], mapped["trashed"], mapped["shared"],
                    mapped["occurred_at"], dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


# ──────────────────────────────────────────────────────────────────────
# Calendly
# ──────────────────────────────────────────────────────────────────────


async def _fetch_calendly(
    api_key: str, cx_user_id: str, cid: str, limit: int,
    since: datetime | None = None,
) -> list[dict[str, Any]]:
    """Two-step: CALENDLY_GET_USER (uuid='me') → CALENDLY_LIST_SCHEDULED_EVENTS.

    Calendly explicitly rejects shortcuts like 'me' on /scheduled_events
    — must pass the full user URI from /users/me. The plugin verified
    both slugs.

    Sync mode: passes `min_start_time = since` to the events list call
    (Calendly's native filter)."""
    user_response = await _composio_execute(
        api_key, "CALENDLY_GET_USER",
        {
            "user_id": cx_user_id,
            "connected_account_id": cid,
            "arguments": {"uuid": "me"},
        },
    )
    user_uri = _extract_calendly_user_uri(user_response)
    if not user_uri:
        return []

    arguments: dict[str, Any] = {
        "user": user_uri,
        "sort": "start_time:desc",
        "count": min(limit, 100),
    }
    if since is not None:
        arguments["min_start_time"] = since.replace(microsecond=0).isoformat()

    response = await _composio_execute(
        api_key, "CALENDLY_LIST_SCHEDULED_EVENTS",
        {
            "user_id": cx_user_id,
            "connected_account_id": cid,
            "arguments": arguments,
        },
    )
    return _extract_calendly_events(response)[:limit]


def _extract_calendly_user_uri(response: Any) -> str | None:
    """Calendly: { resource: { uri: "https://api.calendly.com/users/<uuid>" } }
    is the canonical path; some envelopes flatten to top-level `uri`."""
    for c in _unwrap_data_paths(response):
        if not isinstance(c, dict):
            continue
        resource = c.get("resource")
        if isinstance(resource, dict):
            uri = resource.get("uri")
            if (
                isinstance(uri, str)
                and uri.startswith("https://api.calendly.com/users/")
            ):
                return uri
        uri = c.get("uri")
        if (
            isinstance(uri, str)
            and uri.startswith("https://api.calendly.com/users/")
        ):
            return uri
    return None


def _extract_calendly_events(response: Any) -> list[dict[str, Any]]:
    """Calendly: { collection: [...], pagination } per their docs."""
    for c in _unwrap_data_paths(response):
        if not isinstance(c, dict):
            continue
        for key in ("collection", "events", "items"):
            v = c.get(key)
            if isinstance(v, list):
                return [e for e in v if isinstance(e, dict)]
    return []


def _map_calendly_event(evt: dict[str, Any]) -> dict[str, Any] | None:
    raw_uri = evt.get("uri") or evt.get("event_uri")
    event_uri = str(raw_uri).strip() if raw_uri is not None else ""
    if not event_uri:
        return None

    loc = evt.get("location") if isinstance(evt.get("location"), dict) else None

    invitees: list[dict[str, str | None]] = []
    raw_memberships = evt.get("event_memberships")
    if isinstance(raw_memberships, list):
        for m in raw_memberships:
            if not isinstance(m, dict):
                continue
            invitees.append({
                "name": m.get("user_name") if isinstance(m.get("user_name"), str) else None,
                "email": m.get("user_email") if isinstance(m.get("user_email"), str) else None,
            })

    start_at = _parse_iso(evt.get("start_time"))
    end_at = _parse_iso(evt.get("end_time"))
    occurred = start_at or end_at or datetime.now(UTC)

    location_type = (
        loc.get("type") if loc and isinstance(loc.get("type"), str) else None
    )
    if loc:
        if isinstance(loc.get("location"), str):
            location_value = loc["location"]
        elif isinstance(loc.get("join_url"), str):
            location_value = loc["join_url"]
        else:
            location_value = None
        meeting_url = loc.get("join_url") if isinstance(loc.get("join_url"), str) else None
    else:
        location_value = None
        meeting_url = None

    return {
        "event_uri": event_uri,
        "name": evt.get("name") if isinstance(evt.get("name"), str) else None,
        "status": evt.get("status") if isinstance(evt.get("status"), str) else None,
        "start_at": start_at,
        "end_at": end_at,
        "location_type": location_type,
        "location_value": location_value,
        "invitees": invitees,
        "meeting_url": meeting_url,
        "occurred_at": occurred,
    }


async def _upsert_calendly_events(
    conn: AsyncConnection, user_id: int, items: list[dict[str, Any]],
) -> int:
    """ON CONFLICT (user_id, event_uri) DO UPDATE — events get cancelled
    or rescheduled; refresh status + times in place."""
    inserted = 0
    for item in items:
        mapped = _map_calendly_event(item)
        if mapped is None:
            continue
        row_id = _gen_raw_id()
        dedupe = f"calendly:event:{mapped['event_uri']}"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_calendly_events (
                  user_id, id, event_uri, name, status,
                  start_at, end_at, location_type, location_value,
                  invitees, meeting_url, occurred_at, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s,
                  %s, %s, %s, %s,
                  %s::jsonb, %s, %s, %s
                )
                ON CONFLICT (user_id, event_uri) DO UPDATE SET
                  name = EXCLUDED.name,
                  status = EXCLUDED.status,
                  start_at = EXCLUDED.start_at,
                  end_at = EXCLUDED.end_at,
                  location_type = EXCLUDED.location_type,
                  location_value = EXCLUDED.location_value,
                  invitees = EXCLUDED.invitees,
                  meeting_url = EXCLUDED.meeting_url,
                  occurred_at = EXCLUDED.occurred_at
                """,
                (
                    user_id, row_id,
                    mapped["event_uri"], mapped["name"], mapped["status"],
                    mapped["start_at"], mapped["end_at"],
                    mapped["location_type"], mapped["location_value"],
                    json.dumps(mapped["invitees"]), mapped["meeting_url"],
                    mapped["occurred_at"], dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


# ──────────────────────────────────────────────────────────────────────
# Todoist
# ──────────────────────────────────────────────────────────────────────


async def _fetch_todoist(
    api_key: str, cx_user_id: str, cid: str, limit: int,
    since: datetime | None = None,
) -> list[dict[str, Any]]:
    """TODOIST_GET_ALL_TASKS — returns all incomplete tasks. No required
    params. Todoist API caps page size at 200; we don't paginate (>200
    active tasks is rare; sync picks up new ones).

    Todoist has no native `since`; sync mode filters client-side by
    `created_at` from the mapper output. New + edited tasks both pass."""
    response = await _composio_execute(
        api_key, "TODOIST_GET_ALL_TASKS",
        {
            "user_id": cx_user_id,
            "connected_account_id": cid,
            "arguments": {"limit": min(limit, 200)},
        },
    )
    tasks = _extract_todoist_tasks(response)
    if since is None:
        return tasks[:limit]
    out: list[dict[str, Any]] = []
    for t in tasks:
        created = _parse_iso(t.get("created_at"))
        if created is None or created >= since:
            out.append(t)
        if len(out) >= limit:
            break
    return out


def _extract_todoist_tasks(response: Any) -> list[dict[str, Any]]:
    """Todoist v2: { results: [...], next_cursor }; v1: top-level array
    (response.data is itself the array — _unwrap_data_paths discards it
    because the helper only pushes dicts, so we look at response.data
    directly first)."""
    if isinstance(response, dict):
        data = response.get("data")
        if isinstance(data, list):
            return [t for t in data if isinstance(t, dict)]
    for c in _unwrap_data_paths(response):
        if not isinstance(c, dict):
            continue
        for key in ("results", "tasks", "items"):
            v = c.get(key)
            if isinstance(v, list):
                return [t for t in v if isinstance(t, dict)]
    return []


def _map_todoist_task(task: dict[str, Any]) -> dict[str, Any] | None:
    raw_id = task.get("id") or task.get("task_id")
    task_id = str(raw_id).strip() if raw_id is not None else ""
    if not task_id:
        return None

    # Todoist `due` is an object {date, datetime, timezone, string}; we
    # prefer datetime when set, fall back to date (a YYYY-MM-DD string).
    due_at: datetime | None = None
    due = task.get("due")
    if isinstance(due, dict):
        dt_val = due.get("datetime")
        if isinstance(dt_val, str) and dt_val.strip():
            due_at = _parse_iso(dt_val)
        else:
            d_val = due.get("date")
            if isinstance(d_val, str) and d_val.strip():
                # Date-only → midnight UTC. Loses TZ info but the column
                # is timestamptz — better than dropping the value.
                try:
                    due_at = datetime.fromisoformat(d_val).replace(tzinfo=UTC)
                except ValueError:
                    due_at = None

    labels: list[str] = []
    raw_labels = task.get("labels")
    if isinstance(raw_labels, list):
        labels = [s for s in raw_labels if isinstance(s, str)]

    project_id_raw = task.get("project_id")
    project_id = str(project_id_raw) if project_id_raw is not None else None
    parent_id_raw = task.get("parent_id")
    parent_task_id = str(parent_id_raw) if parent_id_raw is not None else None

    is_completed = bool(task.get("is_completed") or task.get("completed"))
    created_at_remote = _parse_iso(task.get("created_at"))
    occurred = created_at_remote or due_at or datetime.now(UTC)

    return {
        "task_id": task_id,
        "content": task.get("content") if isinstance(task.get("content"), str) else None,
        "description": task.get("description") if isinstance(task.get("description"), str) else None,
        "project_id": project_id,
        "parent_task_id": parent_task_id,
        "priority": task.get("priority") if isinstance(task.get("priority"), int) else None,
        "labels": labels,
        "due_at": due_at,
        "is_completed": is_completed,
        "created_at_remote": created_at_remote,
        "occurred_at": occurred,
    }


async def _upsert_todoist_tasks(
    conn: AsyncConnection, user_id: int, items: list[dict[str, Any]],
) -> int:
    """ON CONFLICT (user_id, task_id) DO UPDATE — Todoist tasks mutate
    (priority change, completion, content edit, label add/remove)."""
    inserted = 0
    for item in items:
        mapped = _map_todoist_task(item)
        if mapped is None:
            continue
        row_id = _gen_raw_id()
        dedupe = f"todoist:task:{mapped['task_id']}"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_todoist_tasks (
                  user_id, id, task_id, content, description,
                  project_id, parent_task_id, priority,
                  labels, due_at, is_completed,
                  created_at_remote, occurred_at, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s,
                  %s, %s, %s,
                  %s::jsonb, %s, %s,
                  %s, %s, %s
                )
                ON CONFLICT (user_id, task_id) DO UPDATE SET
                  content = EXCLUDED.content,
                  description = EXCLUDED.description,
                  project_id = EXCLUDED.project_id,
                  parent_task_id = EXCLUDED.parent_task_id,
                  priority = EXCLUDED.priority,
                  labels = EXCLUDED.labels,
                  due_at = EXCLUDED.due_at,
                  is_completed = EXCLUDED.is_completed,
                  occurred_at = EXCLUDED.occurred_at
                """,
                (
                    user_id, row_id,
                    mapped["task_id"], mapped["content"], mapped["description"],
                    mapped["project_id"], mapped["parent_task_id"], mapped["priority"],
                    json.dumps(mapped["labels"]), mapped["due_at"], mapped["is_completed"],
                    mapped["created_at_remote"], mapped["occurred_at"], dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


_ADAPTERS.update({
    "gmail": ToolkitAdapter(
        toolkit="gmail",
        raw_table="pai_raw_gmail_messages",
        fetch=_fetch_gmail,
        upsert=_upsert_gmail,
    ),
    "googlecalendar": ToolkitAdapter(
        toolkit="googlecalendar",
        raw_table="pai_raw_gcal_events",
        fetch=_fetch_gcal,
        upsert=_upsert_gcal,
    ),
    "github": ToolkitAdapter(
        toolkit="github",
        raw_table="pai_raw_github_issues",
        fetch=_fetch_github,
        upsert=_upsert_github_issues,
    ),
    "slack": ToolkitAdapter(
        toolkit="slack",
        raw_table="pai_raw_slack_messages",
        fetch=_fetch_slack,
        upsert=_upsert_slack_messages,
    ),
    "notion": ToolkitAdapter(
        toolkit="notion",
        raw_table="pai_raw_notion_pages",
        fetch=_fetch_notion,
        upsert=_upsert_notion_pages,
    ),
    "googledrive": ToolkitAdapter(
        toolkit="googledrive",
        raw_table="pai_raw_gdrive_files",
        fetch=_fetch_gdrive,
        upsert=_upsert_gdrive_files,
    ),
    "googledocs": ToolkitAdapter(
        toolkit="googledocs",
        raw_table="pai_raw_gdocs_documents",
        fetch=_fetch_gdocs,
        upsert=_upsert_gdocs_documents,
    ),
    "calendly": ToolkitAdapter(
        toolkit="calendly",
        raw_table="pai_raw_calendly_events",
        fetch=_fetch_calendly,
        upsert=_upsert_calendly_events,
    ),
    "todoist": ToolkitAdapter(
        toolkit="todoist",
        raw_table="pai_raw_todoist_tasks",
        fetch=_fetch_todoist,
        upsert=_upsert_todoist_tasks,
    ),
})


def supported_toolkits() -> frozenset[str]:
    """Public read-only view of registered toolkit slugs. Used by tests
    + diagnostics; not for runtime dispatch (use `_ADAPTERS.get(...)`)."""
    return frozenset(_ADAPTERS.keys())
