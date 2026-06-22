"""Local test driver: kick card_fanout.dispatch_card_bootstrap for
the latest completed generator pipeline run of a given user.

Mirrors what scheduler/dispatcher.py does after persist_generator_run,
but standalone so we can verify the chat-stream → propose_action loop
without waiting for a full generator invocation.

Run inside api (from repo root):
    docker compose cp backend/scripts/test_fanout.py api:/tmp/test_fanout.py
    docker compose exec api python /tmp/test_fanout.py <user_id>
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys

from pinai_api.domains.generation.card_fanout import dispatch_card_bootstrap
from pinai_api.platform.db.pool import close_pool, open_pool
from pinai_api.platform.db.rls import service_tx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


async def main(user_id: int) -> None:
    pool = await open_pool()
    try:
        async with service_tx(pool) as conn:
            cur = await conn.execute(
                """
                SELECT id, final_cards
                FROM pai_pipeline_runs
                WHERE user_id = %s AND status = 'completed'
                  AND final_cards IS NOT NULL
                ORDER BY started_at DESC
                LIMIT 1
                """,
                (user_id,),
            )
            row = await cur.fetchone()
        if row is None:
            print(f"no completed pipeline run for user {user_id}")
            return
        final_cards = row["final_cards"]
        if isinstance(final_cards, str):
            final_cards = json.loads(final_cards)
        pipeline_run_id = row["id"]
        print(
            f"dispatch_card_bootstrap user={user_id} pipeline={pipeline_run_id} "
            f"cards={len(final_cards)}"
        )

        dispatched = await dispatch_card_bootstrap(
            pool=pool,
            user_id=user_id,
            final_cards=final_cards or [],
        )
        print(f"dispatched ids: {dispatched}")
        # card_fanout dispatches cards inline now (no background tasks to
        # await — see the card_fanout.py module docstring).
    finally:
        await close_pool(pool)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: test_fanout <user_id>")
        sys.exit(1)
    asyncio.run(main(int(sys.argv[1])))
