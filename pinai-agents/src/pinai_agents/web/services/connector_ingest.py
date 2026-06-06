"""connector.init / connector.sync handler — drive Composio fetch via
the recipe-based ingest_runner, upsert into typed pai_raw_* tables,
then enqueue a connector.evolve task so the LLM agent distills them
into signals + memory.

Fetch half lives in `services/ingest_runner.py` (yaml recipe → Composio
SDK call). This module owns the upsert half: per-toolkit
`_upsert_<toolkit>` functions targeting the typed raw tables. Adding a
new toolkit:
  1. Write `db/ingest_recipes/<toolkit>.yaml` (fetch spec).
  2. Write `_upsert_<toolkit>` here (typed-raw insert).
  3. Append to `_UPSERTERS` map.

A toolkit with a recipe but no upserter hits the "skipped
(unsupported_v0)" path until its upserter lands.

Design notes:
  * Stage transitions are written to pai_scheduled_tasks.progress between
    Composio fetch / raw ingest / enqueue evolve so the frontend chip
    can surface where we are.
  * connector.evolve is enqueued with a deterministic id so reconnect
    doesn't pile up duplicate evolve rows; `requeue_once` resets it.
  * Failures bubble. The dispatcher's record_failure_and_decide handles
    retry/backoff. We don't catch anything here — the only catch points
    are dispatcher-level so that retries respect attempts/max_attempts.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import DictRow
from psycopg_pool import AsyncConnectionPool

from ..auth.user_service import load_user_by_id
from ..db.repositories.connectors import ConnectorsRepository
from ..db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    requeue_once,
    update_progress,
)
from ..db.repositories.timeline import IngestTimelineEvent, TimelineRepository
from ..db.rls import user_scoped_tx
from . import ingest_runner

logger = logging.getLogger(__name__)

_DEFAULT_LIMIT = 100
_MAX_LIMIT = 500

# After init succeeds, we schedule a periodic connector.sync for the same
# (toolkit, cid). 30 minutes balances freshness (chat answers feel current)
# vs. Composio API quota (7 connectors × N users × 48 syncs/day).
# Per-toolkit override is in the recipe's `sync_interval_hours` field —
# but the cron itself is fixed; future versions can render the cron from
# the recipe.
_SYNC_CRON_EXPR = "*/30 * * * *"

# First sync after init: cursor doesn't exist yet, so we look back this
# far. Init already pulled the most recent items, so this window mostly
# overlaps — raw-table dedupe absorbs duplicates.
_BOOTSTRAP_LOOKBACK = timedelta(hours=24)


# ──────────────────────────────────────────────────────────────────────
# Upserter registry
# ──────────────────────────────────────────────────────────────────────

# Upserter: (conn, user_id, items) → newly-inserted count.
Upserter = Callable[
    [AsyncConnection[DictRow], int, list[dict[str, Any]]],
    Awaitable[int],
]

# Populated below after upsert defs (forward-ref dance).
_UPSERTERS: dict[str, Upserter] = {}

# Timeline dual-write: the SAME fetched items are also projected into
# pai_timeline_events (alongside the raw tables) so the proactive agent sees
# connector events on its timeline. _RawMapper is the shared raw-item parser
# (dict → cleaned dict); _TimelineProjector turns a cleaned dict into an
# IngestTimelineEvent. Registry populated after the projector defs below.
_RawMapper = Callable[[dict[str, Any]], "dict[str, Any] | None"]
_TimelineProjector = Callable[..., IngestTimelineEvent]
_TIMELINE_MAPPERS: dict[str, tuple[_RawMapper, _TimelineProjector]] = {}


def _clamp_limit(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return _DEFAULT_LIMIT
    return max(1, min(n, _MAX_LIMIT))


def _as_dict(value: Any) -> dict[str, Any]:
    """Coerce an untrusted nested value to a dict, defaulting to empty.

    Connector payloads are arbitrary JSON; mapping code walks them
    defensively. Assigning through this helper (rather than the inline
    `v if isinstance(v, dict) else {}`) lets the type narrow to dict so
    chained `.get()` calls stay type-checked.
    """
    return value if isinstance(value, dict) else {}


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
    pool: AsyncConnectionPool,
    task: ScheduledTaskRow,
    toolkit: str,
    *,
    log_prefix: str,
) -> None:
    """Common path: registry miss → success-with-skip so reconciler
    doesn't keep poking and the frontend chip can render meaningfully."""
    async with user_scoped_tx(pool, task.user_id) as conn:
        await update_progress(
            conn,
            user_id=task.user_id,
            task_id=task.id,
            progress={
                "stage": "skipped",
                "reason": "unsupported_v0",
                "toolkit": toolkit,
            },
        )
    logger.info(
        "%s skipped user=%d toolkit=%s — unsupported_v0",
        log_prefix,
        task.user_id,
        toolkit,
    )


async def _enqueue_evolve(
    conn: AsyncConnection[DictRow],
    *,
    user_id: int,
    toolkit: str,
    cid: str,
) -> str:
    """Reset-or-insert connector.evolve task and return its id."""
    evolve_task_id = f"evolve.{toolkit}.{cid}"
    await requeue_once(
        conn,
        user_id=user_id,
        task_id=evolve_task_id,
        kind="connector.evolve",
        payload={"connector": toolkit, "connectedAccountId": cid},
        max_attempts=2,
    )
    return evolve_task_id


