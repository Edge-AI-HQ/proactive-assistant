"""Per-user salience scoring for world signals.

Called by world_ingest.run_once() after a batch of new pai_world_signals
rows lands. For every user with last_active_at within the last 30 days,
INSERT a pai_world_signal_user_view row with a precomputed salience
(status='open' so the next /api/agent/world/recent call surfaces it).

Scoring formula (matches the user-confirmed Q2 = "D: profile preferences
+ active goal keys + recent card baskets/sources" union):

  topic_match    = Jaccard(signal.topics ∪ signal.regions, user_topics)
  importance     = 0.6 if signal.importance == "high" else 0.3
  recency_decay  = max(0, 1 - hours_since_published / 168)   # 1 week half-life

  salience       = clip(0, 1, 0.4 * topic_match + 0.4 * importance + 0.2 * recency_decay)

  scored_reason  = brief audit string ("topics=[...] match=[...]")

Why pre-compute (vs the old plugin's runtime scoring):
  * Cheap reads: /api/agent/world/recent is hot-path during generator
    phase 1 — no per-call Jaccard math needed.
  * RLS-natural: each pai_world_signal_user_view row already user-scoped.
  * Re-scoring on profile changes is a future scheduled task, not part
    of this MVP. Salience reflects user state at ingest time; changing
    your profile only impacts cards from the NEXT ingest cycle. That's
    acceptable for a 30-min loop.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any

from pinai_db.rls import service_tx, user_scoped_tx

from .world_signals import WorldSignalsRepository

logger = logging.getLogger(__name__)


# How fresh a user must be to receive new world-signal user_view rows.
# 30 days matches Q1 = "A: all last_active_at >= 30d".
_ACTIVE_USER_DAYS = 30


# ── topic extraction ───────────────────────────────────────────────


_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _slug_tokens(s: str | None) -> set[str]:
    """Lowercase + alphanumeric tokenize. Used to break 'sub3-marathon'
    into {'sub3', 'marathon'} for goal_key matching. Drops 1-char tokens
    (noise) and a small stopword set."""
    if not s:
        return set()
    raw = _TOKEN_RE.findall(s.lower())
    stop = {"the", "and", "a", "an", "of", "to", "for", "by", "in", "on", "at", "is", "be"}
    return {t for t in raw if len(t) >= 2 and t not in stop}


def _user_topic_set(
    profile_row: dict[str, Any] | None,
    goal_rows: list[dict[str, Any]],
    recent_card_rows: list[dict[str, Any]],
) -> set[str]:
    """Build the user's interest fingerprint as a flat token set:
    profile.preferences.topics ∪ active_goals.key tokens ∪
    recent cards (basket + intentKey + source-id tokens)
    """
    topics: set[str] = set()

    # 1. profile.preferences.topics (an explicit array if present)
    if profile_row:
        prefs = profile_row.get("preferences") or {}
        if isinstance(prefs, str):
            try:
                prefs = json.loads(prefs)
            except json.JSONDecodeError:
                prefs = {}
        if isinstance(prefs, dict):
            t = prefs.get("topics")
            if isinstance(t, list):
                for x in t:
                    if isinstance(x, str):
                        topics |= _slug_tokens(x)

    # 2. active goal keys — kebab → tokens (e.g. "sub3-marathon" → {sub3, marathon}).
    for g in goal_rows:
        topics |= _slug_tokens(g.get("key"))
        topics |= _slug_tokens(g.get("title"))

    # 3. recent cards — basket tokens + intent_key tokens + a glance at
    #    sources[] strings (covers e.g. confirmed cards on "OpenAI" boosting
    #    OpenAI-related world signals).
    for c in recent_card_rows:
        topics |= _slug_tokens(c.get("goalBasket") or c.get("goal_basket"))
        topics |= _slug_tokens(c.get("intentKey") or c.get("intent_key"))
        srcs = c.get("sources") or []
        if isinstance(srcs, str):
            try:
                srcs = json.loads(srcs)
            except json.JSONDecodeError:
                srcs = []
        for s in srcs[:3]:  # bound contribution from any single card
            topics |= _slug_tokens(s if isinstance(s, str) else None)

    return topics


# ── core formula ───────────────────────────────────────────────────


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def compute_salience(
    *,
    signal_topics: list[str],
    signal_regions: list[str],
    signal_importance: str | None,
    signal_published_at: datetime | None,
    user_topics: set[str],
    now: datetime | None = None,
) -> tuple[float, str]:
    """Return (salience in [0,1], scored_reason audit string).

    Pure function — testable without a DB. The audit reason includes the
    matched tokens so downstream debugging shows WHY a signal scored
    high or low.
    """
    sig_terms: set[str] = set()
    for x in (signal_topics or []) + (signal_regions or []):
        if isinstance(x, str):
            sig_terms |= _slug_tokens(x)
    matched = sig_terms & user_topics

    topic_match = _jaccard(sig_terms, user_topics)
    importance_boost = 0.6 if (signal_importance or "").lower() == "high" else 0.3
    if signal_published_at is None:
        recency = 0.0
    else:
        ref = now or datetime.now(UTC)
        # Tolerate naive datetimes by treating them as UTC.
        pub = (
            signal_published_at
            if signal_published_at.tzinfo
            else signal_published_at.replace(tzinfo=UTC)
        )
        hours = max(0.0, (ref - pub).total_seconds() / 3600.0)
        recency = max(0.0, 1.0 - hours / 168.0)

    salience = 0.4 * topic_match + 0.4 * importance_boost + 0.2 * recency
    salience = max(0.0, min(1.0, salience))
    matched_preview = sorted(matched)[:6]
    reason = (
        f"topic_match={topic_match:.2f} matched={matched_preview} "
        f"importance={signal_importance or 'medium'} recency={recency:.2f}"
    )
    return salience, reason


# ── batch scorer driven from the ingester ──────────────────────────


async def score_for_active_users(pool, *, world_signal_ids: list[str]) -> int:
    """Score `world_signal_ids` for every user active in the last
    _ACTIVE_USER_DAYS days. Returns count of (user, signal) rows
    upserted into pai_world_signal_user_view.

    Three-pass design:
      1. Service-role pull of (active users) and (signal payloads).
      2. Per-user RLS-scoped tx: pull profile + goals + recent cards
         (used to build user_topics), then compute salience for each
         signal and call repo.score(...) which UPSERTs the view row.
      3. Aggregate count return.
    """
    # ── 1. service-role: list signals + active users ──
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            SELECT id, topics, regions, importance, published_at
            FROM pai_world_signals
            WHERE id = ANY(%s::text[])
            """,
            (world_signal_ids,),
        )
        signal_rows = await cur.fetchall()

        cur = await conn.execute(
            """
            SELECT id FROM users
            WHERE last_active_at IS NULL
               OR last_active_at >= NOW() - (%s || ' days')::interval
            """,
            (str(_ACTIVE_USER_DAYS),),
        )
        active_user_rows = await cur.fetchall()

    if not signal_rows or not active_user_rows:
        return 0

    # Materialize signals into pure-Python tuples — saves us from
    # repeating JSON load + the same mapping per user.
    signal_payloads: list[dict[str, Any]] = []
    for r in signal_rows:
        topics_raw = r.get("topics")
        regions_raw = r.get("regions")
        topics = _coerce_list(topics_raw)
        regions = _coerce_list(regions_raw)
        signal_payloads.append(
            {
                "id": r["id"],
                "topics": topics,
                "regions": regions,
                "importance": r.get("importance"),
                "published_at": r.get("published_at"),
            }
        )

    written = 0
    now = datetime.now(UTC)

    # ── 2. per-user RLS tx ──
    for user_row in active_user_rows:
        user_id = int(user_row["id"])
        try:
            async with user_scoped_tx(pool, user_id) as conn:
                profile_row, goal_rows, card_rows = await _fetch_user_context(conn, user_id)
                user_topics = _user_topic_set(profile_row, goal_rows, card_rows)

                repo = WorldSignalsRepository(user_id, conn)
                for sig in signal_payloads:
                    salience, reason = compute_salience(
                        signal_topics=sig["topics"],
                        signal_regions=sig["regions"],
                        signal_importance=sig["importance"],
                        signal_published_at=sig["published_at"],
                        user_topics=user_topics,
                        now=now,
                    )
                    await repo.score(
                        world_signal_id=sig["id"],
                        salience=salience,
                        scored_reason=reason,
                        status="open",
                    )
                    written += 1
        except Exception:
            logger.exception(
                "world.scoring failed for user=%d (skipping; other users continue)",
                user_id,
            )
            continue

    return written


