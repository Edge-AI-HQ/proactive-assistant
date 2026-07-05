"""Generation context anchor — read/reset the ONE piece of state behind the
generator's cache-stable prompt (design §4.2/§4.6, table: migration 125).

Reset has two dimensions with one owner each:

  * TIME (here, api side): should this line start over?
      no row              → fresh, anchor = now
      anchor older than 3d → max_age, anchor = now
  * SPACE (engine side, at build time): does the line still fit?
      log estimate > LOG_TOKEN_BUDGET → in-place reset while building —
      immediate, so a connector backfill flood can't blow up a single run
      the way a lagging last-usage check could. The engine returns the
      `effective_anchor` it actually built on and the dispatcher persists it.

After the tick, `store_anchor()` persists (effective anchor, real
prompt_tokens — observability only, calibrating the engine's chars/3
estimate; no decision reads it). Writes are last-writer-wins on purpose:
two overlapping runs can't corrupt anything — the context is always
rebuildable from the anchor, so the loser of the race just costs one cache
miss on the next tick.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

logger = logging.getLogger(__name__)

# Time-dimension knob (design §4.7) — deliberately a module constant, not
# settings: an architecture parameter tuned by observation, not per-env
# config. Doubles as the engine's history time bound (LOG_LOOKBACK_DAYS), so
# a log spans at most 3d history + 3d anchor age = 6 days of arrivals.
RESET_MAX_AGE_DAYS = 3


@dataclass(slots=True)
class AnchorDecision:
    anchor: datetime
    was_reset: bool
    reason: str  # "fresh" | "kept" | "max_age"


async def resolve_anchor(conn, user_id: int, *, now: datetime | None = None) -> AnchorDecision:
    """Load the user's anchor and apply the TIME reset rules. Pure read — the
    persisted value is whatever the engine reports back as effective_anchor
    after the tick."""
    moment = now or datetime.now(UTC)
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT anchor FROM pai_generation_context WHERE user_id = %s",
            (user_id,),
        )
        row = await cur.fetchone()
    if row is None:
        return AnchorDecision(anchor=moment, was_reset=True, reason="fresh")
    anchor: datetime = row["anchor"]
    if moment - anchor > timedelta(days=RESET_MAX_AGE_DAYS):
        logger.info(
            "generation anchor reset user=%d reason=max_age anchor=%s",
            user_id,
            anchor.isoformat(),
        )
        return AnchorDecision(anchor=moment, was_reset=True, reason="max_age")
    return AnchorDecision(anchor=anchor, was_reset=False, reason="kept")


async def store_anchor(conn, user_id: int, *, anchor: datetime, prompt_tokens: int | None) -> None:
    """Persist (effective anchor, last run's real prompt_tokens). Last writer
    wins; tokens are observability only."""
    await conn.execute(
        """
        INSERT INTO pai_generation_context (user_id, anchor, last_prompt_tokens, updated_at)
        VALUES (%s, %s, %s, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          anchor = EXCLUDED.anchor,
          last_prompt_tokens = EXCLUDED.last_prompt_tokens,
          updated_at = NOW()
        """,
        (user_id, anchor, prompt_tokens or 0),
    )