async def _ensure_sync_schedule(
    conn: AsyncConnection[DictRow],
    *,
    user_id: int,
    toolkit: str,
    cid: str,
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
                user_id,
                sync_task_id,
                _SYNC_CRON_EXPR,
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

    upserter = _UPSERTERS.get(toolkit_raw)
    recipe = ingest_runner.load_recipe(toolkit_raw)
    if upserter is None or recipe is None or not recipe.is_ingestable():
        await _mark_skipped(pool, task, toolkit_raw, log_prefix="[connector.init]")
        return

    user = await load_user_by_id(pool, user_id)
    if user is None:
        msg = f"connector.init: user {user_id} not found"
        raise RuntimeError(msg)

    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={"stage": "fetch", "toolkit": toolkit_raw, "limit": limit},
        )

    # Init mode: since=None — recipe omits the cursor arg; toolkit's
    # natural default window applies.
    items = await ingest_runner.run_fetch(
        user,
        toolkit_raw,
        cid,
        limit=limit,
        since=None,
    )

    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={"stage": "raw", "toolkit": toolkit_raw, "fetched": len(items)},
        )
        inserted = await upserter(conn, user_id, items)

        evolve_task_id = await _enqueue_evolve(
            conn,
            user_id=user_id,
            toolkit=toolkit_raw,
            cid=cid,
        )
        await _ensure_sync_schedule(
            conn,
            user_id=user_id,
            toolkit=toolkit_raw,
            cid=cid,
        )
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={
                "stage": "evolve",
                "toolkit": toolkit_raw,
                "fetched": len(items),
                "rawInserted": inserted,
                "evolveTaskId": evolve_task_id,
            },
        )

    # Additive proactive feed (separate tx, best-effort — see helper).
    tl_written = await _dual_write_timeline(
        pool,
        user_id,
        items,
        toolkit=toolkit_raw,
        cid=cid,
    )

    logger.info(
        "[connector.init] done user=%d toolkit=%s fetched=%d inserted=%d "
        "timeline=%d evolve_task=%s sync_schedule=sync.%s.%s",
        user_id,
        toolkit_raw,
        len(items),
        inserted,
        tl_written,
        evolve_task_id,
        toolkit_raw,
        cid,
    )


async def _run_sync(
    pool: AsyncConnectionPool,
    task: ScheduledTaskRow,
    run_id: str,
) -> None:
    """Incremental pull: cursor.last_synced_at → recipe's `since` arg.
    On raw-insert success, advances cursor to this run's start time. On
    failure (anywhere — fetch, raw, evolve enqueue), the cursor stays
    put so the next attempt re-pulls; raw dedupe absorbs the overlap."""
    toolkit_raw, cid, limit = _validate_payload(task)
    user_id = task.user_id
    started_at = datetime.now(UTC)  # cursor advances to this on success

    upserter = _UPSERTERS.get(toolkit_raw)
    recipe = ingest_runner.load_recipe(toolkit_raw)
    if upserter is None or recipe is None or not recipe.is_ingestable():
        await _mark_skipped(pool, task, toolkit_raw, log_prefix="[connector.sync]")
        return

    user = await load_user_by_id(pool, user_id)
    if user is None:
        msg = f"connector.sync: user {user_id} not found"
        raise RuntimeError(msg)

    # ── Stage: read cursor ──
    async with user_scoped_tx(pool, user_id) as conn:
        cursor = await ConnectorsRepository(user_id, conn).get_cursor(
            toolkit=toolkit_raw,
            connected_account_id=cid,
        )
    since = cursor.last_synced_at if cursor is not None else started_at - _BOOTSTRAP_LOOKBACK

    # ── Stage: fetch ──
    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={
                "stage": "fetch",
                "toolkit": toolkit_raw,
                "limit": limit,
                "since": since.isoformat(),
            },
        )

    items = await ingest_runner.run_fetch(
        user,
        toolkit_raw,
        cid,
        limit=limit,
        since=since,
    )

    # ── Stage: raw + cursor ──
    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={"stage": "raw", "toolkit": toolkit_raw, "fetched": len(items)},
        )
        inserted = await upserter(conn, user_id, items)
        # Advance cursor to started_at (NOT now()) — captures the lower
        # bound for the *next* sync. Using now() would skip events created
        # during this run.
        await ConnectorsRepository(user_id, conn).set_cursor(
            toolkit=toolkit_raw,
            connected_account_id=cid,
            last_synced_at=started_at,
        )

        # Only enqueue evolve if we actually inserted something — empty
        # syncs are common (cron fires every 30min) and don't need an LLM.
        if inserted > 0:
            evolve_task_id = await _enqueue_evolve(
                conn,
                user_id=user_id,
                toolkit=toolkit_raw,
                cid=cid,
            )
        else:
            evolve_task_id = None

        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
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

    # Additive proactive feed (separate tx, best-effort — see helper). Runs
    # on every non-empty sync (idempotent upsert self-heals prior failures),
    # independent of the inserted>0 gate the raw-evolve enqueue uses.
    tl_written = await _dual_write_timeline(
        pool,
        user_id,
        items,
        toolkit=toolkit_raw,
        cid=cid,
    )

    logger.info(
        "[connector.sync] done user=%d toolkit=%s fetched=%d inserted=%d "
        "timeline=%d since=%s synced_through=%s",
        user_id,
        toolkit_raw,
        len(items),
        inserted,
        tl_written,
        since.isoformat(),
        started_at.isoformat(),
    )


