"""Cache-efficient tick context for the generator (design §4.1–4.3).

Three-segment structure — "timeline 即 context, anchor 即状态":

  * arrival log  — what became known, in arrival order (`recorded_at, id`),
    chunked into FULL BLOCKS of K events. Two sub-segments:
      history  (anchor − LOOKBACK, anchor]: the arrival set before anchor is
               CLOSED (recorded_at is transaction time — later writes carry
               later stamps), so budget-truncating it from anchor backwards
               (keep the newest ≤ INITIAL_LOG_TOKEN_BUDGET) is deterministic
               and the blocks stay byte-identical across ticks.
      growth   (anchor, now]: append-only; every tick re-reads the full
               range so late-visible rows (long ingest transactions commit
               after their recorded_at) are never lost — worst case they
               land inside an already-sealed block and cost one cache miss,
               self-healing next tick.
    Superseded rows stay in — the log is immutable history; a reschedule
    shows both arrivals.
  * tail          — the not-yet-full remainder (most recent arrivals), recomputed
    every tick inside the (uncached) tick message.
  * future view   — the authoritative CURRENT upcoming schedule: occurred_at
    axis, supersede resolved, soonest-first, one line each. The log records
    how things arrived; the view says what is valid NOW.

Budget enforcement is IMMEDIATE, not last-run-usage-based: if the whole log
estimates past LOG_TOKEN_BUDGET (connector backfill flood, or ordinary
growth), the build resets IN PLACE — anchor := now, history re-truncated to
the newest INITIAL budget, growth empty — and returns the new
`effective_anchor` for the api side to store. A reset build is ≤ INITIAL
budget by construction, so one step terminates (this also kills the old
failure mode where reset didn't shrink the log at all and every tick paid a
full cache write).

Determinism is load-bearing (Manus: unstable serialization silently breaks
the cache): fixed projection field order + sort_keys JSON + compact
separators + the API's (recorded_at, id) total order + closed-set
truncation.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from ..tools import http_client

logger = logging.getLogger(__name__)

# ── behavior tunables (design §4.7) ─────────────────────────────────────────
LOG_LOOKBACK_DAYS = 3  # history time bound (low-density users: don't reach back months)
INITIAL_LOG_TOKEN_BUDGET = 30_000  # history segment cap — the post-reset starting size
LOG_TOKEN_BUDGET = 80_000  # whole-log cap (estimated); past it → in-place reset.
#   80k estimated ≈ ≤120k real prompt after system/portrait + in-run tool
#   growth — safe inside a 128k-window model. NOT a knob to raise casually.
FUTURE_VIEW_DAYS = 7
FUTURE_VIEW_LIMIT = 30
BLOCK_SIZE_EVENTS = 50
_BODY_CAP = 280

# Transport guards, not behavior: sized so the token budgets bind first
# (~25 tokens is the smallest realistic projection, so 1500 rows ≥ 30k budget
# and 5000 growth rows would estimate far past 80k → in-place reset anyway).
# If one ever clips, truncation still yields a deterministic, correct log.
_HISTORY_FETCH_LIMIT = 1500
_GROWTH_FETCH_LIMIT = 5000


def _estimate_tokens(text: str) -> int:
    """Deterministic cheap estimate (chars/3). Biased HIGH for English JSON
    (~3.5-4 chars/token), i.e. the real prompt runs *smaller* than budgeted —
    errors land on the safe side. Real usage is logged per tick for
    calibration."""
    return len(text) // 3


def _items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        value = payload.get("items")
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


async def _safe_get(path: str, **params: Any) -> Any:
    try:
        return await http_client.get(path, **params)
    except Exception as e:  # noqa: BLE001
        logger.warning("generation context GET failed path=%s error=%s", path, e)
        return {"_error": f"{type(e).__name__}: {e}"}


def _log_event(e: dict[str, Any]) -> dict[str, Any]:
    """Narrow, deterministic projection of one arrival for the log.

    Keeps the citation toolkit and the `supersedes` pointer (append-only log
    can't delete the old version — the pointer is how the model knows a later
    arrival REPLACES an earlier one). agent_decision arrivals additionally
    keep kind/card_id/related_event_ids — the agent's own past proposals ARE
    the dedupe basis (no separate recent-proposals pull; note this memory is
    bounded: a reset truncates old proposals with everything else, so a rare
    re-proposal after reset is accepted by design). The full structured
    payload stays out (a whole connector payload once blew past the
    summarization threshold and provisioned a Daytona sandbox for nothing)."""
    raw_structured = e.get("structured")
    structured = raw_structured if isinstance(raw_structured, dict) else {}
    body = e.get("body")
    projected: dict[str, Any] = {
        "id": e.get("id"),
        "eventType": e.get("eventType"),
        "source": e.get("source"),
        "toolkit": structured.get("toolkit"),
        "occurredAt": e.get("occurredAt"),
        "endAt": e.get("endAt"),
        "title": e.get("title"),
        "body": body[:_BODY_CAP] if isinstance(body, str) else None,
        "supersedes": e.get("supersedesId"),
    }
    if e.get("eventType") == "agent_decision":
        projected["kind"] = structured.get("kind")
        projected["cardId"] = structured.get("card_id")
        projected["relatedEventIds"] = structured.get("related_event_ids")
    return {k: v for k, v in projected.items() if v is not None}


def _render_block(events: list[dict[str, Any]]) -> str:
    """One log block → deterministic JSON text (sort_keys + compact — JSON key
    order is part of the byte-identity contract)."""
    return json.dumps(events, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _event_tokens(projected: dict[str, Any]) -> int:
    return _estimate_tokens(_render_block([projected]))


def truncate_history(
    projected: list[dict[str, Any]],
    *,
    budget: int = INITIAL_LOG_TOKEN_BUDGET,
) -> list[dict[str, Any]]:
    """Keep the largest SUFFIX (newest arrivals) whose estimated tokens stay
    within budget — the first event that would overflow is excluded.

    Deterministic on a closed set (fixed projection + fixed estimator + fixed
    rule), which is what keeps the history blocks byte-identical across
    ticks."""
    kept: list[dict[str, Any]] = []
    total = 0
    for event in reversed(projected):
        cost = _event_tokens(event)
        if total + cost > budget:
            break
        kept.append(event)
        total += cost
    kept.reverse()
    return kept


def chunk_log(
    projected: list[dict[str, Any]],
    *,
    block_size: int = BLOCK_SIZE_EVENTS,
) -> tuple[list[str], list[dict[str, Any]]]:
    """Split the arrival-ordered projections into (full blocks, tail).

    Full blocks are rendered text (cache-stable); the tail (< block_size most
    recent arrivals) rides in the tick message and is re-sent every tick —
    the price of keeping full blocks immutable."""
    full_count = (len(projected) // block_size) * block_size
    blocks = [
        _render_block(projected[i : i + block_size]) for i in range(0, full_count, block_size)
    ]
    return blocks, projected[full_count:]


def _view_line(e: dict[str, Any]) -> str:
    """One upcoming item, one line: time span + type + title + id anchor."""
    when = str(e.get("occurredAt") or "?")
    end = e.get("endAt")
    span = f"{when} → {end}" if end else when
    return f"- {span} [{e.get('eventType')}] {e.get('title')} (id={e.get('id')})"


async def _fetch_log_segments(
    *, anchor: datetime, now: datetime
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(history projections, growth projections), both in arrival order.

    History wants the NEWEST rows of its window (newestFirst — a plain ASC
    limit would keep the oldest and discard exactly the rows that matter);
    growth re-reads its full range every tick."""
    log_since = anchor - timedelta(days=LOG_LOOKBACK_DAYS)
    history_payload, growth_payload = await asyncio.gather(
        _safe_get(
            "/api/agent/events/search",
            recordedSince=log_since.isoformat(),
            recordedUntil=anchor.isoformat(),
            arrivalsLimit=_HISTORY_FETCH_LIMIT,
            newestFirst="true",
        ),
        _safe_get(
            "/api/agent/events/search",
            recordedSince=anchor.isoformat(),
            recordedUntil=now.isoformat(),
            arrivalsLimit=_GROWTH_FETCH_LIMIT,
        ),
    )
    history = [_log_event(e) for e in _items(history_payload)]
    growth = [_log_event(e) for e in _items(growth_payload)]
    return history, growth


