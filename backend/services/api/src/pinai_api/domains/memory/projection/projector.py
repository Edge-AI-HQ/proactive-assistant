"""Project L0 raw rows (both domain tables) into the L1 pai_events stream
(deterministic).

Each raw row becomes one event; evolve later curates it (curated_at / rollup /
forgetting). project_unprojected scans both pai_raw_apps + pai_raw_device,
normalizing each to a (toolkit, entity) pair (device rows surface as
toolkit='device', entity=kind) — the only domain knowledge here is the
(toolkit, entity) → event_type map; everything else is field carry-over. The
event's source_ref points back to the raw id, so projection is idempotent: we
only project raws with no event yet.

This is the deterministic half of the pipeline; the *semantic* half (what the
event means, whether it matters) is evolve's job. Keeping projection dumb and
synchronous means events_search has data the moment raw lands, without waiting
on an LLM pass.

Rollup stage (design §4.2): a (toolkit, entity) source can opt out of 1-raw→1-event
projection via _ROLLUP_MAP:
  * semantic — firehose (ambient transcript windows). The projector SKIPS these
    so they don't flood L1 one-by-one; rollup_semantic collapses a run of them
    into a single episode event (the load-bearing "don't drown the real signal"
    guard). NOTE (2026-06-30): utterance/session_summary was moved OFF semantic
    → projected 1→1 in real time; only transcript_window stays semantic.
  * window — periodic-state sources (device app/health snapshots, location
    points). NOTE: the rule-based window aggregation itself is not implemented
    yet (these still project 1→1 for now); see docs §4.2 / the lifelong-memory
    plan for the remaining work.
"""

from __future__ import annotations

from typing import Any

from pinai_contracts.rollup_policy import semantic_entities, window_entities
from psycopg import AsyncConnection
from psycopg.rows import DictRow

from ..events import AppendEventInput, EventsRepository, gen_event_id
from .window import project_window_health

# (toolkit, entity) → event_type. Unknown pairs default to 'interaction' — a
# safe catch-all that evolve can re-type. source category is composio for every
# connector toolkit, device for on-device snapshots.
_EVENT_TYPE_MAP: dict[tuple[str, str], str] = {
    ("gmail", "messages"): "communication",
    ("slack", "messages"): "communication",
    ("googlecalendar", "events"): "meeting",
    ("calendly", "events"): "meeting",
    ("stripe", "invoices"): "transaction",
    ("device", "health"): "movement",
    ("device", "location"): "movement",
    ("device", "utterance"): "utterance",
    ("device", "visit"): "movement",
    ("device", "calendar"): "meeting",
    ("device", "motion"): "movement",
    ("device", "transcript_window"): "utterance",
    ("device", "focus"): "interaction",
    ("device", "context"): "interaction",
}


# Per-source rollup strategy is the shared policy (pinai_contracts.rollup_policy,
# doc §4.2). The projector drives off / window synchronously here.
#
# Two kinds of device rows the projector does NOT project 1→1:
#   * semantic skip — firehose (transcript_window: a few-second evidence window):
#     agent-engine's rollup_semantic collapses each run into one episode event, so
#     projecting them one-by-one would drown the real signal in L1. (utterance /
#     session_summary was moved OFF semantic 2026-06-30 → projected 1→1 real-time;
#     see rollup_policy — it's a finished per-conversation transcript, not firehose.)
#   * projection skip — apps / contacts: these are state / reference snapshots
#     (装机列表 / 通讯录), NOT events. Nothing downstream picks them up; they just
#     stay in L0 pai_raw_device for raw.list queries. (Until R2 they were wrongly
#     projected as `interaction` events — pure noise.)
# Three kinds of device rows the projector does NOT project 1→1: semantic skip
# (above), projection skip (apps/contacts above), and WINDOW (health) — those go
# through project_window_health (aggregate by day/metric) instead of 1→1.
# apps/contacts have no rollup mode (not in rollup_policy) — they're not a rollup
# source, they're simply not events.
_SEMANTIC_SKIP_ENTITIES: list[str] = semantic_entities("device")
_PROJECTION_SKIP_ENTITIES: list[str] = ["apps", "contacts"]
_WINDOW_ENTITIES: list[str] = window_entities("device")
_DEVICE_NO_PROJECT: list[str] = (
    _SEMANTIC_SKIP_ENTITIES + _PROJECTION_SKIP_ENTITIES + _WINDOW_ENTITIES
)