# ──────────────────────────────────────────────────────────────────────
# Composio response → typed raw row mappers
# ──────────────────────────────────────────────────────────────────────
# Mappers (`_map_<toolkit>`) translate Composio response items into row
# shape for the typed pai_raw_* tables. They're kept close to their
# `_upsert_<toolkit>` consumer so contract drift between the two halves
# is impossible. Fetch happens upstream via ingest_runner + yaml recipe.


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
    to_list = msg.get("to") if isinstance(msg.get("to"), list) else None
    if to_list is None:
        to_list = (
            _parse_address_list(msg.get("to"))
            if msg.get("to") is not None
            else _parse_address_list(headers.get("to"))
        )
    cc_list = msg.get("cc") if isinstance(msg.get("cc"), list) else None
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
        msg.get("messageTimestamp") or msg.get("internalDate") or msg.get("internal_date"),
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
    organizer_email = organizer.get("email") if isinstance(organizer, dict) else None
    calendar_id = str(
        evt.get("calendarId") or evt.get("calendar_id") or organizer_email or "primary",
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
    conn: AsyncConnection[DictRow],
    user_id: int,
    items: list[dict[str, Any]],
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
                    user_id,
                    row_id,
                    mapped["message_id"],
                    mapped["thread_id"],
                    mapped["from_addr"],
                    json.dumps(mapped["to_addrs"]),
                    json.dumps(mapped["cc_addrs"]),
                    mapped["subject"],
                    mapped["snippet"],
                    mapped["body"],
                    json.dumps(mapped["label_ids"]),
                    mapped["internal_date"],
                    mapped["occurred_at"],
                    dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


async def _upsert_gcal(
    conn: AsyncConnection[DictRow],
    user_id: int,
    items: list[dict[str, Any]],
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
                    user_id,
                    row_id,
                    mapped["calendar_id"],
                    mapped["event_id"],
                    mapped["title"],
                    mapped["description"],
                    mapped["location"],
                    mapped["start_at"],
                    mapped["end_at"],
                    json.dumps(mapped["attendees"]),
                    mapped["status"],
                    mapped["occurred_at"],
                    dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


# ──────────────────────────────────────────────────────────────────────
# GitHub
# ──────────────────────────────────────────────────────────────────────


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
    conn: AsyncConnection[DictRow],
    user_id: int,
    items: list[dict[str, Any]],
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
                    user_id,
                    row_id,
                    mapped["issue_id"],
                    mapped["number"],
                    mapped["repo_full_name"],
                    mapped["title"],
                    mapped["body_preview"],
                    mapped["state"],
                    mapped["html_url"],
                    mapped["is_pull_request"],
                    json.dumps(mapped["labels"]),
                    json.dumps(mapped["assignees"]),
                    mapped["created_at_remote"],
                    mapped["updated_at_remote"],
                    mapped["occurred_at"],
                    dedupe,
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
# Upserter registration
# ──────────────────────────────────────────────────────────────────────
# Pair an upsert function with a Composio toolkit slug. Slugs MUST match
# Composio's canonical lowercase slug (e.g. "googlecalendar", not "gcal"
# — the latter is just our raw-table prefix). Toolkits with a recipe but
# no upserter fall through to "skipped (unsupported_v0)" until their
# upserter lands.

# ──────────────────────────────────────────────────────────────────────
# Slack
# ──────────────────────────────────────────────────────────────────────


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
        channel_name = channel_obj.get("name") if isinstance(channel_obj.get("name"), str) else None
    else:
        channel_id = str(channel_obj or msg.get("channel_id") or "").strip()
        channel_name = None

    if not ts or not channel_id:
        return None

    user_obj = msg.get("user")
    if isinstance(user_obj, dict):
        slack_user_id = user_obj.get("id") if isinstance(user_obj.get("id"), str) else None
        slack_user_name = (
            user_obj.get("name") or user_obj.get("real_name")
            if isinstance(user_obj.get("name"), str) or isinstance(user_obj.get("real_name"), str)
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
    permalink = msg.get("permalink") if isinstance(msg.get("permalink"), str) else None
    thread_ts = msg.get("thread_ts") if isinstance(msg.get("thread_ts"), str) else None

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
    conn: AsyncConnection[DictRow],
    user_id: int,
    items: list[dict[str, Any]],
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
                    user_id,
                    row_id,
                    mapped["channel_id"],
                    mapped["channel_name"],
                    mapped["ts"],
                    mapped["thread_ts"],
                    mapped["slack_user_id"],
                    mapped["slack_user_name"],
                    mapped["text"],
                    mapped["permalink"],
                    mapped["occurred_at"],
                    dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


# ──────────────────────────────────────────────────────────────────────
# Google Drive
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
            if isinstance(file.get("mimeType"), str) or isinstance(file.get("mime_type"), str)
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
    conn: AsyncConnection[DictRow],
    user_id: int,
    items: list[dict[str, Any]],
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
                    user_id,
                    row_id,
                    mapped["file_id"],
                    mapped["name"],
                    mapped["mime_type"],
                    mapped["modified_time"],
                    mapped["created_time"],
                    mapped["size_bytes"],
                    mapped["web_view_link"],
                    json.dumps(mapped["owners"]),
                    mapped["trashed"],
                    mapped["occurred_at"],
                    dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


# ──────────────────────────────────────────────────────────────────────
# Calendly
# ──────────────────────────────────────────────────────────────────────


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
            invitees.append(
                {
                    "name": m.get("user_name") if isinstance(m.get("user_name"), str) else None,
                    "email": m.get("user_email") if isinstance(m.get("user_email"), str) else None,
                }
            )

    start_at = _parse_iso(evt.get("start_time"))
    end_at = _parse_iso(evt.get("end_time"))
    occurred = start_at or end_at or datetime.now(UTC)

    location_type = loc.get("type") if loc and isinstance(loc.get("type"), str) else None
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
    conn: AsyncConnection[DictRow],
    user_id: int,
    items: list[dict[str, Any]],
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
                    user_id,
                    row_id,
                    mapped["event_uri"],
                    mapped["name"],
                    mapped["status"],
                    mapped["start_at"],
                    mapped["end_at"],
                    mapped["location_type"],
                    mapped["location_value"],
                    json.dumps(mapped["invitees"]),
                    mapped["meeting_url"],
                    mapped["occurred_at"],
                    dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


# ──────────────────────────────────────────────────────────────────────
# LinkedIn (profile singleton)
# ──────────────────────────────────────────────────────────────────────


def _linkedin_first_str(*candidates: Any) -> str | None:
    for c in candidates:
        if isinstance(c, str) and c.strip():
            return c.strip()
    return None


def _linkedin_picture_url(profile: dict[str, Any]) -> str | None:
    direct = _linkedin_first_str(
        profile.get("picture_url"),
        profile.get("pictureUrl"),
        profile.get("picture"),
    )
    if direct:
        return direct
    pp = profile.get("profilePicture")
    if isinstance(pp, dict):
        display = pp.get("displayImage~") or pp.get("displayImage")
        if isinstance(display, dict):
            elements = display.get("elements")
            if isinstance(elements, list) and elements:
                last = elements[-1]
                if isinstance(last, dict):
                    identifiers = last.get("identifiers")
                    if isinstance(identifiers, list) and identifiers:
                        first = identifiers[0]
                        if isinstance(first, dict):
                            return _linkedin_first_str(first.get("identifier"))
    return None


def _map_linkedin_profile(profile: dict[str, Any]) -> dict[str, Any] | None:
    raw_id = profile.get("id") or profile.get("linkedin_id") or profile.get("sub")
    linkedin_id = str(raw_id).strip() if raw_id is not None else ""
    if not linkedin_id:
        return None

    name = profile.get("name") if isinstance(profile.get("name"), dict) else None
    first_name = _linkedin_first_str(
        profile.get("firstName") if isinstance(profile.get("firstName"), str) else None,
        profile.get("localizedFirstName"),
        profile.get("given_name"),
        name.get("first_name") if name else None,
    )
    last_name = _linkedin_first_str(
        profile.get("lastName") if isinstance(profile.get("lastName"), str) else None,
        profile.get("localizedLastName"),
        profile.get("family_name"),
        name.get("last_name") if name else None,
    )
    localized = _linkedin_first_str(
        profile.get("localizedName"),
        name.get("localized") if name else None,
        " ".join(s for s in (first_name, last_name) if s) or None,
    )
    vanity = _linkedin_first_str(profile.get("vanityName"), profile.get("vanity_name"))
    profile_url = _linkedin_first_str(
        profile.get("profile_url"),
        profile.get("publicProfileUrl"),
        f"https://www.linkedin.com/in/{vanity}" if vanity else None,
    )

    return {
        "linkedin_id": linkedin_id,
        "first_name": first_name,
        "last_name": last_name,
        "localized_name": localized,
        "headline": _linkedin_first_str(profile.get("headline")),
        "vanity_name": vanity,
        "picture_url": _linkedin_picture_url(profile),
        "profile_url": profile_url,
        "occurred_at": datetime.now(UTC),
    }


async def _upsert_linkedin_profile(
    conn: AsyncConnection[DictRow],
    user_id: int,
    items: list[dict[str, Any]],
) -> int:
    """ON CONFLICT (user_id, linkedin_id) DO UPDATE — profile fields
    (headline, picture, vanity) drift over time; refresh in place."""
    inserted = 0
    for item in items:
        mapped = _map_linkedin_profile(item)
        if mapped is None:
            continue
        row_id = _gen_raw_id()
        dedupe = f"linkedin:profile:{mapped['linkedin_id']}"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_linkedin_profile (
                  user_id, id, linkedin_id, first_name, last_name,
                  localized_name, headline, vanity_name,
                  picture_url, profile_url, occurred_at, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s,
                  %s, %s, %s,
                  %s, %s, %s, %s
                )
                ON CONFLICT (user_id, linkedin_id) DO UPDATE SET
                  first_name = EXCLUDED.first_name,
                  last_name = EXCLUDED.last_name,
                  localized_name = EXCLUDED.localized_name,
                  headline = EXCLUDED.headline,
                  vanity_name = EXCLUDED.vanity_name,
                  picture_url = EXCLUDED.picture_url,
                  profile_url = EXCLUDED.profile_url,
                  occurred_at = EXCLUDED.occurred_at
                """,
                (
                    user_id,
                    row_id,
                    mapped["linkedin_id"],
                    mapped["first_name"],
                    mapped["last_name"],
                    mapped["localized_name"],
                    mapped["headline"],
                    mapped["vanity_name"],
                    mapped["picture_url"],
                    mapped["profile_url"],
                    mapped["occurred_at"],
                    dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


# ──────────────────────────────────────────────────────────────────────
# Stripe (invoices — merchant-side; non-merchant accounts return [])
# ──────────────────────────────────────────────────────────────────────


def _stripe_unix_to_datetime(value: Any) -> datetime | None:
    """Stripe timestamps are unix seconds (int). Defensive parse — None
    on garbage so caller falls back to NOW() at the call site."""
    if isinstance(value, (int, float)) and value > 0:
        return datetime.fromtimestamp(float(value), tz=UTC)
    if isinstance(value, str) and value.isdigit():
        return datetime.fromtimestamp(int(value), tz=UTC)
    return None


def _stripe_int_or_none(value: Any) -> int | None:
    """Amounts are integer cents on the wire. Don't convert to float."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.lstrip("-").isdigit():
        return int(value)
    return None


def _map_stripe_invoice(inv: dict[str, Any]) -> dict[str, Any] | None:
    raw_id = inv.get("id") or inv.get("invoice_id")
    invoice_id = str(raw_id).strip() if raw_id is not None else ""
    if not invoice_id:
        return None

    customer_raw = inv.get("customer")
    if isinstance(customer_raw, dict):
        customer_id = customer_raw.get("id") if isinstance(customer_raw.get("id"), str) else None
    elif isinstance(customer_raw, str):
        customer_id = customer_raw
    else:
        customer_id = None

    created_at = _stripe_unix_to_datetime(inv.get("created"))
    due_at = _stripe_unix_to_datetime(inv.get("due_date"))
    occurred = created_at or datetime.now(UTC)

    return {
        "invoice_id": invoice_id,
        "number": inv.get("number") if isinstance(inv.get("number"), str) else None,
        "status": inv.get("status") if isinstance(inv.get("status"), str) else None,
        "amount_due": _stripe_int_or_none(inv.get("amount_due")),
        "amount_paid": _stripe_int_or_none(inv.get("amount_paid")),
        "amount_remaining": _stripe_int_or_none(inv.get("amount_remaining")),
        "currency": inv.get("currency") if isinstance(inv.get("currency"), str) else None,
        "customer_id": customer_id,
        "customer_email": (
            inv.get("customer_email") if isinstance(inv.get("customer_email"), str) else None
        ),
        "customer_name": (
            inv.get("customer_name") if isinstance(inv.get("customer_name"), str) else None
        ),
        "collection_method": (
            inv.get("collection_method") if isinstance(inv.get("collection_method"), str) else None
        ),
        "created_at_remote": created_at,
        "due_date": due_at.date() if due_at else None,
        "hosted_invoice_url": (
            inv.get("hosted_invoice_url")
            if isinstance(inv.get("hosted_invoice_url"), str)
            else None
        ),
        "invoice_pdf": (
            inv.get("invoice_pdf") if isinstance(inv.get("invoice_pdf"), str) else None
        ),
        "occurred_at": occurred,
    }


async def _upsert_stripe_invoices(
    conn: AsyncConnection[DictRow],
    user_id: int,
    items: list[dict[str, Any]],
) -> int:
    """ON CONFLICT (user_id, invoice_id) DO UPDATE — invoice status flips
    (open → paid → void); amounts also mutate via partial payments."""
    inserted = 0
    for item in items:
        mapped = _map_stripe_invoice(item)
        if mapped is None:
            continue
        row_id = _gen_raw_id()
        dedupe = f"stripe:invoice:{mapped['invoice_id']}"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_stripe_invoices (
                  user_id, id, invoice_id, number, status,
                  amount_due, amount_paid, amount_remaining, currency,
                  customer_id, customer_email, customer_name,
                  collection_method, created_at_remote, due_date,
                  hosted_invoice_url, invoice_pdf, occurred_at, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s,
                  %s, %s, %s, %s,
                  %s, %s, %s,
                  %s, %s, %s,
                  %s, %s, %s, %s
                )
                ON CONFLICT (user_id, invoice_id) DO UPDATE SET
                  number = EXCLUDED.number,
                  status = EXCLUDED.status,
                  amount_due = EXCLUDED.amount_due,
                  amount_paid = EXCLUDED.amount_paid,
                  amount_remaining = EXCLUDED.amount_remaining,
                  customer_email = EXCLUDED.customer_email,
                  customer_name = EXCLUDED.customer_name,
                  hosted_invoice_url = EXCLUDED.hosted_invoice_url,
                  invoice_pdf = EXCLUDED.invoice_pdf,
                  occurred_at = EXCLUDED.occurred_at
                """,
                (
                    user_id,
                    row_id,
                    mapped["invoice_id"],
                    mapped["number"],
                    mapped["status"],
                    mapped["amount_due"],
                    mapped["amount_paid"],
                    mapped["amount_remaining"],
                    mapped["currency"],
                    mapped["customer_id"],
                    mapped["customer_email"],
                    mapped["customer_name"],
                    mapped["collection_method"],
                    mapped["created_at_remote"],
                    mapped["due_date"],
                    mapped["hosted_invoice_url"],
                    mapped["invoice_pdf"],
                    mapped["occurred_at"],
                    dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


# ──────────────────────────────────────────────────────────────────────
# YouTube (subscribed channels — taste graph snapshot)
# ──────────────────────────────────────────────────────────────────────


def _map_youtube_subscription(sub: dict[str, Any]) -> dict[str, Any] | None:
    raw_id = sub.get("id") or sub.get("subscription_id")
    subscription_id = str(raw_id).strip() if raw_id is not None else ""
    if not subscription_id:
        return None

    snippet = _as_dict(sub.get("snippet"))
    resource = _as_dict(snippet.get("resourceId"))
    channel_id = str(resource.get("channelId") or "").strip()
    if not channel_id:
        # Some Composio shapes flatten resourceId; tolerate top-level fields.
        channel_id = str(snippet.get("channelId") or "").strip()
    if not channel_id:
        return None

    thumbnails = _as_dict(snippet.get("thumbnails"))
    thumb_default = _as_dict(thumbnails.get("default"))
    thumb_url = thumb_default.get("url") if isinstance(thumb_default.get("url"), str) else None

    subscribed_at = _parse_iso(snippet.get("publishedAt"))
    occurred = subscribed_at or datetime.now(UTC)

    return {
        "subscription_id": subscription_id,
        "channel_id": channel_id,
        "channel_title": (snippet.get("title") if isinstance(snippet.get("title"), str) else None),
        "channel_description": (
            snippet.get("description") if isinstance(snippet.get("description"), str) else None
        ),
        "thumbnail_url": thumb_url,
        "subscribed_at": subscribed_at,
        "occurred_at": occurred,
    }


async def _upsert_youtube_subscriptions(
    conn: AsyncConnection[DictRow],
    user_id: int,
    items: list[dict[str, Any]],
) -> int:
    """ON CONFLICT (user_id, subscription_id) DO UPDATE — channel title /
    description / thumbnail can change; subscribed_at stays anchored."""
    inserted = 0
    for item in items:
        mapped = _map_youtube_subscription(item)
        if mapped is None:
            continue
        row_id = _gen_raw_id()
        dedupe = f"youtube:sub:{mapped['subscription_id']}"
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_youtube_subscriptions (
                  user_id, id, subscription_id, channel_id, channel_title,
                  channel_description, thumbnail_url, subscribed_at,
                  occurred_at, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s,
                  %s, %s, %s,
                  %s, %s
                )
                ON CONFLICT (user_id, subscription_id) DO UPDATE SET
                  channel_title = EXCLUDED.channel_title,
                  channel_description = EXCLUDED.channel_description,
                  thumbnail_url = EXCLUDED.thumbnail_url,
                  occurred_at = EXCLUDED.occurred_at
                """,
                (
                    user_id,
                    row_id,
                    mapped["subscription_id"],
                    mapped["channel_id"],
                    mapped["channel_title"],
                    mapped["channel_description"],
                    mapped["thumbnail_url"],
                    mapped["subscribed_at"],
                    mapped["occurred_at"],
                    dedupe,
                ),
            )
            if (cur.rowcount or 0) > 0:
                inserted += 1
    return inserted


_UPSERTERS.update(
    {
        "gmail": _upsert_gmail,
        "googlecalendar": _upsert_gcal,
        "github": _upsert_github_issues,
        "slack": _upsert_slack_messages,
        "googledrive": _upsert_gdrive_files,
        "calendly": _upsert_calendly_events,
        "linkedin": _upsert_linkedin_profile,
        "stripe": _upsert_stripe_invoices,
        "youtube": _upsert_youtube_subscriptions,
    }
)


def supported_toolkits() -> frozenset[str]:
    """Public read-only view of toolkits with a working upserter.
    Used by tests + diagnostics. A toolkit must additionally have an
    ingestable recipe (see ingest_runner.ingestable_toolkits()) for
    end-to-end ingest to actually run."""
    return frozenset(_UPSERTERS.keys())


# ── Timeline projector helpers (shared by the _tl_* projectors) ──


def _clip(value: Any, limit: int = 200) -> str:
    """Title-safe one-liner: coerce to str, strip, ellipsize."""
    s = str(value).strip() if value is not None else ""
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _clean(meta: dict[str, Any]) -> dict[str, Any]:
    """Drop None / empty values so metadata stays lean. Datetimes/dates
    must already be ISO strings — the caller stringifies them."""
    return {k: v for k, v in meta.items() if v not in (None, "", [], {})}


def _source_ref(toolkit: str, cid: str, provider_id: str) -> dict[str, Any]:
    """Provenance back to the Composio origin. `toolkit` is the canonical
    Composio slug (e.g. 'googlecalendar'); `provider_id` is the source's
    natural id (message_id / event_id / ...)."""
    return {"toolkit": toolkit, "connected_account_id": cid, "provider_id": provider_id}


def _iso(value: Any) -> str | None:
    """ISO-stringify a datetime/date for JSON metadata; pass through other
    falsy/str values unchanged-ish."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return None


# ─────────────────────────────────────────────────────────────────────
# Timeline projection (dual-write): map the SAME fetched items into
# pai_timeline_events alongside the raw tables, so the proactive agent
# sees connector events on the timeline. Rule-based, no LLM; the raw
# path + connector.evolve are untouched (see _run_init / _run_sync).
# ─────────────────────────────────────────────────────────────────────


def _tl_id(dedupe_key: str) -> str:
    """Deterministic per-user event id derived from the dedupe_key so a
    retry before the first commit lands on the same row. On a real
    re-ingest the (user_id, dedupe_key) UNIQUE index is what UPSERTs;
    this id is just the PK shape requirement."""
    return "tle_" + hashlib.sha1(dedupe_key.encode()).hexdigest()[:16]


async def _ingest_timeline(
    conn: AsyncConnection[DictRow],
    user_id: int,
    items: list[dict[str, Any]],
    *,
    toolkit: str,
    cid: str,
) -> int:
    """Map → project → upsert each fetched item into pai_timeline_events.
    Returns the number of events written (insert or update; the timeline
    dedupe_key UNIQUE absorbs re-fetches). Skips items the parser drops."""
    entry = _TIMELINE_MAPPERS.get(toolkit)
    if entry is None:
        return 0
    mapper, projector = entry
    repo = TimelineRepository(user_id, conn)
    written = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        mapped = mapper(item)
        if mapped is None:
            continue
        await repo.upsert_event(projector(mapped, toolkit=toolkit, cid=cid))
        written += 1
    return written


async def _dual_write_timeline(
    pool: AsyncConnectionPool,
    user_id: int,
    items: list[dict[str, Any]],
    *,
    toolkit: str,
    cid: str,
) -> int:
    """Best-effort timeline dual-write in its OWN transaction, run AFTER the
    raw ingest has committed. The raw tables + connector.evolve are the system
    of record (main chat / evolve / memory read them); the timeline projection
    is the additive proactive feed. A projection failure must never roll back
    or block the raw path — so we isolate it here and swallow errors with a
    log. Returns the number of events written (0 on skip/failure)."""
    if not items or toolkit not in _TIMELINE_MAPPERS:
        return 0
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            return await _ingest_timeline(
                conn,
                user_id,
                items,
                toolkit=toolkit,
                cid=cid,
            )
    except Exception:
        logger.exception(
            "[timeline] dual-write failed user=%d toolkit=%s (raw ingest unaffected)",
            user_id,
            toolkit,
        )
        return 0


def _tl_gmail(mapped: dict[str, Any], *, toolkit: str, cid: str) -> IngestTimelineEvent:
    dedupe = f"gmail:msg:{mapped['message_id']}"
    participants: list[dict[str, Any]] = []
    if mapped["from_addr"]:
        participants.append({"identifier": mapped["from_addr"], "role": "from"})
    participants += [{"identifier": a, "role": "to"} for a in mapped["to_addrs"]]
    participants += [{"identifier": a, "role": "cc"} for a in mapped["cc_addrs"]]
    title = mapped["subject"] or mapped["snippet"]
    if not title:
        title = f"Email from {mapped['from_addr']}" if mapped["from_addr"] else "Email"
    return IngestTimelineEvent(
        id=_tl_id(dedupe),
        occurred_at=mapped["occurred_at"],
        source="gmail",
        event_type="communication",
        title=_clip(title),
        body=mapped["body"] or mapped["snippet"],
        participants=participants,
        metadata=_clean(
            {
                "thread_id": mapped["thread_id"],
                "label_ids": mapped["label_ids"],
            }
        ),
        source_ref=_source_ref(toolkit, cid, mapped["message_id"]),
        curation_status="pending",
        dedupe_key=dedupe,
    )


def _tl_gcal(mapped: dict[str, Any], *, toolkit: str, cid: str) -> IngestTimelineEvent:
    dedupe = f"gcal:evt:{mapped['calendar_id']}:{mapped['event_id']}"
    loc = mapped["location"]
    return IngestTimelineEvent(
        id=_tl_id(dedupe),
        occurred_at=mapped["occurred_at"],
        end_at=mapped["end_at"],
        source="gcal",
        event_type="meeting",
        title=_clip(mapped["title"] or "Calendar event"),
        body=mapped["description"],
        participants=[{"identifier": a} for a in mapped["attendees"]],
        location={"place_name": loc} if isinstance(loc, str) and loc else None,
        metadata=_clean(
            {
                "calendar_id": mapped["calendar_id"],
                "status": mapped["status"],
            }
        ),
        source_ref=_source_ref(toolkit, cid, mapped["event_id"]),
        curation_status="pending",
        dedupe_key=dedupe,
    )


def _tl_github(mapped: dict[str, Any], *, toolkit: str, cid: str) -> IngestTimelineEvent:
    dedupe = f"github:issue:{mapped['issue_id']}"
    kind = "PR" if mapped["is_pull_request"] else "Issue"
    repo = mapped["repo_full_name"]
    title = mapped["title"] or f"{kind} #{mapped['number']}"
    return IngestTimelineEvent(
        id=_tl_id(dedupe),
        occurred_at=mapped["occurred_at"],
        source="github",
        event_type="commit",
        title=_clip(f"{repo}: {title}" if repo else title),
        body=mapped["body_preview"],
        participants=[{"identifier": a} for a in mapped["assignees"]],
        metadata=_clean(
            {
                "repo_full_name": repo,
                "number": mapped["number"],
                "state": mapped["state"],
                "html_url": mapped["html_url"],
                "is_pull_request": mapped["is_pull_request"],
                "labels": mapped["labels"],
            }
        ),
        source_ref=_source_ref(toolkit, cid, mapped["issue_id"]),
        curation_status="pending",
        dedupe_key=dedupe,
    )


def _tl_slack(mapped: dict[str, Any], *, toolkit: str, cid: str) -> IngestTimelineEvent:
    dedupe = f"slack:msg:{mapped['channel_id']}:{mapped['ts']}"
    channel = mapped["channel_name"] or mapped["channel_id"]
    title = mapped["text"] or f"Message in #{channel}"
    participants: list[dict[str, Any]] = []
    if mapped["slack_user_id"] or mapped["slack_user_name"]:
        participants.append(
            _clean(
                {
                    "identifier": mapped["slack_user_id"],
                    "name": mapped["slack_user_name"],
                }
            )
        )
    return IngestTimelineEvent(
        id=_tl_id(dedupe),
        occurred_at=mapped["occurred_at"],
        source="slack",
        event_type="communication",
        title=_clip(title),
        body=mapped["text"],
        participants=participants,
        metadata=_clean(
            {
                "channel_id": mapped["channel_id"],
                "channel_name": mapped["channel_name"],
                "thread_ts": mapped["thread_ts"],
                "permalink": mapped["permalink"],
            }
        ),
        source_ref=_source_ref(toolkit, cid, f"{mapped['channel_id']}:{mapped['ts']}"),
        curation_status="pending",
        dedupe_key=dedupe,
    )


def _tl_gdrive(mapped: dict[str, Any], *, toolkit: str, cid: str) -> IngestTimelineEvent:
    dedupe = f"gdrive:file:{mapped['file_id']}"
    return IngestTimelineEvent(
        id=_tl_id(dedupe),
        occurred_at=mapped["occurred_at"],
        source="gdrive",
        event_type="commit",
        title=_clip(mapped["name"] or "(untitled file)"),
        participants=[{"identifier": o} for o in mapped["owners"]],
        metadata=_clean(
            {
                "mime_type": mapped["mime_type"],
                "web_view_link": mapped["web_view_link"],
                "size_bytes": mapped["size_bytes"],
                "trashed": mapped["trashed"],
            }
        ),
        source_ref=_source_ref(toolkit, cid, mapped["file_id"]),
        curation_status="pending",
        dedupe_key=dedupe,
    )


def _tl_calendly(mapped: dict[str, Any], *, toolkit: str, cid: str) -> IngestTimelineEvent:
    dedupe = f"calendly:event:{mapped['event_uri']}"
    loc = mapped["location_value"]
    participants = [
        _clean({"name": inv.get("name"), "identifier": inv.get("email")})
        for inv in mapped["invitees"]
    ]
    return IngestTimelineEvent(
        id=_tl_id(dedupe),
        occurred_at=mapped["occurred_at"],
        end_at=mapped["end_at"],
        source="calendly",
        event_type="meeting",
        title=_clip(mapped["name"] or "Calendly event"),
        participants=[p for p in participants if p],
        location={"place_name": loc} if isinstance(loc, str) and loc else None,
        metadata=_clean(
            {
                "status": mapped["status"],
                "location_type": mapped["location_type"],
                "meeting_url": mapped["meeting_url"],
            }
        ),
        source_ref=_source_ref(toolkit, cid, mapped["event_uri"]),
        curation_status="pending",
        dedupe_key=dedupe,
    )


def _tl_linkedin(mapped: dict[str, Any], *, toolkit: str, cid: str) -> IngestTimelineEvent:
    dedupe = f"linkedin:profile:{mapped['linkedin_id']}"
    name = mapped["localized_name"] or " ".join(
        s for s in (mapped["first_name"], mapped["last_name"]) if s
    )
    return IngestTimelineEvent(
        id=_tl_id(dedupe),
        occurred_at=mapped["occurred_at"],
        source="linkedin",
        event_type="state_change",
        title=_clip(name or "LinkedIn profile"),
        body=mapped["headline"],
        metadata=_clean(
            {
                "first_name": mapped["first_name"],
                "last_name": mapped["last_name"],
                "vanity_name": mapped["vanity_name"],
                "profile_url": mapped["profile_url"],
                "picture_url": mapped["picture_url"],
            }
        ),
        source_ref=_source_ref(toolkit, cid, mapped["linkedin_id"]),
        curation_status="pending",
        dedupe_key=dedupe,
    )


def _tl_stripe(mapped: dict[str, Any], *, toolkit: str, cid: str) -> IngestTimelineEvent:
    dedupe = f"stripe:invoice:{mapped['invoice_id']}"
    label = mapped["number"] or mapped["invoice_id"]
    status = mapped["status"]
    title = f"Invoice {label}" + (f" — {status}" if status else "")
    return IngestTimelineEvent(
        id=_tl_id(dedupe),
        occurred_at=mapped["occurred_at"],
        source="stripe",
        event_type="transaction",
        title=_clip(title),
        metadata=_clean(
            {
                "status": status,
                "amount_due": mapped["amount_due"],
                "amount_paid": mapped["amount_paid"],
                "amount_remaining": mapped["amount_remaining"],
                "currency": mapped["currency"],
                "customer_email": mapped["customer_email"],
                "customer_name": mapped["customer_name"],
                "hosted_invoice_url": mapped["hosted_invoice_url"],
                "invoice_pdf": mapped["invoice_pdf"],
                "due_date": _iso(mapped["due_date"]),
            }
        ),
        source_ref=_source_ref(toolkit, cid, mapped["invoice_id"]),
        curation_status="pending",
        dedupe_key=dedupe,
    )


def _tl_youtube(mapped: dict[str, Any], *, toolkit: str, cid: str) -> IngestTimelineEvent:
    dedupe = f"youtube:sub:{mapped['subscription_id']}"
    channel = mapped["channel_title"] or mapped["channel_id"]
    return IngestTimelineEvent(
        id=_tl_id(dedupe),
        occurred_at=mapped["occurred_at"],
        source="youtube",
        event_type="consumption",
        title=_clip(f"Subscribed to {channel}"),
        body=mapped["channel_description"],
        metadata=_clean(
            {
                "channel_id": mapped["channel_id"],
                "thumbnail_url": mapped["thumbnail_url"],
                "subscribed_at": _iso(mapped["subscribed_at"]),
            }
        ),
        source_ref=_source_ref(toolkit, cid, mapped["subscription_id"]),
        curation_status="pending",
        dedupe_key=dedupe,
    )


_TIMELINE_MAPPERS.update(
    {
        "gmail": (_map_gmail_message, _tl_gmail),
        "googlecalendar": (_map_gcal_event, _tl_gcal),
        "github": (_map_github_issue, _tl_github),
        "slack": (_map_slack_message, _tl_slack),
        "googledrive": (_map_gdrive_file, _tl_gdrive),
        "calendly": (_map_calendly_event, _tl_calendly),
        "linkedin": (_map_linkedin_profile, _tl_linkedin),
        "stripe": (_map_stripe_invoice, _tl_stripe),
        "youtube": (_map_youtube_subscription, _tl_youtube),
    }
)
