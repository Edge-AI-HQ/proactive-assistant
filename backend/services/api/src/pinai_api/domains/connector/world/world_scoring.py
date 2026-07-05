"""Per-user salience scoring + world→event projection.

Called by world_ingest.run_once() after a batch of new pai_world_signals rows
lands. For every user active in the last 30 days, compute a per-user salience and
PROJECT the salience-gated signals into the L1 event stream as `world_news`
events (W6: the old pai_world_signal_user_view is gone — salience lives in the
event's structured, the agent reads world via events_search like any other
event; world_recent / world_search are retired).

Scoring formula (preferences from L1 preference events + goals from the L2 GOALS
portrait slot + recent card baskets/sources):

  topic_match    = Jaccard(signal.topics ∪ signal.regions, user_topics)
  importance     = 0.6 if signal.importance == "high" else 0.3
  recency_decay  = max(0, 1 - hours_since_published / 168)   # 1 week half-life
  salience       = clip(0, 1, 0.4 * topic_match + 0.4 * importance + 0.2 * recency_decay)

The临界 path is rule-only (no LLM): salience is objective math, projection is a
plain event_append. Re-scoring on profile changes is a future scheduled task;
salience reflects user state at ingest time (acceptable for a 30-min loop).
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any

from pinai_db.rls import service_tx, user_scoped_tx

from ...memory.events import AppendEventInput, EventsRepository, gen_event_id

logger = logging.getLogger(__name__)


# How fresh a user must be to get world_news events projected for them.
# 30 days matches Q1 = "A: all last_active_at >= 30d".
_ACTIVE_USER_DAYS = 30

# Salience floor for projecting a world signal into the L1 pai_events stream
# (doc §四/§331: world IS a normal event, gated by salience). Below this a
# signal stays only in L0 pai_world_signals + the per-user view (no longer
# agent-readable since W5 retired world_recent / world_search); at/above it the
# signal lands as a `world_news` event so it joins unified retrieval
# (events_search) + portrait distillation. 0.5 keeps the L1 stream to genuinely
# user-relevant news —
# topic-matched or high-importance-and-fresh — instead of flooding it.
_PROJECT_SALIENCE_MIN = 0.5

# Cap per user per ingest cycle (doc §196): even above the salience floor, project
# only the top-K most relevant signals — a busy news day shouldn't bury the user's
# own events under world_news. Threshold gates relevance; top-K gates volume.
_PROJECT_TOP_K = 10


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
    preference_rows: list[dict[str, Any]],
    goals_text: str | None,
    recent_card_rows: list[dict[str, Any]],
) -> set[str]:
    """Build the user's interest fingerprint as a flat token set:
    active preference events (statement + scope tokens) ∪ GOALS portrait
    entry tokens ∪ recent cards (basket + intentKey + source-id tokens).

    Preferences and goals used to live in the retired `pai_profile` /
    `pai_goals` tables; they now come from the L1 event stream
    (`event_type='preference'`) and the L2 `pai_user_strings` GOALS slot.
    The fingerprint is still just a flat token bag fed to Jaccard, so the
    source change is transparent to scoring — we tokenize the new surfaces
    the same way the old key/title tokens were tokenized.
    """
    topics: set[str] = set()

    # 1. active preference events — the statement (title) carries the
    #    interest; scope narrows it (e.g. scope='travel'). Both feed tokens,
    #    replacing the old explicit profile.preferences.topics array.
    for p in preference_rows:
        topics |= _slug_tokens(p.get("title"))
        structured = p.get("structured") or {}
        if isinstance(structured, str):
            try:
                structured = json.loads(structured)
            except json.JSONDecodeError:
                structured = {}
        if isinstance(structured, dict):
            scope = structured.get("scope")
            topics |= _slug_tokens(scope if isinstance(scope, str) else None)

    # 2. active goals — the GOALS portrait slot is §-separated markdown
    #    entries (free text). Tokenize the whole block; equivalent to the
    #    old per-goal key/title tokenization (both were fed straight into
    #    _slug_tokens).
    topics |= _slug_tokens(goals_text)

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
    _ACTIVE_USER_DAYS days. Returns count of world_news events projected
    into pai_events.

    Three-pass design:
      1. Service-role pull of (active users) and (signal payloads).
      2. Per-user RLS-scoped tx: pull profile + goals + recent cards
         (used to build user_topics), then compute salience for each
         signal and project the salience-gated ones into pai_events as
         world_news events (event_append, salience in structured).
      3. Aggregate count return.
    """
    # ── 1. service-role: list signals + active users ──
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            SELECT id, title, summary, url, provider,
                   topics, regions, importance, published_at
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
                "title": r["title"],
                "summary": r.get("summary"),
                "url": r["url"],
                "provider": r["provider"],
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
                preference_rows, goals_text, card_rows = await _fetch_user_context(conn, user_id)
                user_topics = _user_topic_set(preference_rows, goals_text, card_rows)

                events_repo = EventsRepository(user_id, conn)
                eligible: list[tuple[float, dict[str, Any]]] = []
                for sig in signal_payloads:
                    salience, _reason = compute_salience(
                        signal_topics=sig["topics"],
                        signal_regions=sig["regions"],
                        signal_importance=sig["importance"],
                        signal_published_at=sig["published_at"],
                        user_topics=user_topics,
                        now=now,
                    )
                    if salience >= _PROJECT_SALIENCE_MIN:
                        eligible.append((salience, sig))

                # Project the salience-gated signals into the L1 event stream —
                # world joins unified retrieval (events_search) + portrait
                # distillation (doc §四/§331: world IS an event, gated by salience).
                # This is now the ONLY per-user landing for world (W6: the
                # pai_world_signal_user_view is dropped, the salience lives in the
                # event's structured). Cap at top-K per user per cycle (doc §196):
                # threshold gates relevance, top-K gates volume. dedupe_key keeps it
                # idempotent — re-scoring the same signal hits the events unique
                # index and no-ops.
                eligible.sort(key=lambda x: x[0], reverse=True)
                for salience, sig in eligible[:_PROJECT_TOP_K]:
                    await events_repo.append(
                        AppendEventInput(
                            id=gen_event_id(),
                            source="world",
                            event_type="world_news",
                            occurred_at=sig["published_at"] or now,
                            dedupe_key=f"world:{sig['id']}",
                            title=sig["title"],
                            body=sig["summary"],
                            structured={
                                "provider": sig["provider"],
                                "salience": salience,
                                "topics": sig["topics"],
                                "url": sig["url"],
                                "importance": sig["importance"],
                            },
                            source_ref=sig["id"],
                            curated=False,
                        )
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
) -> tuple[list[dict[str, Any]], str | None, list[dict[str, Any]]]:
    """Pull the three context sources used to build user_topics. Single
    user_scoped_tx — RLS guarantees we only see this user's rows.

    Preferences come from active `pai_events` (event_type='preference') and
    goals from the L2 `pai_user_strings` GOALS slot; the retired `pai_profile`
    / `pai_goals` tables are gone.
    """
    cur = await conn.execute(
        """
        SELECT title, structured
        FROM pai_events
        WHERE user_id = %s
          AND event_type = 'preference'
          AND superseded_by_id IS NULL
        ORDER BY occurred_at DESC
        LIMIT 50
        """,
        (user_id,),
    )
    preference_rows = await cur.fetchall() or []

    cur = await conn.execute(
        "SELECT content FROM pai_user_strings WHERE user_id = %s AND slot = 'GOALS'",
        (user_id,),
    )
    goals_row = await cur.fetchone()
    goals_text = goals_row.get("content") if goals_row else None

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

    return preference_rows, goals_text, card_rows[:20]
