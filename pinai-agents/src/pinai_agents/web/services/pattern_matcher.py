"""Pattern matcher — Python DSL evaluator that runs in the WEB process.

Per docs/plans/2026-05-15-pattern-driven-card-generation.mdx:
  * Matching must NOT use an LLM (cost-bounded, sub-100ms for 100+ patterns).
  * Matching lives in the web process, never the chat process — chat receives
    matched_patterns via the generate payload so it never reads the pattern DB
    directly (trust boundary).

Phase 2 status:
  * Coarse op evaluators below cover the structural shape of every op in
    `docs/data/patterns.yaml` (115 distinct ops). Most ops fall into three
    generic families — numeric_threshold, presence_check, recency_check —
    so the evaluator uses op-name suffix conventions to route to the right
    family. Pattern-specific evaluators can override per-op behavior as
    signal sources land.
  * Signal sources that don't exist yet evaluate to "no data" and the
    op short-circuits to False, NOT to True (a missing signal must never
    trigger a card).
  * Per-user fingerprint scoring (user_fit_score) lives in Phase 3 — Phase 2
    sets it to None and combined_score = base_hit_rate.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from ..db.repositories.patterns import PatternsRepository
from ..db.repositories.user_fingerprint import UserFingerprintRepository

logger = logging.getLogger(__name__)


# Phase1 signal payload — kept loose (dict[str, Any]) for now; the schema
# is owned by phase1 collector in chat/agents/data_collector.py and is
# still evolving (memory, signals, calendar, gmail, gps, world, etc.).
Phase1Data = dict[str, Any]


@dataclass(slots=True)
class MatchedPattern:
    pattern_id: str
    category: str
    intent: str
    abstract: str
    human_insight: str
    card_skeleton: dict[str, Any]
    subtype: str | None
    evidence: dict[str, Any]
    base_hit_rate: float
    user_fit_score: float | None = None
    combined_score: float | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "patternId": self.pattern_id,
            "category": self.category,
            "intent": self.intent,
            "abstract": self.abstract,
            "humanInsight": self.human_insight,
            "cardSkeleton": self.card_skeleton,
            "subtype": self.subtype,
            "evidence": self.evidence,
            "baseHitRate": self.base_hit_rate,
            "userFitScore": self.user_fit_score,
            "combinedScore": self.combined_score,
        }


# ── op evaluators ────────────────────────────────────────────────────────
#
# Each evaluator takes the trigger condition dict (a single item from
# pattern.trigger_dsl) plus the Phase1 payload, and returns either:
#   * (True, evidence_dict)  — the condition is satisfied
#   * (False, {})            — the condition is not satisfied (or the
#                              underlying signal is missing)
#
# Adding signal-source-specific evaluators is a routine extension; until
# then the generic family heuristics in `evaluate_condition` keep the
# matcher running without per-op stubs.


def _get_path(data: dict[str, Any], dotted: str) -> Any:
    cur: Any = data
    for part in dotted.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
        if cur is None:
            return None
    return cur


def _numeric(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def _path(cond: dict[str, Any]) -> str | None:
    """Source path inside the phase1 payload. seed YAML uses `source`,
    older planning docs use `field` — we accept either."""
    val = cond.get("source") or cond.get("field")
    return val if isinstance(val, str) and val else None


def _threshold(cond: dict[str, Any], *keys: str) -> float | None:
    """Read the first numeric arg present. seed YAML uses many different
    arg names depending on the op (threshold / threshold_min / max /
    max_hours / days / days_gte / count / ratio_gte / etc.)."""
    for key in keys:
        if key in cond:
            v = _numeric(cond[key])
            if v is not None:
                return v
    return None


def _op_gte(cond: dict[str, Any], data: Phase1Data) -> tuple[bool, dict[str, Any]]:
    field_path = _path(cond)
    if field_path is None:
        return False, {}
    actual = _numeric(_get_path(data, field_path))
    threshold = _threshold(cond, "value", "threshold", "threshold_min", "ratio_gte")
    if actual is None or threshold is None:
        return False, {}
    if actual >= threshold:
        return True, {"field": field_path, "value": actual, "threshold": threshold}
    return False, {}


def _op_within_days(cond: dict[str, Any], data: Phase1Data) -> tuple[bool, dict[str, Any]]:
    field_path = _path(cond)
    if field_path is None:
        return False, {}
    when = _datetime(_get_path(data, field_path))
    if when is None:
        return False, {}
    max_days = _threshold(cond, "max", "max_days", "days", "within", "window_days")
    if max_days is None:
        return False, {}
    now = datetime.now(UTC)
    delta = (when - now).total_seconds() / 86400.0
    if 0 <= delta <= max_days:
        return True, {"field": field_path, "in_days": round(delta, 2)}
    return False, {}


def _op_within_hours(cond: dict[str, Any], data: Phase1Data) -> tuple[bool, dict[str, Any]]:
    field_path = _path(cond)
    if field_path is None:
        return False, {}
    # Two shapes: (a) the source is a single timestamp; or
    # (b) the source is a list of events and any one within N hours fires.
    raw = _get_path(data, field_path)
    hours = _threshold(cond, "hours", "max_hours", "within")
    if hours is None:
        return False, {}
    subtype = cond.get("subtype") if isinstance(cond.get("subtype"), str) else None
    now = datetime.now(UTC)

    # (b) list of events
    if isinstance(raw, dict) and isinstance(raw.get("events"), list):
        events: list[Any] = raw["events"]
    elif isinstance(raw, list):
        events = raw
    else:
        events = []

    if events:
        for ev in events:
            if not isinstance(ev, dict):
                continue
            if subtype and ev.get("subtype") != subtype:
                continue
            when = _datetime(ev.get("start") or ev.get("start_at") or ev.get("at"))
            if when is None:
                continue
            delta = (when - now).total_seconds() / 3600.0
            if 0 <= delta <= hours:
                return True, {
                    "field": field_path,
                    "event": ev.get("id") or ev.get("title"),
                    "subtype": subtype,
                    "in_hours": round(delta, 2),
                }
        return False, {}

    # (a) single timestamp source
    when = _datetime(raw)
    if when is None:
        return False, {}
    delta = (when - now).total_seconds() / 3600.0
    if 0 <= delta <= hours:
        return True, {"field": field_path, "in_hours": round(delta, 2)}
    return False, {}


def _op_age_gte(cond: dict[str, Any], data: Phase1Data) -> tuple[bool, dict[str, Any]]:
    field_path = _path(cond)
    if field_path is None:
        return False, {}
    when = _datetime(_get_path(data, field_path))
    if when is None:
        return False, {}
    min_days = _threshold(cond, "min_days", "days", "days_gte", "dormant_days_gte")
    if min_days is None:
        return False, {}
    now = datetime.now(UTC)
    age_days = (now - when).total_seconds() / 86400.0
    if age_days >= min_days:
        return True, {"field": field_path, "age_days": round(age_days, 2)}
    return False, {}


def _op_count_gte(cond: dict[str, Any], data: Phase1Data) -> tuple[bool, dict[str, Any]]:
    field_path = _path(cond)
    if field_path is None:
        return False, {}
    container = _get_path(data, field_path)
    count = len(container) if isinstance(container, list) else None
    threshold = _threshold(cond, "min", "threshold", "value", "count", "count_gte")
    if count is None or threshold is None:
        return False, {}
    if count >= threshold:
        return True, {"field": field_path, "count": count, "threshold": threshold}
    return False, {}


def _op_not_in(cond: dict[str, Any], data: Phase1Data) -> tuple[bool, dict[str, Any]]:
    field_path = cond.get("field")
    source_path = cond.get("source")
    if not isinstance(field_path, str) or not isinstance(source_path, str):
        return False, {}
    target = _get_path(data, field_path)
    collection = _get_path(data, source_path)
    if target is None or not isinstance(collection, list | set):
        return False, {}
    if target not in collection:
        return True, {"field": field_path, "value": target, "not_in": source_path}
    return False, {}


# ── Op-specific evaluators for the most common cold-start patterns ─────
#
# These bind to the exact op names seen in patterns.yaml so the generic
# suffix routing below doesn't need to guess. Add more here as the
# web-side phase1 collector grows to source the underlying signals.

def _op_event_in_next_hours(
    cond: dict[str, Any], data: Phase1Data,
) -> tuple[bool, dict[str, Any]]:
    """Used by preparation_gap_*, time_buffer_*, etc.
    Re-uses the list-of-events branch of _op_within_hours."""
    return _op_within_hours(cond, data)


def _op_unresponded_to_vip(
    cond: dict[str, Any], data: Phase1Data,
) -> tuple[bool, dict[str, Any]]:
    """`forgotten_vip_email` style — looks at gmail.derived.unresponded_to_vip
    which is a list of {thread_id, days_open}. Fires when any thread is
    older than days_gte."""
    field_path = _path(cond) or "gmail"
    raw = _get_path(data, field_path)
    days_gte = _threshold(cond, "days_gte", "days")
    if days_gte is None:
        return False, {}
    # Conventional shape: phase1.gmail.unresponded_to_vip = [{thread_id, days_open}, ...]
    if isinstance(raw, dict):
        candidates = raw.get("unresponded_to_vip")
    elif isinstance(raw, list):
        candidates = raw
    else:
        candidates = None
    if not isinstance(candidates, list):
        return False, {}
    for item in candidates:
        if not isinstance(item, dict):
            continue
        age = _numeric(item.get("days_open") or item.get("age_days"))
        if age is not None and age >= days_gte:
            return True, {
                "thread_id": item.get("thread_id"),
                "days_open": age,
                "days_gte": days_gte,
            }
    return False, {}


def _op_title_match(
    cond: dict[str, Any], data: Phase1Data,
) -> tuple[bool, dict[str, Any]]:
    """`preparation_gap_interview` / `preparation_gap_presentation` style —
    scan calendar.events[].title for any of `keywords`. Case-insensitive."""
    keywords = cond.get("keywords")
    if not isinstance(keywords, list) or not keywords:
        return False, {}
    field_path = _path(cond) or "calendar"
    raw = _get_path(data, field_path)
    if isinstance(raw, dict) and isinstance(raw.get("events"), list):
        events = raw["events"]
    elif isinstance(raw, list):
        events = raw
    else:
        return False, {}
    lowered = [str(k).lower() for k in keywords if isinstance(k, str)]
    for ev in events:
        if not isinstance(ev, dict):
            continue
        title = str(ev.get("title") or "").lower()
        if not title:
            continue
        hit = next((k for k in lowered if k in title), None)
        if hit:
            return True, {"keyword": hit, "event": ev.get("id") or ev.get("title")}
    return False, {}


def _op_no_doc_attachment(
    cond: dict[str, Any], data: Phase1Data,
) -> tuple[bool, dict[str, Any]]:
    """`preparation_gap_meeting` — true when at least one event has no
    document attached (`doc_attachments` empty / missing). Pairs with an
    `event_in_next_hours` condition to scope to imminent meetings."""
    field_path = _path(cond) or "calendar.event"
    raw = _get_path(data, field_path)
    if isinstance(raw, dict) and isinstance(raw.get("events"), list):
        events = raw["events"]
    elif isinstance(raw, list):
        events = raw
    elif isinstance(raw, dict):
        # Single event shape
        events = [raw]
    else:
        return False, {}
    for ev in events:
        if not isinstance(ev, dict):
            continue
        attachments = ev.get("doc_attachments") or ev.get("attachments")
        if not isinstance(attachments, list) or not attachments:
            return True, {"event": ev.get("id") or ev.get("title")}
    return False, {}


def _op_back_to_back_events(
    cond: dict[str, Any], data: Phase1Data,
) -> tuple[bool, dict[str, Any]]:
    """`time_buffer_multi_event_squeeze` — N events whose adjacent gaps
    are all <= gap_min_lte minutes. count_gte = number of stacked events."""
    field_path = _path(cond) or "calendar"
    raw = _get_path(data, field_path)
    if isinstance(raw, dict) and isinstance(raw.get("events"), list):
        events = raw["events"]
    elif isinstance(raw, list):
        events = raw
    else:
        return False, {}
    gap_lte = _threshold(cond, "gap_min_lte", "gap_min", "max_gap_min")
    needed_count = int(_threshold(cond, "count_gte", "count", "min_count") or 3)
    if gap_lte is None:
        return False, {}
    parsed: list[tuple[datetime, datetime, Any]] = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        start = _datetime(ev.get("start") or ev.get("start_at"))
        end = _datetime(ev.get("end") or ev.get("end_at")) or start
        if start is None or end is None:
            continue
        parsed.append((start, end, ev))
    parsed.sort(key=lambda t: t[0])
    streak = 1
    for prev, nxt in zip(parsed, parsed[1:], strict=False):
        gap_min = (nxt[0] - prev[1]).total_seconds() / 60.0
        if gap_min <= gap_lte:
            streak += 1
            if streak >= needed_count:
                return True, {
                    "streak": streak,
                    "gap_min_lte": gap_lte,
                }
        else:
            streak = 1
    return False, {}


def _op_weather_disruption(
    cond: dict[str, Any], data: Phase1Data,
) -> tuple[bool, dict[str, Any]]:
    """`time_buffer_weather_delay` style — fires when phase1.world.weather
    reports a disruption level at or above the requested threshold."""
    field_path = _path(cond) or "world"
    raw = _get_path(data, field_path)
    weather = None
    if isinstance(raw, dict):
        weather = raw.get("weather") if isinstance(raw.get("weather"), dict) else raw
    if not isinstance(weather, dict):
        return False, {}
    requested = str(cond.get("level") or "gte_moderate")
    actual = str(weather.get("disruption_level") or weather.get("level") or "")
    if not actual:
        return False, {}
    rank = {"none": 0, "low": 1, "moderate": 2, "high": 3, "severe": 4}
    req = requested.removeprefix("gte_")
    if rank.get(actual, 0) >= rank.get(req, 99):
        return True, {"level": actual, "required": requested}
    return False, {}


def _op_planned_intent_exists(
    cond: dict[str, Any], data: Phase1Data,
) -> tuple[bool, dict[str, Any]]:
    """Fires when phase1.feedback.intent_state lists a confirmed
    intent matching `subtype` (or any intent_key supplied via `keyword`)."""
    field_path = _path(cond) or "feedback"
    raw = _get_path(data, field_path)
    if not isinstance(raw, dict):
        return False, {}
    intents = raw.get("intent_state") or raw.get("intents")
    if not isinstance(intents, list):
        return False, {}
    needle = (cond.get("subtype") or cond.get("keyword") or "").lower()
    for item in intents:
        if not isinstance(item, dict):
            continue
        if needle and needle not in str(item.get("intent") or "").lower():
            continue
        if item.get("confirm_count_30d", 0) > 0 or item.get("status") == "active":
            return True, {"intent": item.get("intent")}
    return False, {}


def _op_birthday_within_days(
    cond: dict[str, Any], data: Phase1Data,
) -> tuple[bool, dict[str, Any]]:
    """`forgotten_birthday_approaching` — scan memory.recurring_obligations
    for entries with type=birthday and a date within `days`."""
    days = _threshold(cond, "days", "within")
    if days is None:
        return False, {}
    field_path = _path(cond) or "memory"
    raw = _get_path(data, field_path)
    candidates: list[Any] = []
    if isinstance(raw, dict):
        rec = raw.get("recurring_obligations")
        if isinstance(rec, list):
            candidates = rec
        elif isinstance(raw.get("birthdays"), list):
            candidates = raw["birthdays"]
    elif isinstance(raw, list):
        candidates = raw
    now = datetime.now(UTC)
    for item in candidates:
        if not isinstance(item, dict):
            continue
        if item.get("type") not in (None, "birthday"):
            continue
        when = _datetime(item.get("next_occurrence") or item.get("date"))
        if when is None:
            continue
        delta = (when - now).total_seconds() / 86400.0
        if 0 <= delta <= days:
            return True, {
                "contact": item.get("name") or item.get("contact"),
                "in_days": round(delta, 2),
            }
    return False, {}


# Op-name → evaluator. Specific names take precedence over the generic
# family fallback in `evaluate_condition`.
_SPECIFIC_OP_EVALUATORS = {
    "gte": _op_gte,
    "not_in": _op_not_in,
    "event_in_next_hours": _op_event_in_next_hours,
    "next_event_exists": _op_event_in_next_hours,
    "pickup_event_in_next_hours": _op_event_in_next_hours,
    "unresponded_to_vip": _op_unresponded_to_vip,
    "birthday_within_days": _op_birthday_within_days,
    "anniversary_within_days": _op_birthday_within_days,
    "title_match": _op_title_match,
    "no_doc_attachment": _op_no_doc_attachment,
    "back_to_back_events": _op_back_to_back_events,
    "weather_disruption": _op_weather_disruption,
    "planned_intent_exists": _op_planned_intent_exists,
}


_FAMILY_SUFFIXES = (
    ("_within_days", _op_within_days),
    ("_within_hours", _op_within_hours),
    ("_in_next_days", _op_within_days),
    ("_in_next_hours", _op_within_hours),
    ("_age_gte", _op_age_gte),
    ("_count_gte", _op_count_gte),
    ("_gte", _op_gte),
)


def evaluate_condition(
    cond: dict[str, Any], data: Phase1Data,
) -> tuple[bool, dict[str, Any]]:
    op = cond.get("op")
    if not isinstance(op, str) or not op:
        return False, {}
    if op in _SPECIFIC_OP_EVALUATORS:
        return _SPECIFIC_OP_EVALUATORS[op](cond, data)
    for suffix, fn in _FAMILY_SUFFIXES:
        if op.endswith(suffix):
            return fn(cond, data)
    # Unknown op → no match. Logged once per op to surface coverage gaps
    # without spamming the hot path.
    _log_unknown_op(op)
    return False, {}


_logged_unknown_ops: set[str] = set()


def _log_unknown_op(op: str) -> None:
    if op in _logged_unknown_ops:
        return
    _logged_unknown_ops.add(op)
    logger.info("pattern_matcher: no evaluator registered for op=%s (returns False)", op)


@dataclass(slots=True)
class PatternMatchResult:
    matched: list[MatchedPattern] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # pattern_ids missing all data


async def match_patterns(
    repo: PatternsRepository,
    phase1: Phase1Data,
    *,
    top_k: int = 20,
    fingerprint: UserFingerprintRepository | None = None,
) -> PatternMatchResult:
    """Evaluate every active pattern's trigger DSL against phase1.

    When `fingerprint` is provided, each match is scored using the
    per-user fingerprint (`pai_user_pattern_pref`) so candidates the
    user repeatedly dismisses get pushed down or fully suppressed.
    Without `fingerprint`, scoring falls back to `base_hit_rate`.
    """
    active = await repo.list_patterns(status="active", limit=500)
    fingerprint_prefs: dict[str, dict[str, Any]] = (
        await fingerprint.get_pattern_prefs() if fingerprint is not None else {}
    )
    matched: list[MatchedPattern] = []

    for pattern in active:
        trigger = pattern.get("triggerDsl") or []
        if not isinstance(trigger, list) or not trigger:
            continue
        evidence: dict[str, Any] = {}
        all_pass = True
        for cond in trigger:
            if not isinstance(cond, dict):
                all_pass = False
                break
            ok, info = evaluate_condition(cond, phase1)
            if not ok:
                all_pass = False
                break
            evidence[str(cond.get("op"))] = info
        if not all_pass:
            continue
        base = float(pattern.get("baseHitRate") or 0.0)
        user_fit: float | None = None
        combined = base
        if fingerprint is not None:
            user_fit = await fingerprint.score_for(
                pattern["id"], base_hit_rate=base or 0.1,
            )
            combined = user_fit
            # Suppressed = drop from match list entirely so it never shows
            # up in `selected_pattern_ids`.
            if combined <= 0 and pattern["id"] in fingerprint_prefs:
                continue
        matched.append(MatchedPattern(
            pattern_id=pattern["id"],
            category=pattern["category"],
            intent=pattern["intent"],
            abstract=pattern["abstract"],
            human_insight=pattern.get("humanInsight") or "",
            card_skeleton=pattern.get("cardSkeleton") or {},
            subtype=None,
            evidence=evidence,
            base_hit_rate=base,
            user_fit_score=user_fit,
            combined_score=combined,
        ))

    matched.sort(key=lambda m: m.combined_score or 0.0, reverse=True)
    return PatternMatchResult(matched=matched[:top_k])