def _coerce_list(v: Any) -> list[str]:
    """psycopg may surface JSONB as a Python list already, or as a JSON
    string depending on the cursor row factory."""
    if v is None:
        return []
    if isinstance(v, list):
        return [x for x in v if isinstance(x, str)]
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
        except json.JSONDecodeError:
            return []
        return [x for x in parsed if isinstance(x, str)] if isinstance(parsed, list) else []
    return []


async def _fetch_user_context(
    conn, user_id: int
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], list[dict[str, Any]]]:
    """Pull the three context sources used to build user_topics. Single
    user_scoped_tx — RLS guarantees we only see this user's rows."""
    cur = await conn.execute(
        "SELECT preferences FROM pai_profile WHERE user_id = %s",
        (user_id,),
    )
    profile_row = await cur.fetchone()

    cur = await conn.execute(
        "SELECT key, title FROM pai_goals WHERE user_id = %s AND status = 'active' LIMIT 50",
        (user_id,),
    )
    goal_rows = await cur.fetchall() or []

    # Recent cards: pull last 20 cards from pai_pipeline_runs.final_cards.
    # That JSONB column holds a list of card dicts (structure assembled
    # by the generator's run-finalize). We extract intent_key + basket
    # + sources for the topic fingerprint.
    cur = await conn.execute(
        """
        SELECT final_cards
        FROM pai_pipeline_runs
        WHERE user_id = %s AND status = 'completed' AND final_cards IS NOT NULL
        ORDER BY started_at DESC LIMIT 5
        """,
        (user_id,),
    )
    run_rows = await cur.fetchall() or []
    card_rows: list[dict[str, Any]] = []
    for r in run_rows:
        cards = r.get("final_cards")
        if isinstance(cards, str):
            try:
                cards = json.loads(cards)
            except json.JSONDecodeError:
                cards = []
        if isinstance(cards, list):
            card_rows.extend(c for c in cards if isinstance(c, dict))
            if len(card_rows) >= 20:
                break

    return profile_row, goal_rows, card_rows[:20]
