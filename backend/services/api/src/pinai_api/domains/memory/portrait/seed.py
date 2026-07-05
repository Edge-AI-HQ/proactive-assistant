"""First-touch starter goal seeding into the L2 GOALS portrait.

When a brand-new users row is INSERTed by `upsert_user_by_supabase_id`,
seed a handful of starter goals into the `pai_user_strings` GOALS slot
(markdown) so the agent has something to reason about before the user
has stated any. evolve / chat later refine the GOALS slot via
`memory_edit` (add/replace/remove).

Best-effort + idempotent: skips when the GOALS slot already has content,
so a duplicate call (e.g. a re-login that re-runs onboarding) is a no-op.
A transient DB hiccup here logs and returns; the user still logs in fine.
"""

from __future__ import annotations

import logging

from pinai_db.rls import user_scoped_tx
from psycopg_pool import AsyncConnectionPool

from .repository import EditOp, UserStringsRepository

logger = logging.getLogger(__name__)


# Starter goals seeded into the GOALS portrait slot for a fresh user.
# (Was the openclaw plugin's starterGoals → pai_goals; now markdown entries
# in the GOALS slot since goals retired into the L2 portrait.)
_STARTER_GOALS: tuple[str, ...] = (
    "Advance career and professional skills",
    "Maintain consistent exercise and healthy habits",
    "Grow savings and make smart financial decisions",
    "Dedicate time to learning new skills and ideas",
    "Stay connected with family and close friends",
    "Protect personal time and avoid burnout",
)


async def seed_default_goals(
    pool: AsyncConnectionPool,
    user_id: int,
) -> None:
    """Seed starter goals into the GOALS portrait slot for a freshly INSERTed user."""
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            repo = UserStringsRepository(user_id, conn)
            content, _version = await repo.get_slot("GOALS")
            if content.strip():
                # User already has goals (re-login / agent populated them) — no-op.
                return
            result = await repo.edit(
                "GOALS",
                operations=[EditOp(op="add", text=g) for g in _STARTER_GOALS],
            )
            if not result.ok:
                logger.warning(
                    "default goals: GOALS seed rejected user=%d reason=%s",
                    user_id,
                    result.reason,
                )
                return
    except Exception as e:
        logger.warning(
            "default goals: seeding failed user=%d (skipping; agent can add goals later): %s",
            user_id,
            e,
        )
        return
    logger.info(
        "default goals: seeded %d starter goals into GOALS slot user=%d",
        len(_STARTER_GOALS),
        user_id,
    )