# Tombstone predicate per (toolkit, entity): does this raw payload mean "the
# thing was cancelled/deleted at the source"? Drives two behaviours (design
# §6.3/§6.4 取消 = append tombstone):
#   * a NEW raw that is already a tombstone is NOT projected (an
#     init/backfill pulling old cancelled items must not create orphan
#     "untitled" events — the 21-cancelled-gcal lesson);
#   * an UPDATED raw that became a tombstone re-projects as a cancellation
#     revision superseding the current event (title prefixed [cancelled],
#     structured.status='cancelled').
# Same code-map stance as _EVENT_TYPE_MAP (doc §4.1): a dozen lines in one
# place beats per-recipe yaml fields.
_TOMBSTONE_MAP: dict[tuple[str, str], Any] = {
    ("googlecalendar", "events"): lambda p: p.get("status") == "cancelled",
    ("calendly", "events"): lambda p: p.get("status") == "canceled",
}


def is_tombstone_raw(raw: dict[str, Any]) -> bool:
    """True when the raw row represents a source-side cancellation/deletion."""
    pred = _TOMBSTONE_MAP.get((raw["toolkit"], raw["entity"]))
    if pred is None:
        return False
    payload = raw["payload"] if isinstance(raw.get("payload"), dict) else {}
    return bool(pred(payload))


def raw_to_event_input(raw: dict[str, Any]) -> AppendEventInput:
    """One raw row → an AppendEventInput. Pure (testable without a DB).

    Expects the normalized shape project_unprojected SELECTs from either domain
    table: id + toolkit + entity (+ occurred_at/title/snippet/payload/dedupe_key).
    apps rows carry their real toolkit; device rows come through as
    toolkit='device', entity=kind — so the (toolkit, entity) maps below work
    uniformly across both tables."""
    toolkit = raw["toolkit"]
    entity = raw["entity"]
    event_type = _EVENT_TYPE_MAP.get((toolkit, entity), "interaction")
    source = "device" if toolkit == "device" else "composio"
    payload = raw["payload"] if isinstance(raw.get("payload"), dict) else {}
    structured: dict[str, Any] = {"toolkit": toolkit, "entity": entity, **payload}
    # Device rows carry the source platform (ios/android/wearable/…) so the agent
    # reading memory knows which device an event came from. apps rows have no
    # platform (SELECT NULL) — omit rather than store a null.
    if raw.get("platform"):
        structured["platform"] = raw["platform"]
    return AppendEventInput(
        id=gen_event_id(),
        source=source,
        event_type=event_type,
        occurred_at=raw["occurred_at"],
        title=raw.get("title"),
        body=raw.get("snippet"),
        structured=structured,
        source_ref=raw["id"],
        # Idempotency key derived from the raw's own dedupe_key: re-projecting
        # the same raw hits the events unique index and no-ops.
        dedupe_key=f"evt:{raw['dedupe_key']}",
        # curated defaults False → curated_at NULL → evolve's uncurated queue.
        # A mechanically-projected raw event always needs evolve's judgement.
    )


