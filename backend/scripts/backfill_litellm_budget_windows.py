#!/usr/bin/env python3
"""Backfill existing LiteLLM keys to follow DB budget windows.

Use after changing the product budget clock from LiteLLM's ``30d`` calendar
reset to ``pai_budget_periods.period_end``. This script recomputes the
LiteLLM max_budget and budget_duration for existing users WITHOUT clearing
their current spend.

Usage (inside the api container):
    uv run python -m scripts.backfill_litellm_budget_windows
    uv run python -m scripts.backfill_litellm_budget_windows --apply
    uv run python -m scripts.backfill_litellm_budget_windows --supabase-uuid <uuid> --apply

Default mode is dry-run. ``--apply`` is required for writes.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


def _setup_path() -> None:
    root = Path(__file__).resolve().parents[1]
    src = root / "src"
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))


_setup_path()

logger = logging.getLogger("backfill_litellm_budget_windows")


@dataclass(slots=True)
class SyncResult:
    user_id: int
    email: str | None
    supabase_user_id: str
    plan_code: str
    period_end: datetime
    applied: bool
    updated: bool

    @property
    def label(self) -> str:
        return (
            f"user={self.user_id} email={self.email or '-'} "
            f"uuid={self.supabase_user_id} plan={self.plan_code}"
        )


RecomputeFn = Callable[..., Awaitable[bool]]


async def _fetch_candidates(
    conn,
    *,
    email: str | None = None,
    supabase_uuid: str | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    sql = """
        SELECT u.id,
               u.email,
               u.supabase_user_id,
               COALESCE(s.plan_code, bp.plan_code, 'free') AS plan_code,
               bp.period_end
        FROM users u
        JOIN pai_budget_periods bp
          ON bp.user_id = u.id AND bp.state = 'open'
        LEFT JOIN pai_subscriptions s
          ON s.user_id = u.id
        WHERE u.litellm_virtual_key IS NOT NULL
          AND u.litellm_virtual_key <> ''
          AND (%s IS NULL OR u.email = %s)
          AND (%s IS NULL OR u.supabase_user_id = %s)
        ORDER BY u.id
        LIMIT %s
    """
    async with conn.cursor() as cur:
        await cur.execute(
            sql,
            [
                email,
                email,
                supabase_uuid,
                supabase_uuid,
                limit if limit is not None else 2_147_483_647,
            ],
        )
        return list(await cur.fetchall())


async def _sync_candidate(
    conn,
    row: dict[str, Any],
    *,
    apply_changes: bool,
    recompute: RecomputeFn | None = None,
) -> SyncResult:
    result = SyncResult(
        user_id=int(row["id"]),
        email=row.get("email"),
        supabase_user_id=str(row["supabase_user_id"]),
        plan_code=str(row["plan_code"]),
        period_end=row["period_end"],
        applied=apply_changes,
        updated=False,
    )
    if not apply_changes:
        return result

    if recompute is None:
        from pinai_api.domains.billing.payments import checkout as checkout_flow

        recompute = checkout_flow.recompute_litellm_budget

    # Critical: reset_spend=False preserves existing usage while updating the
    # LiteLLM duration to the DB period's remaining seconds.
    result.updated = await recompute(conn, result.user_id, reset_spend=False)
    return result


async def _run(args: argparse.Namespace) -> int:
    from pinai_db.pool import close_pool, open_pool
    from pinai_db.rls import service_tx

    pool = await open_pool()
    try:
        async with service_tx(pool) as conn:
            candidates = await _fetch_candidates(
                conn,
                email=args.email,
                supabase_uuid=args.supabase_uuid,
                limit=args.limit,
            )
            if not candidates:
                logger.info("no candidates found")
                return 0

            updated = 0
            for row in candidates:
                result = await _sync_candidate(
                    conn,
                    row,
                    apply_changes=args.apply,
                )
                updated += 1 if result.updated else 0
                mode = "APPLY" if result.applied else "DRY-RUN"
                status = "updated" if result.updated else "would_update"
                if result.applied and not result.updated:
                    status = "skipped_no_key_or_litellm_error"
                logger.info(
                    "%s %s period_end=%s status=%s",
                    mode,
                    result.label,
                    result.period_end.isoformat(),
                    status,
                )

            logger.info(
                "done candidates=%d updated=%d dry_run=%s",
                len(candidates),
                updated,
                not args.apply,
            )
        return 0
    finally:
        await close_pool(pool)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", help="limit to one users.email")
    parser.add_argument("--supabase-uuid", help="limit to one users.supabase_user_id")
    parser.add_argument("--limit", type=int, help="limit number of candidates")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write LiteLLM updates. Omit for dry-run.",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
