"""Per-user pattern + intent fingerprint repository.

Owns:
  * `pai_user_pattern_pref` — (user_id, pattern_id, hit/open/dismiss
    counts, hit_rate, suppress_until)
  * `pai_user_intent_pref` — (user_id, intent, basket, ctr_7d, ctr_30d,
    last_open_at, last_dismiss_at)

Reads + writes are RLS-scoped via the standard `UserScopedRepository`
construct-inside-user_scoped_tx pattern.

Per docs/plans/2026-05-15-pattern-driven-card-generation.mdx Phase 3:
  * Each card open / dismiss event is fanned out to (a) every pattern
    that hit on the card via `pai_card_pattern_hits`, and (b) the card's
    intent. The repo provides record_open / record_dismiss helpers so the
    feedback + reward event paths only have to call one method.
  * suppress_until kicks in after N consecutive dismisses on the same
    pattern (decided by the caller). When set, `score_for` returns 0.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from pinai_db.base import UserScopedRepository

# After N dismisses with no opens, push out the pattern for this many days.
DEFAULT_SUPPRESS_AFTER_DISMISSES = 3
DEFAULT_SUPPRESS_DAYS = 7
# Recency-decay half-life when blending hit_rate into the score.
RECENCY_HALF_LIFE_DAYS = 14


def _iso(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _row_to_pattern_pref(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "patternId": row["pattern_id"],
        "hitCount": int(row.get("hit_count") or 0),
        "openCount": int(row.get("open_count") or 0),
        "dismissCount": int(row.get("dismiss_count") or 0),
        "lastHitAt": _iso(row.get("last_hit_at")),
        "suppressUntil": _iso(row.get("suppress_until")),
        "hitRate": float(row["hit_rate"]) if row.get("hit_rate") is not None else None,
        "updatedAt": _iso(row.get("updated_at")),
    }


class UserFingerprintRepository(UserScopedRepository):
    """Phase 3 read/write fingerprint repository."""

    async def get_pattern_prefs(self) -> dict[str, dict[str, Any]]:
        """Map pattern_id → fingerprint row for the current user."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM pai_user_pattern_pref WHERE user_id = %s",
                (self._user_id,),
            )
            rows = await cur.fetchall()
        out: dict[str, dict[str, Any]] = {}
        for r in rows:
            pref = _row_to_pattern_pref(r)
            if pref is None:
                continue
            out[pref["patternId"]] = pref
        return out

    async def get_pattern_pref(self, pattern_id: str) -> dict[str, Any] | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT * FROM pai_user_pattern_pref
                WHERE user_id = %s AND pattern_id = %s
                """,
                (self._user_id, pattern_id),
            )
            row = await cur.fetchone()
        return _row_to_pattern_pref(row)

    async def record_open(
        self,
        *,
        pattern_ids: list[str],
        intent: str | None = None,
        basket: str | None = None,
    ) -> None:
        """Bump open + hit counts for every pattern that hit on the card,
        plus the intent CTR. Idempotent per call (a duplicate open is
        treated as a single open by the caller's dedup, but the SQL is
        also re-entrant — increment is INSERT/UPDATE not append-only)."""
        await self._bump_patterns(pattern_ids, opened=True)
        if intent:
            await self._bump_intent(intent, basket, opened=True)

    async def record_dismiss(
        self,
        *,
        pattern_ids: list[str],
        intent: str | None = None,
        basket: str | None = None,
        suppress_after: int = DEFAULT_SUPPRESS_AFTER_DISMISSES,
        suppress_days: int = DEFAULT_SUPPRESS_DAYS,
    ) -> None:
        await self._bump_patterns(
            pattern_ids,
            opened=False,
            suppress_after=suppress_after,
            suppress_days=suppress_days,
        )
        if intent:
            await self._bump_intent(intent, basket, opened=False)

    async def score_for(
        self,
        pattern_id: str,
        *,
        base_hit_rate: float,
    ) -> float:
        """Combine global base_hit_rate with per-user fingerprint. Used
        by the matcher when ranking candidates.

        Returns 0 if the pattern is currently suppressed for this user.
        Otherwise: base × max(hit_rate, 0.1) × recency_decay(last_hit_at).
        The 0.1 floor avoids zeroing out patterns with low sample size.
        """
        pref = await self.get_pattern_pref(pattern_id)
        if pref is None:
            return base_hit_rate
        if pref.get("suppressUntil"):
            try:
                until = datetime.fromisoformat(str(pref["suppressUntil"]))
            except ValueError:
                until = None
            if until and until > datetime.now(UTC):
                return 0.0
        hit_rate = pref.get("hitRate") or 0.1
        score = base_hit_rate * max(hit_rate, 0.1)
        last_hit = pref.get("lastHitAt")
        if isinstance(last_hit, str):
            try:
                last_hit_dt = datetime.fromisoformat(last_hit)
                age_days = (datetime.now(UTC) - last_hit_dt).total_seconds() / 86400.0
                decay = 0.5 ** (age_days / RECENCY_HALF_LIFE_DAYS)
                score *= max(decay, 0.1)
            except ValueError:
                pass
        return score

    # ── internals ──────────────────────────────────────────────────────

    async def _bump_patterns(
        self,
        pattern_ids: list[str],
        *,
        opened: bool,
        suppress_after: int = DEFAULT_SUPPRESS_AFTER_DISMISSES,
        suppress_days: int = DEFAULT_SUPPRESS_DAYS,
    ) -> None:
        if not pattern_ids:
            return
        async with self._conn.cursor() as cur:
            for pid in pattern_ids:
                if opened:
                    await cur.execute(
                        """
                        INSERT INTO pai_user_pattern_pref
                          (user_id, pattern_id, hit_count, open_count,
                           dismiss_count, last_hit_at, hit_rate, updated_at)
                        VALUES (%s, %s, 1, 1, 0, NOW(),
                                1.0, NOW())
                        ON CONFLICT (user_id, pattern_id) DO UPDATE SET
                          hit_count = pai_user_pattern_pref.hit_count + 1,
                          open_count = pai_user_pattern_pref.open_count + 1,
                          last_hit_at = NOW(),
                          suppress_until = NULL,
                          hit_rate = (pai_user_pattern_pref.open_count + 1.0)
                                     / (pai_user_pattern_pref.open_count
                                        + pai_user_pattern_pref.dismiss_count + 1.0),
                          updated_at = NOW()
                        """,
                        (self._user_id, pid),
                    )
                else:
                    suppress_until = datetime.now(UTC) + timedelta(days=suppress_days)
                    await cur.execute(
                        """
                        INSERT INTO pai_user_pattern_pref
                          (user_id, pattern_id, hit_count, open_count,
                           dismiss_count, last_hit_at, hit_rate, updated_at)
                        VALUES (%s, %s, 1, 0, 1, NOW(),
                                0.0, NOW())
                        ON CONFLICT (user_id, pattern_id) DO UPDATE SET
                          hit_count = pai_user_pattern_pref.hit_count + 1,
                          dismiss_count = pai_user_pattern_pref.dismiss_count + 1,
                          last_hit_at = NOW(),
                          suppress_until = CASE
                            WHEN pai_user_pattern_pref.dismiss_count + 1 >= %s
                              AND pai_user_pattern_pref.open_count = 0
                            THEN %s::timestamptz
                            ELSE pai_user_pattern_pref.suppress_until
                          END,
                          hit_rate = (pai_user_pattern_pref.open_count + 0.0)
                                     / (pai_user_pattern_pref.open_count
                                        + pai_user_pattern_pref.dismiss_count + 1.0),
                          updated_at = NOW()
                        """,
                        (
                            self._user_id,
                            pid,
                            suppress_after,
                            suppress_until,
                        ),
                    )

    async def _bump_intent(
        self,
        intent: str,
        basket: str | None,
        *,
        opened: bool,
    ) -> None:
        bk = basket or ""
        async with self._conn.cursor() as cur:
            # Recompute ctr_7d / ctr_30d as a rolling window over
            # pai_card_reward_events would require a join — Phase 3 keeps
            # it simple: count opens and dismisses on each event and
            # update the absolute ratio. Window math is Phase 5+.
            if opened:
                await cur.execute(
                    """
                    INSERT INTO pai_user_intent_pref
                      (user_id, intent, basket, ctr_7d, ctr_30d, last_open_at, updated_at)
                    VALUES (%s, %s, %s, 1.0, 1.0, NOW(), NOW())
                    ON CONFLICT (user_id, intent, basket) DO UPDATE SET
                      ctr_7d = LEAST(1.0, COALESCE(pai_user_intent_pref.ctr_7d, 0.5) + 0.1),
                      ctr_30d = LEAST(1.0, COALESCE(pai_user_intent_pref.ctr_30d, 0.5) + 0.05),
                      last_open_at = NOW(),
                      updated_at = NOW()
                    """,
                    (self._user_id, intent, bk),
                )
            else:
                await cur.execute(
                    """
                    INSERT INTO pai_user_intent_pref
                      (user_id, intent, basket, ctr_7d, ctr_30d, last_dismiss_at, updated_at)
                    VALUES (%s, %s, %s, 0.0, 0.0, NOW(), NOW())
                    ON CONFLICT (user_id, intent, basket) DO UPDATE SET
                      ctr_7d = GREATEST(0.0, COALESCE(pai_user_intent_pref.ctr_7d, 0.5) - 0.1),
                      ctr_30d = GREATEST(0.0, COALESCE(pai_user_intent_pref.ctr_30d, 0.5) - 0.05),
                      last_dismiss_at = NOW(),
                      updated_at = NOW()
                    """,
                    (self._user_id, intent, bk),
                )

    async def patterns_for_card(self, card_id: str) -> list[str]:
        """Look up which patterns hit on a given card so the feedback path
        can fan out the open/dismiss event to fingerprint rows.
        """
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT pattern_id FROM pai_card_pattern_hits
                WHERE user_id = %s AND card_id = %s
                """,
                (self._user_id, card_id),
            )
            rows = await cur.fetchall()
        return [str(r["pattern_id"]) for r in rows if r.get("pattern_id")]
