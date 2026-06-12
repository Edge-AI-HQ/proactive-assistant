"""Seed mock intent cards into the local DB (sphere-cloud UI testing).

Cards surface via /api/cards, which reads `final_cards` JSONB off completed
`pai_pipeline_runs` rows — so one mock run row with N cards is all it takes.
Mock rows are identifiable (id/run_id prefix `mock-`, trigger='mock') per
AGENTS.md mock-data rules: local/dev only, never prod, clean up after.

Usage:
    cd pinai-agents
    uv run python scripts/seed_mock_cards.py [user_id]      # seed (default: latest user)
    uv run python scripts/seed_mock_cards.py --clean [user_id]  # remove mock rows

Local compose postgres has a random host port — run inside the web container
(`docker exec <project>-pinai-web-1 ...`) or export DATABASE_URL first.
"""

from __future__ import annotations

import asyncio
import json
import sys
from datetime import UTC, datetime
from typing import cast

from psycopg import AsyncConnection
from psycopg.rows import DictRow
from psycopg_pool import AsyncConnectionPool

from pinai_agents.web.db.pool import close_pool, open_pool
from pinai_agents.web.db.rls import user_scoped_tx

MOCK_RUN_ID = "mock-run-001"


def _mock_cards(now_iso: str) -> list[dict[str, object]]:
    """Six cards across goal baskets so the sphere shows the full category/
    icon spread (wealth→finance, family→life mappings included)."""
    specs: list[dict[str, object]] = [
        {
            "id": "mock-card-001",
            "goalBasket": "work",
            "title": "Prep talking points for tomorrow's investor sync",
            "whyNow": "Calendar shows the sync at 10:00 tomorrow and the deck is still in draft.",
            "summary": "Draft 5 talking points from last week's metrics and the open funding thread.",
            "urgency": 0.9,
            "importance": 0.85,
            "confidence": 0.8,
            "sourceApps": ["gcal", "gmail"],
        },
        {
            "id": "mock-card-002",
            "goalBasket": "health",
            "title": "Book a dental cleaning — 8 months since last visit",
            "whyNow": "Insurance covers two cleanings a year; the benefit resets soon.",
            "summary": "Find an in-network dentist with Saturday slots and hold one.",
            "urgency": 0.4,
            "importance": 0.6,
            "confidence": 0.75,
            "sourceApps": ["device"],
        },
        {
            "id": "mock-card-003",
            "goalBasket": "wealth",
            "title": "Rebalance: cash position drifted to 28%",
            "whyNow": "Two paychecks landed without auto-invest; target allocation is 15% cash.",
            "summary": "Review the drift and queue a transfer back to the index funds.",
            "urgency": 0.55,
            "importance": 0.8,
            "confidence": 0.7,
            "sourceApps": ["web"],
        },
        {
            "id": "mock-card-004",
            "goalBasket": "growth",
            "title": "Your conference CFP closes Friday",
            "whyNow": "You starred the CFP email two weeks ago; deadline is in 3 days.",
            "summary": "Draft a 150-word abstract from your recent agent-infra write-up.",
            "urgency": 0.8,
            "importance": 0.7,
            "confidence": 0.85,
            "sourceApps": ["gmail"],
        },
        {
            "id": "mock-card-005",
            "goalBasket": "family",
            "title": "Mom's birthday is in 10 days — gift not ordered",
            "whyNow": "Shipping the usual tea set takes 7-9 days; the window is closing.",
            "summary": "Reorder last year's tea set or pick from 3 alternatives under $80.",
            "urgency": 0.65,
            "importance": 0.9,
            "confidence": 0.9,
            "sourceApps": ["memory"],
        },
        {
            "id": "mock-card-006",
            "goalBasket": "life",
            "title": "Rain expected Saturday — move the hike to Sunday",
            "whyNow": "Forecast flipped to 80% rain for your planned trailhead window.",
            "summary": "Shift the calendar block and notify the group chat.",
            "urgency": 0.5,
            "importance": 0.45,
            "confidence": 0.7,
            "sourceApps": ["web", "gcal"],
        },
    ]
    cards: list[dict[str, object]] = []
    for spec in specs:
        cards.append(
            {
                **spec,
                "intentKey": f"{spec['id']}-intent",
                "primaryAction": {
                    "label": "Do it",
                    "type": "confirm",
                    "agentPrompt": f"Execute this task for the user: {spec['title']}",
                },
                "secondaryActions": [{"label": "Later", "type": "snooze"}],
                "sources": [f"signal id={spec['id']}-src mock seed"],
                "reasoningSteps": [
                    {
                        "label": "Spotted the trigger",
                        "detail": str(spec["whyNow"]),
                    },
                    {
                        "label": "Checked it's actionable now",
                        "detail": "Mock seed card — reasoning steps exist so the drawer section renders.",
                    },
                ],
                "agentChain": ["mock-seed"],
                "createdAt": now_iso,
            }
        )
    return cards


async def _latest_user_id(pool: AsyncConnectionPool) -> int:
    async with pool.connection() as raw_conn:
        # Pool row_factory is dict_row; the generic pool type loses it (same
        # cast as rls.user_scoped_tx).
        conn = cast("AsyncConnection[DictRow]", raw_conn)
        cur = await conn.execute("SELECT id FROM users ORDER BY id DESC LIMIT 1")
        row = await cur.fetchone()
    if row is None:
        print("No users in DB — log in once first, then re-run.")
        raise SystemExit(1)
    return int(row["id"])


async def _seed(pool: AsyncConnectionPool, user_id: int) -> None:
    now = datetime.now(UTC)
    cards = _mock_cards(now.isoformat())
    async with user_scoped_tx(pool, user_id) as conn:
        await conn.execute(
            """
            INSERT INTO pai_pipeline_runs
              (user_id, id, run_id, status, total_iterations, final_cards,
               trigger, started_at, completed_at)
            VALUES (%s, %s, %s, 'completed', 1, %s::jsonb, 'mock', %s, %s)
            ON CONFLICT (user_id, id) DO UPDATE SET
              final_cards = EXCLUDED.final_cards,
              completed_at = EXCLUDED.completed_at,
              updated_at = NOW()
            """,
            (user_id, MOCK_RUN_ID, MOCK_RUN_ID, json.dumps(cards), now, now),
        )
    print(f"Seeded {len(cards)} mock cards for user {user_id} (run {MOCK_RUN_ID}).")
    print("Clean up later with: uv run python scripts/seed_mock_cards.py --clean")


async def _clean(pool: AsyncConnectionPool, user_id: int) -> None:
    async with user_scoped_tx(pool, user_id) as conn:
        cur = await conn.execute(
            "DELETE FROM pai_pipeline_runs WHERE user_id = %s AND id LIKE 'mock-%%'",
            (user_id,),
        )
        print(f"Removed {cur.rowcount} mock pipeline run row(s) for user {user_id}.")


async def _main(argv: list[str]) -> None:
    clean = "--clean" in argv
    args = [a for a in argv if a != "--clean"]
    pool = await open_pool()
    try:
        user_id = int(args[0]) if args else await _latest_user_id(pool)
        if clean:
            await _clean(pool, user_id)
        else:
            await _seed(pool, user_id)
    finally:
        await close_pool(pool)


if __name__ == "__main__":
    asyncio.run(_main(sys.argv[1:]))
