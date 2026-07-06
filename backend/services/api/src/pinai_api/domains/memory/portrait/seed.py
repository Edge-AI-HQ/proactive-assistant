"""First-touch portrait defaults — persona baseline + starter goals.

When a brand-new users row is INSERTed by `upsert_user_by_supabase_id`,
seed defaults into the `pai_user_strings` portrait slots:
  * IDENTITY / SOUL — the default persona baseline (design §六: the user
    personalizes the persona through conversation — "make yourself more
    formal" — which needs a baseline to revise).
  * GOALS — starter goals so the agent has something to reason about
    before the user has stated any.
USER / TOOLS are deliberately NOT seeded: they hold what the agent learns
about (and from) this specific user, and at first touch there is nothing
truthful to write — build_portrait renders an explicit empty-slot note
instead. chat / evolve later refine every slot via `memory_edit`
(add/replace/remove).

Best-effort + idempotent per slot: a slot that already has content is left
alone, so a duplicate call (e.g. a re-login that re-runs onboarding) is a
no-op. A transient DB hiccup here logs and returns; the user still logs in
fine.
"""

from __future__ import annotations

import logging

from pinai_db.rls import user_scoped_tx
from psycopg_pool import AsyncConnectionPool

from .repository import EditOp, UserStringsRepository

logger = logging.getLogger(__name__)


# Default persona baseline. Kept small (per-slot char budget is 2000) and
# generic — the agent revises it per user via memory_edit.
_IDENTITY_SEED: tuple[str, ...] = (
    "Name: Pin — the user's personal AI assistant.",
    "Role: a proactive companion across the user's apps, calendar, messages, "
    "and world — remembers, anticipates, and acts.",
)

_SOUL_SEED: tuple[str, ...] = (
    "Genuinely helpful, not performatively helpful — skip filler praise, just help.",
    "Have a point of view: recommend rather than dump options; disagree when "
    "the evidence disagrees.",
    "Resourceful before asking — check memory and tools first; come back with "
    "answers, not questions.",
    "Careful with outward actions (messages, payments, anything that leaves "
    "the system); bold with inward ones (reading, organizing, learning).",
)

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

_SLOT_SEEDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("IDENTITY", _IDENTITY_SEED),
    ("SOUL", _SOUL_SEED),
    ("GOALS", _STARTER_GOALS),
)


async def seed_portrait_defaults(
    pool: AsyncConnectionPool,
    user_id: int,
) -> None:
    """Seed the IDENTITY/SOUL persona baseline + GOALS starter goals for a
    freshly INSERTed user (per-slot idempotent; USER/TOOLS stay empty by
    design)."""
    seeded: list[str] = []
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            repo = UserStringsRepository(user_id, conn)
            for slot, entries in _SLOT_SEEDS:
                content, _version = await repo.get_slot(slot)
                if content.strip():
                    # Slot already populated (re-login / agent wrote it) — leave it.
                    continue
                result = await repo.edit(
                    slot,
                    operations=[EditOp(op="add", text=e) for e in entries],
                )
                if not result.ok:
                    logger.warning(
                        "portrait defaults: %s seed rejected user=%d reason=%s",
                        slot,
                        user_id,
                        result.reason,
                    )
                    continue
                seeded.append(slot)
    except Exception as e:
        logger.warning(
            "portrait defaults: seeding failed user=%d (skipping; agent can "
            "fill the portrait later): %s",
            user_id,
            e,
        )
        return
    if seeded:
        logger.info("portrait defaults: seeded %s for user=%d", "+".join(seeded), user_id)
