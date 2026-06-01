"""First-touch starter goal seeding.

Mirrors the openclaw plugin's `ensureDefaultProfile`
(pinai-openclaw/plugins/proactive-ai/index.ts:43) — when a brand-new
users row is INSERTed by `upsert_user_by_supabase_id`, seed 6 starter
goals so the agent has something to reason about before the user has
explicitly stated any. The agent's evolve / chat path can later upsert
or close these via `goal_upsert`.

Best-effort: a transient DB hiccup here logs and returns; the user
still logs in fine. Idempotent via ON CONFLICT (user_id, key) on
pai_goals — re-seeding the same starter set is a no-op (just bumps
updated_at) so a duplicate call is safe.
"""

from __future__ import annotations

import logging
import uuid

from psycopg_pool import AsyncConnectionPool

from ..db.repositories.profile import ProfileRepository
from ..db.rls import user_scoped_tx

logger = logging.getLogger(__name__)


# Verbatim port of openclaw plugin's starterGoals
# (pinai-openclaw/plugins/proactive-ai/index.ts:55).
_STARTER_GOALS: tuple[tuple[str, str, str], ...] = (
    ("career-growth", "Advance career and professional skills", "high"),
    ("stay-healthy", "Maintain consistent exercise and healthy habits", "medium"),
    ("financial-plan", "Grow savings and make smart financial decisions", "medium"),
    ("learn-and-grow", "Dedicate time to learning new skills and ideas", "medium"),
    ("relationships", "Stay connected with family and close friends", "medium"),
    ("life-balance", "Protect personal time and avoid burnout", "high"),
)


async def seed_default_goals(
    pool: AsyncConnectionPool,
    user_id: int,
) -> None:
    """Seed 6 starter goals for a freshly INSERTed user row."""
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            repo = ProfileRepository(user_id, conn)
            for key, title, priority in _STARTER_GOALS:
                await repo.upsert_goal(
                    id=f"goal_{uuid.uuid4().hex[:12]}",
                    key=key,
                    title=title,
                    priority=priority,
                )
    except Exception as e:
        logger.warning(
            "default goals: seeding failed user=%d (skipping; agent can upsert goals later): %s",
            user_id,
            e,
        )
        return
    logger.info(
        "default goals: seeded %d starter goals user=%d",
        len(_STARTER_GOALS),
        user_id,
    )