async def build_tick_context(
    *,
    anchor: datetime,
    now: datetime,
) -> dict[str, Any]:
    """Everything one tick needs, rebuilt deterministically from (anchor, now):
    cache-stable full log blocks + the volatile tail + the future view +
    `effective_anchor` (== anchor normally; == now after an in-place reset —
    the caller must persist it)."""
    view_until = now + timedelta(days=FUTURE_VIEW_DAYS)
    (history, growth), future_payload = await asyncio.gather(
        _fetch_log_segments(anchor=anchor, now=now),
        _safe_get(
            "/api/agent/events/search",
            since=now.isoformat(),
            until=view_until.isoformat(),
            status="active",
            limit=100,
        ),
    )
    history = truncate_history(history)
    log = history + growth

    effective_anchor = anchor
    was_reset = False
    log_tokens = _estimate_tokens(_render_block(log)) if log else 0
    if log_tokens > LOG_TOKEN_BUDGET:
        # In-place reset (design §4.2): the log outgrew its budget — restart
        # the line from now. Re-FETCH (not just re-slice): the growth guard
        # may have clipped the newest rows, and a fresh newestFirst query is
        # exactly what next tick's history segment will see, so the cache
        # entry this reset build writes gets hit immediately.
        was_reset = True
        effective_anchor = now
        history, growth = await _fetch_log_segments(anchor=now, now=now)
        history = truncate_history(history)
        log = history + growth  # growth spans (now, now] — empty by construction
        log_tokens = _estimate_tokens(_render_block(log)) if log else 0
        # ≤ INITIAL budget < LOG budget by construction — no second reset.

    log_blocks, tail_events = chunk_log(log)

    # The API returns occurred_at DESC (farthest first) — re-sort soonest-first
    # and cap; the view must read as "what's next".
    upcoming = sorted(_items(future_payload), key=lambda e: str(e.get("occurredAt") or ""))[
        :FUTURE_VIEW_LIMIT
    ]
    future_view = [_view_line(e) for e in upcoming]

    logger.info(
        "tick context built anchor=%s effective=%s reset=%s history=%d growth=%d "
        "log_tokens~%d blocks=%d tail=%d upcoming=%d",
        anchor.isoformat(),
        effective_anchor.isoformat(),
        was_reset,
        len(history),
        len(growth),
        log_tokens,
        len(log_blocks),
        len(tail_events),
        len(future_view),
    )
    return {
        "log_blocks": log_blocks,
        "tail_events": tail_events,
        "future_view": future_view,
        "effective_anchor": effective_anchor,
        "stats": {
            "history": len(history),
            "growth": len(growth),
            "log_tokens_estimate": log_tokens,
            "was_reset": was_reset,
            "full_blocks": len(log_blocks),
            "tail": len(tail_events),
            "upcoming": len(future_view),
        },
    }


def default_anchor(now: datetime | None = None) -> datetime:
    """A fresh anchor (reset semantics): the log restarts from now."""
    return now or datetime.now(UTC)
