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

import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import DictRow
from psycopg_pool import AsyncConnectionPool

from ..auth.user_service import load_user_by_id
from ..db.repositories.connectors import ConnectorsRepository
from ..db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    enqueue_once,
    requeue_once,
    update_progress,
)
from ..db.rls import user_scoped_tx
from . import generic_ingest, ingest_runner, recipe_infer

logger = logging.getLogger(__name__)

_DEFAULT_LIMIT = 100
_MAX_LIMIT = 500

# After init succeeds, we schedule a periodic connector.sync for the same
# (toolkit, cid). 30 minutes balances freshness (chat answers feel current)
# vs. Composio API quota (7 connectors × N users × 48 syncs/day).
# Typed toolkits use this fixed cadence; generic (pai_raw_events) toolkits
# render their cron from the recipe's `sync_interval_hours` instead — see
# _cron_for_interval.
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


def _make_generic_upserter(toolkit: str, recipe: ingest_runner.Recipe) -> Upserter:
    """Adapter: bind (toolkit, recipe) so the generic pai_raw_events
    upserter matches the registry's Upserter signature. Used when a
    toolkit has no typed table — typed upserters always win."""
    entity_type = recipe.entity_type or "items"

    async def _upsert(
        conn: AsyncConnection[DictRow],
        user_id: int,
        items: list[dict[str, Any]],
    ) -> int:
        return await generic_ingest.upsert_generic(
            conn,
            user_id,
            toolkit,
            entity_type,
            recipe,
            items,
        )

    return _upsert


def _resolve_upserter(toolkit: str, recipe: ingest_runner.Recipe) -> Upserter:
    """Typed upserter if registered, else the generic fallback."""
    return _UPSERTERS.get(toolkit) or _make_generic_upserter(toolkit, recipe)


def _resolve_subs(
    toolkit: str,
    recipe: ingest_runner.Recipe,
) -> list[tuple[str, ingest_runner.Recipe, Upserter]]:
    """Expand a fanout recipe (googlesuper) into its sub-toolkits' own
    (recipe, upserter) pairs; plain recipes resolve to themselves. Subs
    that are missing/non-ingestable/nested-fanout are dropped with a
    warning — the connection still works through the remaining subs."""
    if not recipe.fanout:
        return [(toolkit, recipe, _resolve_upserter(toolkit, recipe))]
    out: list[tuple[str, ingest_runner.Recipe, Upserter]] = []
    for sub in recipe.fanout:
        sub_tk = sub.strip().lower()
        sub_recipe = ingest_runner.load_recipe(sub_tk)
        if sub_recipe is None or not sub_recipe.is_ingestable() or sub_recipe.fanout:
            logger.warning(
                "[connector] fanout %s: sub-toolkit %s unsupported — skipped",
                toolkit,
                sub_tk,
            )
            continue
        out.append((sub_tk, sub_recipe, _resolve_upserter(sub_tk, sub_recipe)))
    return out


def _cron_for_interval(hours: int) -> str:
    """Render a sync cron from the recipe's sync_interval_hours. Generic
    long-tail toolkits default to 12h — polling 1000+ toolkits at the
    typed 30-minute cadence would burn Composio quota for no freshness
    gain. >= 24h collapses to daily at 06:00 UTC."""
    h = max(1, hours)
    if h >= 24:
        return "0 6 * * *"
    return f"0 */{h} * * *"


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
      * connector.preview — onboarding-only first pull: wait for ACTIVE,
        fetch a small source window, cache the summary, then let init continue.
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
    if task.kind == "connector.preview":
        await _run_preview(pool, task, run_id)
    elif task.kind == "connector.sync":
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


async def _mark_preview_not_active(
    pool: AsyncConnectionPool,
    task: ScheduledTaskRow,
    toolkit: str,
    *,
    connected_account_id: str,
    status: str,
) -> None:
    """Skip abandoned OAuth accounts without retrying the onboarding preview."""
    async with user_scoped_tx(pool, task.user_id) as conn:
        await update_progress(
            conn,
            user_id=task.user_id,
            task_id=task.id,
            progress={
                "stage": "skipped",
                "reason": "connection_not_active",
                "toolkit": toolkit,
                "connectedAccountId": connected_account_id,
                "status": status,
            },
        )
    logger.info(
        "[connector.preview] skipped user=%d toolkit=%s cid=%s status=%s",
        task.user_id,
        toolkit,
        connected_account_id,
        status,
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
    cron_expr: str = _SYNC_CRON_EXPR,
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
                cron_expr,
                first_fire,
                json.dumps({"toolkit": toolkit, "connectedAccountId": cid}),
            ),
        )


