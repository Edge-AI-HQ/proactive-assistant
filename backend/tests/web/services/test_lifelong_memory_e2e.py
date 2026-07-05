"""Lifelong-memory end-to-end data flow (P5 gate).

Strings the four layers together at the DB/repo level:
  connector ingest → pai_raw (L0) → projector → pai_events pending (L1)
  → evolve-style curate + portrait distill (simulated, no LLM)
  → agent read (events_search active + portrait).

Proves the pipes connect end to end. The LLM distillation *quality*, the
chat-agent injection (P6), and real connector OAuth are NOT exercised here —
those need Daytona + a live model + OAuth (see the runtime). This is the
deterministic data-flow gate: every layer's read/write contract lines up.
"""

from __future__ import annotations

import pytest
from pinai_api.domains.connector.apps import generic_ingest
from pinai_api.domains.connector.apps.ingest_runner import Recipe
from pinai_api.domains.memory.events.repository import EventsRepository
from pinai_api.domains.memory.portrait.repository import EditOp, UserStringsRepository
from pinai_api.domains.memory.projection.projector import project_unprojected
from pinai_db.rls import user_scoped_tx


@pytest.mark.asyncio
async def test_lifelong_memory_pipeline_e2e(pool, user_ids):
    user_a, _ = user_ids
    recipe = Recipe.model_validate(
        {
            "toolkit": "gmail",
            "slug": "GMAIL_FETCH_EMAILS",
            "entity_type": "messages",
            "id_field": "id",
            "timestamp_path": ["messageTimestamp"],
            "title_path": ["subject"],
            "snippet_path": ["snippet"],
        }
    )
    items = [
        {
            "id": "m1",
            "subject": "Investor meeting Thursday",
            "snippet": "Confirm 4pm with Alex",
            "messageTimestamp": "2026-06-20T10:00:00Z",
        },
        {
            "id": "m2",
            "subject": "HuggingFace Daily Papers",
            "snippet": "this week's papers",
            "messageTimestamp": "2026-06-20T11:00:00Z",
        },
    ]

    # ── L0: connector ingest → pai_raw, then L0 → L1: projector → pai_events ──
    async with user_scoped_tx(pool, user_a) as conn:
        inserted = await generic_ingest.upsert_generic(
            conn, user_a, "gmail", "messages", recipe, items
        )
        assert inserted == 2
        appended = await project_unprojected(conn, user_a)
        assert appended == 2

    # ── L1: two pending events, typed communication, projected from the raw ──
    async with user_scoped_tx(pool, user_a) as conn:
        events = EventsRepository(user_a, conn)
        pending = await events.search_structured(status="pending")
        assert len(pending) == 2
        assert all(e.event_type == "communication" for e in pending)  # gmail → communication
        meeting = next(e for e in pending if "Investor" in (e.title or ""))
        newsletter = next(e for e in pending if "HuggingFace" in (e.title or ""))

        # ── evolve-style consolidation (simulated, no LLM): both events stay in
        # L1 (the projector projects everything; there is no filtered_out state).
        # Formation gates at L1→L2 — only the meeting is distilled into the
        # portrait; the newsletter is left in L1, ordered down by the objective
        # score. evolve marks both curated (it has processed them). ──
        await events.mark_curated(meeting.id)
        await events.mark_curated(newsletter.id)
        portrait = UserStringsRepository(user_a, conn)
        edit = await portrait.edit(
            "USER", operations=[EditOp(op="add", text="Founder; meets investor Alex")]
        )
        assert edit.ok

    # ── Agent read: events_search(active) surfaces BOTH valid L1 events (no
    # filtered_out); the formation gate kept the newsletter OUT of the L2
    # portrait — that is the real gate, not L1 visibility. ──
    async with user_scoped_tx(pool, user_a) as conn:
        events = EventsRepository(user_a, conn)
        active = await events.search_structured(status="active")
        titles = [e.title for e in active]
        assert "Investor meeting Thursday" in titles
        assert len(active) == 2  # L1 keeps both; noise is not removed, just ranked down

        portrait = UserStringsRepository(user_a, conn)
        slots = await portrait.get_all()
        assert "investor Alex" in slots["USER"]  # only the meeting distilled into L2