async def project_unprojected(
    conn: AsyncConnection[DictRow], user_id: int, *, limit: int = 500
) -> int:
    """Align L1 with L0 for one user: project raw rows that have no event yet,
    then re-project apps rows whose CONTENT changed since their current event
    (supersede revisions — reschedules / edits / cancellations, design §6.3).
    Returns the number of events appended. Idempotent — safe to call after
    every ingest and on a sweep."""
    async with conn.cursor() as cur:
        # Scan both L0 domain tables, normalizing each to (id, toolkit, entity,
        # …): apps rows carry their real toolkit + entity_type; device rows come
        # through as toolkit='device', entity=kind. Both skip rows already
        # projected (source_ref present in pai_events). Device additionally skips
        # the semantic-rollup firehose (transcript_window only — utterance now
        # projects 1→1 real-time): rollup_semantic collapses those into episode
        # events, so they're never projected one-by-one
        # (design 4.2). ANY(empty) is false, so an empty skip list is a no-op.
        await cur.execute(
            """
            (
              SELECT r.id, r.toolkit, r.entity_type AS entity, r.occurred_at,
                     r.title, r.snippet, r.payload, r.dedupe_key, NULL AS platform
              FROM pai_raw_apps r
              WHERE r.user_id = %s
                AND NOT EXISTS (
                  SELECT 1 FROM pai_events e
                  WHERE e.user_id = r.user_id AND e.source_ref = r.id
                )
            )
            UNION ALL
            (
              SELECT r.id, 'device' AS toolkit, r.kind AS entity, r.occurred_at,
                     r.title, r.snippet, r.payload, r.dedupe_key, r.platform
              FROM pai_raw_device r
              WHERE r.user_id = %s
                -- exclude semantic firehose (rollup_semantic handles them) +
                -- apps/contacts (state/reference, not events). See _DEVICE_NO_PROJECT.
                AND r.kind <> ALL(%s)
                AND NOT EXISTS (
                  SELECT 1 FROM pai_events e
                  WHERE e.user_id = r.user_id AND e.source_ref = r.id
                )
            )
            ORDER BY occurred_at DESC
            LIMIT %s
            """,
            (user_id, user_id, _DEVICE_NO_PROJECT, limit),
        )
        raws = await cur.fetchall()

    repo = EventsRepository(user_id, conn)
    appended = 0
    for raw in raws:
        # A raw that is ALREADY a tombstone (init/backfill pulled an old
        # cancelled item) never gets a first projection — nothing happened
        # that the user needs in L1, and the L0 row keeps the record.
        if is_tombstone_raw(raw):
            continue
        await repo.append(raw_to_event_input(raw))
        appended += 1
    # Supersede pass (design §6.3): apps rows whose content changed since
    # their current event — reschedules / edits / cancellations.
    appended += await _reproject_updated(conn, user_id, repo, limit=limit)
    # Window rollup (doc §4.2): device health aggregated by (local_date, metric),
    # in the same tx so a single project_unprojected covers off + window. (semantic
    # is the agent-engine half — skipped above, rolled by rollup_semantic.)
    appended += await project_window_health(conn, user_id)
    return appended


async def _reproject_updated(
    conn: AsyncConnection[DictRow],
    user_id: int,
    repo: EventsRepository,
    *,
    limit: int,
) -> int:
    """Append supersede revisions for apps raws whose content changed AFTER
    their current event was recorded (`content_updated_at > e.recorded_at`,
    124). The old event stays in the chain (history immutable), the new
    revision becomes the current version; a cancellation becomes a tombstone
    revision. Device rows are append-shaped (no update semantics) — apps only.

    Idempotent: the revision dedupe_key carries the content_updated_at epoch,
    so re-running for the same change no-ops; the next real change gets a new
    key. After appending, the new event's recorded_at > content_updated_at,
    so the row naturally leaves this scan."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT r.id, r.toolkit, r.entity_type AS entity, r.occurred_at,
                   r.title, r.snippet, r.payload, r.dedupe_key, NULL AS platform,
                   r.content_updated_at,
                   e.id AS old_event_id, e.title AS old_title,
                   e.event_type AS old_event_type
            FROM pai_raw_apps r
            JOIN pai_events e
              ON e.user_id = r.user_id
             AND e.source_ref = r.id
             AND e.superseded_by_id IS NULL
            WHERE r.user_id = %s
              AND r.content_updated_at IS NOT NULL
              AND r.content_updated_at > e.recorded_at
            ORDER BY r.content_updated_at
            LIMIT %s
            """,
            (user_id, limit),
        )
        changed = await cur.fetchall()

    appended = 0
    for raw in changed:
        inp = raw_to_event_input(raw)
        # Revision key: base key + change instant (µs — two distinct changes
        # can land within the same second, e.g. rapid edits; second precision
        # would collide their keys and silently swallow the later revision).
        # Same change replays → no-op; the next change carries a fresh key
        # (the base evt:{dedupe} slot is permanently held by the FIRST
        # projection — append-only, no updates).
        epoch_us = int(raw["content_updated_at"].timestamp() * 1_000_000)
        inp.dedupe_key = f"evt:{raw['dedupe_key']}:u{epoch_us}"
        inp.supersedes_id = raw["old_event_id"]
        if is_tombstone_raw(raw):
            # Cancellation revision: the source item is gone. Its payload often
            # loses the human fields (a cancelled gcal instance carries no
            # summary), so title falls back to the superseded event's title.
            base_title = raw.get("title") or raw.get("old_title") or "(untitled)"
            inp.title = f"[cancelled] {base_title}"
            inp.event_type = raw["old_event_type"]  # keep the semantic type
            inp.structured = {**(inp.structured or {}), "status": "cancelled"}
        await repo.append(inp)
        appended += 1
    return appended