async def _enqueue_full_init_after_preview(
    conn: AsyncConnection[DictRow],
    *,
    user_id: int,
    toolkit: str,
    cid: str,
) -> str:
    task_id = f"init.{toolkit}.{cid}"
    await enqueue_once(
        conn,
        user_id=user_id,
        task_id=task_id,
        kind="connector.init",
        payload={
            "toolkit": toolkit,
            "connectedAccountId": cid,
            "reason": "connector_preview",
            "limit": _DEFAULT_LIMIT,
        },
        max_attempts=3,
    )
    return task_id


async def _run_preview(
    pool: AsyncConnectionPool,
    task: ScheduledTaskRow,
    run_id: str,
) -> None:
    """Onboarding fast path.

    This task owns the slow parts that used to sit behind the OAuth UI:
    Composio ACTIVE wait, a 50-item preview fetch, and summary generation.
    Full connector.init is enqueued after the preview summary is cached so
    the full pull does not compete with the first user-visible summary.
    """
    toolkit_raw, cid, limit = _validate_payload(task)
    user_id = task.user_id

    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={"stage": "waiting_active", "toolkit": toolkit_raw, "limit": limit},
        )

    from ..composio_service import ComposioError, wait_active  # noqa: PLC0415
    from ..routes.ui import onboarding as onboarding_routes  # noqa: PLC0415

    try:
        active = await wait_active(cid)
    except ComposioError as exc:
        if "timeout while waiting for connection" not in str(exc).lower():
            raise
        await _mark_preview_not_active(
            pool,
            task,
            toolkit_raw,
            connected_account_id=cid,
            status="TIMEOUT",
        )
        return
    if active.status != "ACTIVE":
        await _mark_preview_not_active(
            pool,
            task,
            toolkit_raw,
            connected_account_id=cid,
            status=active.status,
        )
        return

    active_toolkit = str(active.toolkit or toolkit_raw).strip().lower()
    if not active_toolkit or active_toolkit == "unknown":
        active_toolkit = toolkit_raw
    preview_limit = max(1, min(limit, onboarding_routes.MAX_CONNECTOR_SUMMARY_ITEMS))
    summary_toolkit = onboarding_routes._summary_source_toolkit(active_toolkit)

    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={
                "stage": "fetch",
                "toolkit": active_toolkit,
                "sourceToolkit": summary_toolkit,
                "limit": preview_limit,
            },
        )

    recipe = ingest_runner.load_recipe(summary_toolkit)
    if recipe is None:
        recipe = await recipe_infer.ainfer_recipe(summary_toolkit)
    if recipe is None or not recipe.is_ingestable():
        await _mark_skipped(pool, task, summary_toolkit, log_prefix="[connector.preview]")
        async with user_scoped_tx(pool, user_id) as conn:
            await _enqueue_full_init_after_preview(
                conn,
                user_id=user_id,
                toolkit=active_toolkit,
                cid=cid,
            )
        return
    subs = _resolve_subs(summary_toolkit, recipe)
    if not subs:
        await _mark_skipped(pool, task, summary_toolkit, log_prefix="[connector.preview]")
        async with user_scoped_tx(pool, user_id) as conn:
            await _enqueue_full_init_after_preview(
                conn,
                user_id=user_id,
                toolkit=active_toolkit,
                cid=cid,
            )
        return

    user = await load_user_by_id(pool, user_id)
    if user is None:
        msg = f"connector.preview: user {user_id} not found"
        raise RuntimeError(msg)

    preview_items_by_sub: dict[str, list[dict[str, Any]]] = {}
    for sub_tk, _, _ in subs:
        preview_items_by_sub[sub_tk] = await ingest_runner.run_fetch(
            user,
            sub_tk,
            cid,
            limit=preview_limit,
            since=None,
            pool=pool,
        )
    total_fetched = sum(len(items) for items in preview_items_by_sub.values())

    per_toolkit: dict[str, dict[str, Any]] = {}
    total_inserted = 0
    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={
                "stage": "raw",
                "toolkit": active_toolkit,
                "sourceToolkit": summary_toolkit,
                "fetched": total_fetched,
                "limit": preview_limit,
            },
        )
        for sub_tk, _, sub_upserter in subs:
            sub_items = preview_items_by_sub[sub_tk]
            sub_inserted = await sub_upserter(conn, user_id, sub_items)
            total_inserted += sub_inserted
            per_toolkit[sub_tk] = {
                "fetched": len(sub_items),
                "rawInserted": sub_inserted,
            }
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={
                "stage": "summary",
                "toolkit": active_toolkit,
                "sourceToolkit": summary_toolkit,
                "fetched": total_fetched,
                "rawInserted": total_inserted,
                **({"perToolkit": per_toolkit} if len(per_toolkit) > 1 else {}),
            },
        )

    summary = await onboarding_routes.build_connector_summary_for_onboarding(
        pool,
        user=user,
        toolkit=active_toolkit,
        connected_account_id=cid,
        limit=preview_limit,
    )

    async with user_scoped_tx(pool, user_id) as conn:
        init_task_id = await _enqueue_full_init_after_preview(
            conn,
            user_id=user_id,
            toolkit=active_toolkit,
            cid=cid,
        )
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={
                "stage": "done",
                "toolkit": active_toolkit,
                "sourceToolkit": summary_toolkit,
                "fetched": total_fetched,
                "rawInserted": total_inserted,
                "summaryItemCount": summary.source.item_count,
                "initTaskId": init_task_id,
            },
        )

    logger.info(
        "[connector.preview] done user=%d toolkit=%s source=%s fetched=%d inserted=%d summary_items=%d run=%s",
        user_id,
        active_toolkit,
        summary_toolkit,
        total_fetched,
        total_inserted,
        summary.source.item_count,
        run_id,
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

    recipe = ingest_runner.load_recipe(toolkit_raw)
    if recipe is None:
        # No handwritten yaml — infer from Composio tool schemas (cached
        # per process; handwritten yaml always wins when present).
        recipe = await recipe_infer.ainfer_recipe(toolkit_raw)
    if recipe is None or not recipe.is_ingestable():
        await _mark_skipped(pool, task, toolkit_raw, log_prefix="[connector.init]")
        return
    subs = _resolve_subs(toolkit_raw, recipe)
    if not subs:
        await _mark_skipped(pool, task, toolkit_raw, log_prefix="[connector.init]")
        return
    is_fanout = bool(recipe.fanout)

    user = await load_user_by_id(pool, user_id)
    if user is None:
        msg = f"connector.init: user {user_id} not found"
        raise RuntimeError(msg)

    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={
                "stage": "fetch",
                "toolkit": toolkit_raw,
                "limit": limit,
                **({"subToolkits": [s for s, _, _ in subs]} if is_fanout else {}),
            },
        )

    # Init mode: since=None — recipe omits the cursor arg; toolkit's
    # natural default window applies. Fanout: one sub failing must not
    # sink the others; all-failed still raises for dispatcher retry.
    items_by_sub: dict[str, list[dict[str, Any]]] = {}
    fetch_errors: dict[str, str] = {}
    for sub_tk, _, _ in subs:
        try:
            items_by_sub[sub_tk] = await ingest_runner.run_fetch(
                user,
                sub_tk,
                cid,
                limit=limit,
                since=None,
                pool=pool,
            )
        except Exception as e:
            if not is_fanout:
                raise
            logger.warning("[connector.init] fanout sub=%s fetch failed: %s", sub_tk, e)
            fetch_errors[sub_tk] = f"{type(e).__name__}: {e}"[:300]
    if fetch_errors and len(fetch_errors) == len(subs):
        msg = f"connector.init: all fanout subs failed: {fetch_errors}"
        raise RuntimeError(msg)
    total_fetched = sum(len(v) for v in items_by_sub.values())

    per_toolkit: dict[str, dict[str, Any]] = {}
    total_inserted = 0
    evolve_task_id = None
    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={"stage": "raw", "toolkit": toolkit_raw, "fetched": total_fetched},
        )
        for sub_tk, _, sub_upserter in subs:
            if sub_tk not in items_by_sub:
                per_toolkit[sub_tk] = {"error": fetch_errors.get(sub_tk, "fetch failed")}
                continue
            sub_items = items_by_sub[sub_tk]
            sub_inserted = await sub_upserter(conn, user_id, sub_items)
            total_inserted += sub_inserted
            # Evolve is per sub-connector: the evolve agent reads raw by
            # the SUB toolkit, so each sub gets its own task.
            evolve_task_id = await _enqueue_evolve(
                conn,
                user_id=user_id,
                toolkit=sub_tk,
                cid=cid,
            )
            per_toolkit[sub_tk] = {
                "fetched": len(sub_items),
                "rawInserted": sub_inserted,
                "evolveTaskId": evolve_task_id,
            }
        # Typed toolkits keep the legacy 30-minute cadence; generic
        # long-tail toolkits poll at the recipe's interval (default 12h).
        # Fanout schedules ONE sync for the aggregate toolkit; it fans
        # out again at fire time.
        sync_cron = (
            _SYNC_CRON_EXPR
            if toolkit_raw in _UPSERTERS
            else _cron_for_interval(recipe.sync_interval_hours)
        )
        await _ensure_sync_schedule(
            conn,
            user_id=user_id,
            toolkit=toolkit_raw,
            cid=cid,
            cron_expr=sync_cron,
        )
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={
                "stage": "evolve",
                "toolkit": toolkit_raw,
                "fetched": total_fetched,
                "rawInserted": total_inserted,
                "evolveTaskId": evolve_task_id,
                **({"perToolkit": per_toolkit} if is_fanout else {}),
            },
        )

    logger.info(
        "[connector.init] done user=%d toolkit=%s fetched=%d inserted=%d "
        "evolve_task=%s sync_schedule=sync.%s.%s",
        user_id,
        toolkit_raw,
        total_fetched,
        total_inserted,
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

    recipe = ingest_runner.load_recipe(toolkit_raw)
    if recipe is None:
        recipe = await recipe_infer.ainfer_recipe(toolkit_raw)
    if recipe is None or not recipe.is_ingestable():
        await _mark_skipped(pool, task, toolkit_raw, log_prefix="[connector.sync]")
        return
    subs = _resolve_subs(toolkit_raw, recipe)
    if not subs:
        await _mark_skipped(pool, task, toolkit_raw, log_prefix="[connector.sync]")
        return
    is_fanout = bool(recipe.fanout)

    user = await load_user_by_id(pool, user_id)
    if user is None:
        msg = f"connector.sync: user {user_id} not found"
        raise RuntimeError(msg)

    # ── Stage: read cursors (per sub — each sub-toolkit advances its
    # own (user, sub, cid) cursor, so a failing sub re-pulls its own
    # window without disturbing the others) ──
    since_by_sub: dict[str, datetime | None] = {}
    async with user_scoped_tx(pool, user_id) as conn:
        repo = ConnectorsRepository(user_id, conn)
        for sub_tk, _, _ in subs:
            cursor = await repo.get_cursor(
                toolkit=sub_tk,
                connected_account_id=cid,
            )
            if cursor is not None:
                since_by_sub[sub_tk] = cursor.last_synced_at
            elif is_fanout:
                # Existing aggregate connections can gain new fanout subs
                # after deploy. No cursor means this sub never had its latest
                # 100 init pull, so omit `since` and let the recipe defaults
                # fetch the newest page.
                since_by_sub[sub_tk] = None
            else:
                since_by_sub[sub_tk] = started_at - _BOOTSTRAP_LOOKBACK
    since_values = [dt for dt in since_by_sub.values() if dt is not None]
    since_min = min(since_values) if since_values else None

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
                "since": since_min.isoformat() if since_min is not None else None,
                **({"subToolkits": [s for s, _, _ in subs]} if is_fanout else {}),
            },
        )

    items_by_sub: dict[str, list[dict[str, Any]]] = {}
    fetch_errors: dict[str, str] = {}
    for sub_tk, _, _ in subs:
        try:
            items_by_sub[sub_tk] = await ingest_runner.run_fetch(
                user,
                sub_tk,
                cid,
                limit=limit,
                since=since_by_sub[sub_tk],
                pool=pool,
            )
        except Exception as e:
            if not is_fanout:
                raise
            logger.warning("[connector.sync] fanout sub=%s fetch failed: %s", sub_tk, e)
            fetch_errors[sub_tk] = f"{type(e).__name__}: {e}"[:300]
    if fetch_errors and len(fetch_errors) == len(subs):
        msg = f"connector.sync: all fanout subs failed: {fetch_errors}"
        raise RuntimeError(msg)
    total_fetched = sum(len(v) for v in items_by_sub.values())

    # ── Stage: raw + cursor ──
    per_toolkit: dict[str, dict[str, Any]] = {}
    total_inserted = 0
    evolve_task_id = None
    async with user_scoped_tx(pool, user_id) as conn:
        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={"stage": "raw", "toolkit": toolkit_raw, "fetched": total_fetched},
        )
        repo = ConnectorsRepository(user_id, conn)
        for sub_tk, _, sub_upserter in subs:
            if sub_tk not in items_by_sub:
                # Fetch failed: cursor stays put so the next sync re-pulls
                # this sub's window; raw dedupe absorbs the overlap.
                per_toolkit[sub_tk] = {"error": fetch_errors.get(sub_tk, "fetch failed")}
                continue
            sub_items = items_by_sub[sub_tk]
            sub_inserted = await sub_upserter(conn, user_id, sub_items)
            total_inserted += sub_inserted
            # Advance cursor to started_at (NOT now()) — captures the lower
            # bound for the *next* sync. Using now() would skip events created
            # during this run.
            await repo.set_cursor(
                toolkit=sub_tk,
                connected_account_id=cid,
                last_synced_at=started_at,
            )
            # Only enqueue evolve if we actually inserted something — empty
            # syncs are common and don't need an LLM.
            if sub_inserted > 0:
                evolve_task_id = await _enqueue_evolve(
                    conn,
                    user_id=user_id,
                    toolkit=sub_tk,
                    cid=cid,
                )
            per_toolkit[sub_tk] = {
                "fetched": len(sub_items),
                "rawInserted": sub_inserted,
                **({"evolveTaskId": evolve_task_id} if sub_inserted > 0 else {}),
            }

        await update_progress(
            conn,
            user_id=user_id,
            task_id=task.id,
            progress={
                "stage": "done",
                "toolkit": toolkit_raw,
                "fetched": total_fetched,
                "rawInserted": total_inserted,
                "since": since_min.isoformat() if since_min is not None else None,
                "syncedThrough": started_at.isoformat(),
                **({"evolveTaskId": evolve_task_id} if evolve_task_id else {}),
                **({"perToolkit": per_toolkit} if is_fanout else {}),
            },
        )

    logger.info(
        "[connector.sync] done user=%d toolkit=%s fetched=%d inserted=%d "
        "since=%s synced_through=%s",
        user_id,
        toolkit_raw,
        total_fetched,
        total_inserted,
        since_min.isoformat() if since_min is not None else None,
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
    """ON CONFLICT (user_id, message_id) — keep the existing row, except
    heal an empty body. Gmail messages are immutable, so a re-fetch of the
    same id is normally a no-op; but rows ingested before the recipe fix
    (verbose=false stored an empty body) get backfilled when a re-fetch now
    carries the decoded full body. The WHERE guard means good rows are never
    rewritten. Returns count of rows inserted-or-healed."""
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
                ON CONFLICT (user_id, message_id) DO UPDATE SET
                  body = EXCLUDED.body,
                  snippet = COALESCE(EXCLUDED.snippet, pai_raw_gmail_messages.snippet)
                WHERE COALESCE(pai_raw_gmail_messages.body, '') = ''
                  AND COALESCE(EXCLUDED.body, '') <> ''
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
    body_full = body if isinstance(body, str) else None
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
        "body": body_full,
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
                  title, body, body_preview, state, html_url, is_pull_request,
                  labels, assignees,
                  created_at_remote, updated_at_remote, occurred_at,
                  dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s,
                  %s, %s, %s, %s, %s, %s,
                  %s::jsonb, %s::jsonb,
                  %s, %s, %s,
                  %s
                )
                ON CONFLICT (user_id, issue_id) DO UPDATE SET
                  state = EXCLUDED.state,
                  title = EXCLUDED.title,
                  body = EXCLUDED.body,
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
                    mapped["body"],
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
