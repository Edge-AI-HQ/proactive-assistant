#!/usr/bin/env python3
"""Data-collector acceptance CLI — drive the connector pipeline end to end
from the command line, no frontend, no waiting on the scheduler tick.

    connect     OAuth/link a toolkit, poll until ACTIVE, print the cid
    connections list ACTIVE connections (find a cid)
    ingest      fabricate a connector.init/sync task → connector_ingest.run()
                directly (bypasses the tick loop; the evolve enqueue and sync
                schedule it writes are REAL rows)
    raw         dump recent raw rows (typed table or pai_raw_events)
    evolve      requeue connector.evolve and poll it to a terminal state
                (the running web tick loop dispatches it — needs `make up`)
    signals     dump recent pai_personal_signals
    memory      dump recent pai_memory
    pipeline    ingest → evolve → signals in one go, printing per-step counts

Usage (from backend/, with .env loaded for Composio + chat creds):
    set -a && . .env && set +a
    uv run python -m scripts.collector_cli connect notion
    uv run python -m scripts.collector_cli pipeline notion --cid <cid>

DSN resolution: --dsn > DATABASE_URL > TEST_DATABASE_URL.
User resolution: --user-email / --user-id; defaults to the only user row.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from pinai_api import composio_service as cs
from pinai_api.domains.connector.apps import connector_ingest
from pinai_api.platform.auth.user_service import User, load_user_by_id
from pinai_api.platform.db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    requeue_once,
)
from pinai_api.routes.agent.raw import _RAW_TABLES
from pinai_db.rls import user_scoped_tx
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

_EVOLVE_POLL_SECONDS = 5.0
_EVOLVE_TIMEOUT_SECONDS = 900.0


def _dsn(args: argparse.Namespace) -> str:
    dsn = args.dsn or os.environ.get("DATABASE_URL") or os.environ.get("TEST_DATABASE_URL")
    if not dsn:
        sys.exit("error: no DSN — pass --dsn or set DATABASE_URL / TEST_DATABASE_URL")
    return dsn.replace("postgresql+psycopg://", "postgresql://", 1)


async def _open_pool(args: argparse.Namespace) -> AsyncConnectionPool:
    pool = AsyncConnectionPool(
        conninfo=_dsn(args),
        min_size=1,
        max_size=4,
        kwargs={"row_factory": dict_row},
        open=False,
    )
    await pool.open()
    return pool


async def _resolve_user(pool: AsyncConnectionPool, args: argparse.Namespace) -> User:
    if args.user_id:
        user = await load_user_by_id(pool, args.user_id)
        if user is None:
            sys.exit(f"error: user id {args.user_id} not found")
        return user
    async with pool.connection() as conn:
        if args.user_email:
            cur = await conn.execute("SELECT id FROM users WHERE email = %s", (args.user_email,))
        else:
            cur = await conn.execute("SELECT id FROM users ORDER BY id LIMIT 3")
        rows = await cur.fetchall()
    if args.user_email:
        if not rows:
            sys.exit(f"error: no user with email {args.user_email}")
    elif len(rows) != 1:
        sys.exit(f"error: DB has 0 or 2+ users — pass --user-email/--user-id (found {len(rows)})")
    row = cast(dict[str, Any], rows[0])
    user = await load_user_by_id(pool, int(row["id"]))
    if user is None:  # pragma: no cover — row existed a moment ago
        sys.exit("error: user vanished mid-lookup")
    return user


def _fabricate_task(
    user_id: int,
    *,
    kind: str,
    task_id: str,
    payload: dict[str, Any],
) -> ScheduledTaskRow:
    """Shape-compatible row for connector_ingest.run(). It is NOT inserted:
    update_progress on a missing row is a no-op, while the evolve enqueue
    and sync schedule the run writes are real rows in pai_scheduled_tasks."""
    return ScheduledTaskRow(
        user_id=user_id,
        id=task_id,
        kind=kind,
        name=None,
        prompt=None,
        trigger_kind="once",
        cron_expr=None,
        interval_seconds=None,
        event_filter=None,
        payload=payload,
        timezone="UTC",
        status="archived",
        next_run_at=None,
        last_run_at=datetime.now(UTC),
        last_run_status="dispatched",
        run_count=1,
        attempts=0,
        max_attempts=3,
        progress={},
        last_error=None,
    )


def _print_rows(rows: list[dict[str, Any]], *, fields: list[str]) -> None:
    for r in rows:
        out = {}
        for f in fields:
            v = r.get(f)
            if isinstance(v, datetime):
                v = v.isoformat()
            elif isinstance(v, str) and len(v) > 120:
                v = v[:117] + "..."
            out[f] = v
        print(json.dumps(out, ensure_ascii=False, default=str))


# ── subcommands ─────────────────────────────────────────────────────────


async def cmd_catalog(args: argparse.Namespace) -> None:
    page = await cs.list_catalog(
        category=args.category,
        query=args.query,
        cursor=args.cursor,
        limit=args.limit,
    )
    items = page.items
    for i in items:
        cats = ",".join(i.categories[:3])
        print(f"{i.slug:28s} {i.name[:32]:32s} [{cats}]")
    if page.next_cursor:
        print(f"\n--cursor {page.next_cursor}  (next page)")


async def cmd_infer(args: argparse.Namespace) -> None:
    from pinai_api.domains.connector.apps import recipe_infer
    from pinai_api.domains.connector.apps.ingest_runner import load_recipe

    recipe = load_recipe(args.toolkit)
    if recipe is not None:
        print(f"# handwritten yaml exists for {args.toolkit} (it wins at runtime):")
    else:
        recipe = await recipe_infer.ainfer_recipe(args.toolkit)
        if recipe is None:
            sys.exit(f"no tools found for toolkit {args.toolkit!r} — unknown slug?")
    dump = recipe.model_dump(exclude_defaults=True)
    if args.dump_yaml:
        import yaml as _yaml

        print(_yaml.safe_dump(dump, sort_keys=False, allow_unicode=True))
    else:
        print(json.dumps(dump, indent=2, ensure_ascii=False, default=str))
    print(f"# confidence={recipe.confidence} ingestable={recipe.is_ingestable()}")


async def cmd_connect(args: argparse.Namespace) -> None:
    pool = await _open_pool(args)
    try:
        user = await _resolve_user(pool, args)
        init = await cs.connect(user, args.toolkit)
        print(f"toolkit:  {init.toolkit}")
        print(f"cid:      {init.connected_account_id}")
        print(f"open and authorize:\n  {init.redirect_url}")
        print("polling until ACTIVE (Ctrl-C to stop)...")
        conn_info = await cs.wait_active(init.connected_account_id, timeout=args.timeout)
        print(f"status:   {conn_info.status}")
        if conn_info.status != "ACTIVE":
            sys.exit("connection did not become ACTIVE — re-run or check Composio")
        print(
            f"\nnext: uv run python -m scripts.collector_cli ingest "
            f"{args.toolkit} --cid {init.connected_account_id}"
        )
    finally:
        await pool.close()


async def cmd_connections(args: argparse.Namespace) -> None:
    pool = await _open_pool(args)
    try:
        user = await _resolve_user(pool, args)
        conns = await cs.list_connections(user)
        for c in conns:
            print(f"{c.toolkit:20s} {c.status:10s} {c.connected_account_id}")
        if not conns:
            print("(no connections)")
    finally:
        await pool.close()


async def cmd_ingest(args: argparse.Namespace) -> None:
    pool = await _open_pool(args)
    try:
        user = await _resolve_user(pool, args)
        kind = f"connector.{args.mode}"
        task = _fabricate_task(
            user.id,
            kind=kind,
            task_id=f"cli.{args.mode}.{args.toolkit}.{args.cid}",
            payload={
                "toolkit": args.toolkit,
                "connectedAccountId": args.cid,
                **({"limit": args.limit} if args.limit else {}),
            },
        )
        print(f"running {kind} toolkit={args.toolkit} cid={args.cid} ...")
        await connector_ingest.run(pool, task, run_id=f"cli-{args.mode}")
        print(
            "done — counts land in the log lines above "
            "([connector.init]/[connector.sync] done ... fetched=N inserted=N)"
        )
    finally:
        await pool.close()


async def cmd_raw(args: argparse.Namespace) -> None:
    pool = await _open_pool(args)
    try:
        user = await _resolve_user(pool, args)
        since = datetime.now(UTC) - timedelta(hours=args.since_hours)
        key = (args.toolkit.lower(), args.entity.lower())
        table = _RAW_TABLES.get(key)
        async with user_scoped_tx(pool, user.id) as conn:
            if table is not None:
                cur = await conn.execute(
                    f"SELECT * FROM {table} WHERE user_id=%s AND occurred_at >= %s "
                    "ORDER BY occurred_at DESC LIMIT %s",
                    (user.id, since, args.limit),
                )
            else:
                cur = await conn.execute(
                    "SELECT * FROM pai_raw_events WHERE user_id=%s AND toolkit=%s "
                    "AND entity_type=%s AND occurred_at >= %s "
                    "ORDER BY occurred_at DESC LIMIT %s",
                    (user.id, key[0], key[1], since, args.limit),
                )
            rows = await cur.fetchall()
        store = table or "pai_raw_events"
        print(f"{len(rows)} rows from {store} (last {args.since_hours}h)")
        fields = (
            ["external_id", "occurred_at", "title", "snippet", "dedupe_key"]
            if table is None
            else ["id", "occurred_at", "dedupe_key"]
        )
        _print_rows(rows, fields=fields)
    finally:
        await pool.close()


async def _evolve_and_poll(pool: AsyncConnectionPool, user: User, toolkit: str, cid: str) -> str:
    task_id = f"evolve.{toolkit}.{cid}"
    async with user_scoped_tx(pool, user.id) as conn:
        await requeue_once(
            conn,
            user_id=user.id,
            task_id=task_id,
            kind="connector.evolve",
            payload={"connector": toolkit, "connectedAccountId": cid},
            max_attempts=2,
        )
    print(
        f"enqueued {task_id} — waiting for the web tick loop to dispatch "
        "(needs `make up` / web process running)"
    )
    deadline = asyncio.get_event_loop().time() + _EVOLVE_TIMEOUT_SECONDS
    last_seen = ""
    while asyncio.get_event_loop().time() < deadline:
        async with user_scoped_tx(pool, user.id) as conn:
            cur = await conn.execute(
                "SELECT status, last_run_status, progress, last_error "
                "FROM pai_scheduled_tasks WHERE user_id=%s AND id=%s",
                (user.id, task_id),
            )
            row = await cur.fetchone()
        if row is None:
            return "missing"
        line = (
            f"status={row['status']} last_run={row['last_run_status']} "
            f"progress={json.dumps(row['progress'] or {}, default=str)[:200]}"
        )
        if line != last_seen:
            print(f"  {line}")
            last_seen = line
        if row["status"] in ("archived", "failed"):
            if row["last_error"]:
                print(f"  last_error: {row['last_error'][:500]}")
            return str(row["status"])
        await asyncio.sleep(_EVOLVE_POLL_SECONDS)
    return "timeout"


async def cmd_evolve(args: argparse.Namespace) -> None:
    pool = await _open_pool(args)
    try:
        user = await _resolve_user(pool, args)
        outcome = await _evolve_and_poll(pool, user, args.toolkit, args.cid)
        print(f"evolve outcome: {outcome}")
        if outcome != "archived":
            sys.exit(1)
    finally:
        await pool.close()


async def _dump_signals(pool: AsyncConnectionPool, user: User, since_hours: int, limit: int) -> int:
    since = datetime.now(UTC) - timedelta(hours=since_hours)
    async with user_scoped_tx(pool, user.id) as conn:
        cur = await conn.execute(
            "SELECT id, kind, title, status, salience, ingested_at "
            "FROM pai_personal_signals WHERE user_id=%s AND ingested_at >= %s "
            "ORDER BY ingested_at DESC LIMIT %s",
            (user.id, since, limit),
        )
        rows = await cur.fetchall()
    print(f"{len(rows)} signals (last {since_hours}h)")
    _print_rows(rows, fields=["kind", "title", "status", "salience", "ingested_at"])
    return len(rows)


async def cmd_signals(args: argparse.Namespace) -> None:
    pool = await _open_pool(args)
    try:
        user = await _resolve_user(pool, args)
        await _dump_signals(pool, user, args.since_hours, args.limit)
    finally:
        await pool.close()


async def cmd_memory(args: argparse.Namespace) -> None:
    pool = await _open_pool(args)
    try:
        user = await _resolve_user(pool, args)
        async with user_scoped_tx(pool, user.id) as conn:
            cur = await conn.execute(
                "SELECT id, text, source, quality, status, created_at "
                "FROM pai_memory WHERE user_id=%s "
                "ORDER BY created_at DESC LIMIT %s",
                (user.id, args.limit),
            )
            rows = await cur.fetchall()
        print(f"{len(rows)} memory rows")
        _print_rows(rows, fields=["text", "source", "quality", "status", "created_at"])
    finally:
        await pool.close()


async def cmd_pipeline(args: argparse.Namespace) -> None:
    pool = await _open_pool(args)
    try:
        user = await _resolve_user(pool, args)
        print(f"=== 1/3 ingest (connector.init) {args.toolkit} ===")
        task = _fabricate_task(
            user.id,
            kind="connector.init",
            task_id=f"cli.init.{args.toolkit}.{args.cid}",
            payload={
                "toolkit": args.toolkit,
                "connectedAccountId": args.cid,
                **({"limit": args.limit} if args.limit else {}),
            },
        )
        await connector_ingest.run(pool, task, run_id="cli-pipeline")

        print(f"=== 2/3 evolve {args.toolkit} ===")
        outcome = await _evolve_and_poll(pool, user, args.toolkit, args.cid)
        print(f"evolve outcome: {outcome}")

        print("=== 3/3 signals ===")
        n = await _dump_signals(pool, user, since_hours=1, limit=args.limit or 50)
        if outcome != "archived" or n == 0:
            print("pipeline INCOMPLETE — check evolve outcome / signal count above")
            sys.exit(1)
        print("pipeline OK")
    finally:
        await pool.close()


# ── arg parsing ─────────────────────────────────────────────────────────


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--dsn", help="Postgres DSN (default $DATABASE_URL)")
    p.add_argument("--user-email", help="resolve user by email")
    p.add_argument("--user-id", type=int, help="resolve user by id")


def main() -> None:
    ap = argparse.ArgumentParser(prog="collector_cli", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("catalog", help="browse Composio's toolkit directory")
    p.add_argument("--category")
    p.add_argument("--cursor")
    p.add_argument("--query", help="client-side substring filter on this page")
    p.add_argument("--limit", type=int, default=50)
    _add_common(p)
    p.set_defaults(fn=cmd_catalog)

    p = sub.add_parser("infer", help="infer a recipe from Composio tool schemas")
    p.add_argument("toolkit")
    p.add_argument("--dump-yaml", action="store_true")
    _add_common(p)
    p.set_defaults(fn=cmd_infer)

    p = sub.add_parser("connect", help="OAuth a toolkit, wait until ACTIVE")
    p.add_argument("toolkit")
    p.add_argument("--timeout", type=float, default=300.0)
    _add_common(p)
    p.set_defaults(fn=cmd_connect)

    p = sub.add_parser("connections", help="list ACTIVE connections")
    _add_common(p)
    p.set_defaults(fn=cmd_connections)

    p = sub.add_parser("ingest", help="run connector.init/sync inline")
    p.add_argument("toolkit")
    p.add_argument("--cid", required=True)
    p.add_argument("--mode", choices=["init", "sync"], default="init")
    p.add_argument("--limit", type=int)
    _add_common(p)
    p.set_defaults(fn=cmd_ingest)

    p = sub.add_parser("raw", help="dump recent raw rows")
    p.add_argument("toolkit")
    p.add_argument("entity")
    p.add_argument("--since-hours", type=int, default=24)
    p.add_argument("--limit", type=int, default=20)
    _add_common(p)
    p.set_defaults(fn=cmd_raw)

    p = sub.add_parser("evolve", help="requeue evolve + poll to terminal state")
    p.add_argument("toolkit")
    p.add_argument("--cid", required=True)
    _add_common(p)
    p.set_defaults(fn=cmd_evolve)

    p = sub.add_parser("signals", help="dump recent personal signals")
    p.add_argument("--since-hours", type=int, default=24)
    p.add_argument("--limit", type=int, default=50)
    _add_common(p)
    p.set_defaults(fn=cmd_signals)

    p = sub.add_parser("memory", help="dump recent memory rows")
    p.add_argument("--limit", type=int, default=50)
    _add_common(p)
    p.set_defaults(fn=cmd_memory)

    p = sub.add_parser("pipeline", help="ingest → evolve → signals one-shot")
    p.add_argument("toolkit")
    p.add_argument("--cid", required=True)
    p.add_argument("--limit", type=int)
    _add_common(p)
    p.set_defaults(fn=cmd_pipeline)

    args = ap.parse_args()
    import logging

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    asyncio.run(args.fn(args))


if __name__ == "__main__":
    main()
