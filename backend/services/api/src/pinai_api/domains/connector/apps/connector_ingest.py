"""connector.init / connector.sync handler — drive Composio fetch via
the recipe-based ingest_runner, upsert into the apps-domain L0
`pai_raw_apps` table, then enqueue a connector.evolve task so the LLM
agent distills them into the L2 portrait.

Fetch half lives in `services/ingest_runner.py` (yaml recipe → Composio
SDK call). This module owns the upsert half: every toolkit lands in
`pai_raw_apps` via the generic recipe-driven upserter (`generic_ingest`,
toolkit + entity_type discriminator). Adding a new toolkit is purely a
recipe: write `db/ingest_recipes/<toolkit>.yaml` (fetch + projection
spec); no per-toolkit code. (The old per-toolkit typed `_map_/_upsert_`
functions + typed pai_raw_* tables were removed in the L0 contract step;
device data has its own domain table, pai_raw_device.)

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
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from pinai_db.rls import user_scoped_tx
from psycopg import AsyncConnection
from psycopg.rows import DictRow
from psycopg_pool import AsyncConnectionPool

from ....platform.auth.user_service import load_user_by_id
from ....platform.db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    enqueue_once,
    requeue_once,
    update_progress,
)
from ...memory.projection import project_unprojected
from . import generic_ingest, ingest_runner, recipe_infer
from .connectors import ConnectorsRepository

logger = logging.getLogger(__name__)

_DEFAULT_LIMIT = 100
_MAX_LIMIT = 500

# After init succeeds, we schedule a periodic connector.sync for the same
# (toolkit, cid). 30 minutes balances freshness (chat answers feel current)
# vs. Composio API quota (7 connectors × N users × 48 syncs/day).
# High-frequency toolkits use this fixed cadence; the long-tail renders its
# cron from the recipe's `sync_interval_hours` instead — see _cron_for_interval.
_SYNC_CRON_EXPR = "*/30 * * * *"

# The high-frequency Composio toolkits that keep the fixed 30-min cadence
# (these were the "typed" toolkits before the L0 contract collapsed every
# source into pai_raw; the cadence stays, the typed tables are gone).
# Everything else polls at its recipe interval. Slugs are Composio toolkit ids
# (googlecalendar, not the gcal path alias).
_FAST_CADENCE_TOOLKITS: frozenset[str] = frozenset(
    {
        "gmail",
        "googlecalendar",
        "github",
        "slack",
        "googledrive",
        "calendly",
        "linkedin",
        "stripe",
        "youtube",
    }
)

# First sync after init: cursor doesn't exist yet, so we look back this
# far. Init already pulled the most recent items, so this window mostly
# overlaps — raw-table dedupe absorbs duplicates.
_BOOTSTRAP_LOOKBACK = timedelta(hours=24)


# ──────────────────────────────────────────────────────────────────────
# Upserter
# ──────────────────────────────────────────────────────────────────────

# Upserter: (conn, user_id, items) → newly-inserted count.
Upserter = Callable[
    [AsyncConnection[DictRow], int, list[dict[str, Any]]],
    Awaitable[int],
]


def _make_generic_upserter(toolkit: str, recipe: ingest_runner.Recipe) -> Upserter:
    """Adapter: bind (toolkit, recipe) so the recipe-driven generic upserter
    (writes pai_raw, toolkit + entity_type discriminator) matches the Upserter
    signature. Every toolkit uses this — there are no typed upserters anymore."""
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
    """Unified L0: every toolkit lands in pai_raw via the generic upserter
    (recipe-driven, no per-toolkit code)."""
    return _make_generic_upserter(toolkit, recipe)


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

    from ...identity import onboarding as onboarding_routes  # noqa: PLC0415
    from .composio_service import ComposioError, wait_active  # noqa: PLC0415

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
        # Project freshly-ingested raw → the L1 event stream (pending), in the
        # same tx so raw + events commit atomically. Idempotent (skips raws
        # already projected via source_ref).
        await project_unprojected(conn, user_id)
        # High-frequency toolkits keep the legacy 30-minute cadence; the
        # long-tail polls at the recipe's interval (default 12h). Fanout
        # schedules ONE sync for the aggregate toolkit; it fans out again
        # at fire time.
        sync_cron = (
            _SYNC_CRON_EXPR
            if toolkit_raw in _FAST_CADENCE_TOOLKITS
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

        # Project freshly-ingested raw → the L1 event stream (pending), same tx.
        await project_unprojected(conn, user_id)

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


def supported_toolkits() -> frozenset[str]:
    """Toolkits that can actually ingest — those with an ingestable recipe.
    Every source now lands in pai_raw via the generic upserter (the typed
    per-toolkit upserters are gone), so "supported" == "has an ingestable
    recipe". Used by tests + diagnostics."""
    return frozenset(
        tk
        for tk in ingest_runner.supported_toolkits()
        if (r := ingest_runner.load_recipe(tk)) is not None and r.is_ingestable()
    )
