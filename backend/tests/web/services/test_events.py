"""EventsRepository + event_projector — pure mapping + DB round-trip.

Pure mapper tests run anywhere; the DB tests need TEST_DATABASE_URL with
migration 111 (pai_events) applied.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pinai_api.domains.memory.events.repository import AppendEventInput, EventsRepository
from pinai_api.domains.memory.projection.projector import (
    project_unprojected,
    raw_to_event_input,
)
from pinai_db.rls import user_scoped_tx


def _raw(**overrides) -> dict:
    base = {
        "id": "raw_1",
        "toolkit": "gmail",
        # raw_to_event_input expects the normalized shape project_unprojected
        # SELECTs (entity, not entity_type — apps' entity_type / device's kind
        # both surface under the `entity` alias).
        "entity": "messages",
        "occurred_at": datetime(2026, 6, 1, 8, 0, tzinfo=UTC),
        "title": "Hello",
        "snippet": "the body",
        "payload": {"from": "a@b.com"},
        "dedupe_key": "gmail:messages:m1",
    }
    base.update(overrides)
    return base


# ── pure mapping (raw → event input) ────────────────────────────────────


def test_raw_to_event_input_gmail_is_communication():
    inp = raw_to_event_input(_raw())
    assert inp.event_type == "communication"
    assert inp.source == "composio"
    assert inp.source_ref == "raw_1"
    assert inp.dedupe_key == "evt:gmail:messages:m1"
    assert inp.curated is False  # projector writes uncurated → curated_at NULL
    assert inp.title == "Hello"
    assert inp.body == "the body"
    assert inp.structured["toolkit"] == "gmail"
    assert inp.structured["from"] == "a@b.com"


def test_raw_to_event_input_device_health_is_movement():
    inp = raw_to_event_input(_raw(toolkit="device", entity="health", payload={"metric": "steps"}))
    assert inp.event_type == "movement"
    assert inp.source == "device"


def test_raw_to_event_input_device_location_is_movement():
    """location pings are movement, not the `interaction` catch-all — before the
    map entry existed they fell through to the default and mis-typed L1."""
    inp = raw_to_event_input(
        _raw(toolkit="device", entity="location", payload={"lat": 31.2, "lng": 121.5})
    )
    assert inp.event_type == "movement"
    assert inp.source == "device"


def test_raw_to_event_input_carries_device_platform():
    """device rows carry platform → event structured, so the agent reading memory
    knows which device an event came from. apps rows have no platform (SELECT
    NULL) → omitted, not stored as a null."""
    dev = raw_to_event_input(_raw(toolkit="device", entity="visit", platform="ios"))
    assert dev.structured["platform"] == "ios"
    apps = raw_to_event_input(_raw(toolkit="gmail", entity="messages"))
    assert "platform" not in apps.structured


def test_raw_to_event_input_unknown_defaults_to_interaction():
    inp = raw_to_event_input(_raw(toolkit="github", entity="issues"))
    assert inp.event_type == "interaction"
    assert inp.source == "composio"


# ── DB round-trip (needs TEST_DATABASE_URL + migration 111) ─────────────


@pytest.mark.asyncio
async def test_append_is_idempotent_on_dedupe(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        row1 = await repo.append(
            AppendEventInput(
                id="e1",
                source="composio",
                event_type="meeting",
                occurred_at=datetime(2026, 6, 1, tzinfo=UTC),
                dedupe_key="k1",
                title="Sync",
                curated=True,
            )
        )
        assert row1.id == "e1"
        # Same dedupe_key, different id → returns the existing row, no insert.
        row2 = await repo.append(
            AppendEventInput(
                id="e2",
                source="composio",
                event_type="meeting",
                occurred_at=datetime(2026, 6, 2, tzinfo=UTC),
                dedupe_key="k1",
                title="Other",
            )
        )
        assert row2.id == "e1"

    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        rows = await repo.search_structured(status="active")
    assert len([r for r in rows if r.dedupe_key == "k1"]) == 1


@pytest.mark.asyncio
async def test_append_enqueues_embedding(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(
            AppendEventInput(
                id="emb1",
                source="composio",
                event_type="meeting",
                occurred_at=datetime(2026, 6, 1, tzinfo=UTC),
                dedupe_key="embk1",
                title="Title",
                body="Body",
            )
        )
        cur = await conn.execute(
            "SELECT text FROM pai_embedding_queue "
            "WHERE user_id=%s AND table_name='pai_events' AND row_id='emb1'",
            (user_a,),
        )
        row = await cur.fetchone()
    assert row is not None
    assert "Title" in row["text"] and "Body" in row["text"]


@pytest.mark.asyncio
async def test_search_structured_filters_type_and_recency(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(
            AppendEventInput(
                id="m1",
                source="composio",
                event_type="meeting",
                occurred_at=datetime(2026, 6, 1, tzinfo=UTC),
                dedupe_key="sm1",
                title="M1",
                curated=True,
            )
        )
        await repo.append(
            AppendEventInput(
                id="c1",
                source="composio",
                event_type="communication",
                occurred_at=datetime(2026, 6, 2, tzinfo=UTC),
                dedupe_key="sc1",
                title="C1",
                curated=True,
            )
        )
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        meetings = await repo.search_structured(event_type="meeting", status="active")
    assert [r.id for r in meetings] == ["m1"]


@pytest.mark.asyncio
async def test_search_hybrid_keyword_lane_matches_exact_terms(pool, user_ids):
    """Hybrid search's keyword lane (migration 120 tsvector) catches exact-term
    hits the cosine lane would miss. Here events have no embedding, so the
    semantic lane is empty — RRF surfaces the keyword match alone, proving the
    keyword lane works (world full-migration W1: events_search now hybrid)."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(
            AppendEventInput(
                id="ev_oai",
                source="composio",
                event_type="communication",
                occurred_at=datetime(2026, 6, 1, tzinfo=UTC),
                dedupe_key="k_oai",
                title="OpenAI billing increase",
                body="The OpenAI invoice went up this month.",
                curated=True,
            )
        )
        await repo.append(
            AppendEventInput(
                id="ev_cricket",
                source="composio",
                event_type="communication",
                occurred_at=datetime(2026, 6, 2, tzinfo=UTC),
                dedupe_key="k_cricket",
                title="Cricket match result",
                body="The local team won the cricket final.",
                curated=True,
            )
        )

    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        # No embeddings seeded → semantic lane empty; a zero vector is harmless.
        rows = await repo.search_hybrid(
            query_vector=[0.0] * 1536,
            query_text="OpenAI billing",
            limit=10,
            run_id="r1",
        )
    ids = [r.id for r in rows]
    assert "ev_oai" in ids  # keyword-matched
    assert "ev_cricket" not in ids  # no term overlap


@pytest.mark.asyncio
async def test_search_hybrid_until_bounds_the_window(pool, user_ids):
    """`until` genuinely narrows the q path (was a silent no-op: the route
    accepted it, repo hybrid/semantic had no such parameter — SDK callers
    passing q+until got unfiltered results). Both hybrid lanes now carry it."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        for id_, day in (("ev_win_in", 10), ("ev_win_out", 20)):
            await repo.append(
                AppendEventInput(
                    id=id_,
                    source="composio",
                    event_type="meeting",
                    occurred_at=datetime(2026, 7, day, tzinfo=UTC),
                    dedupe_key=f"k_{id_}",
                    title="Budget review meeting",
                    curated=True,
                )
            )

    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        rows = await repo.search_hybrid(
            query_vector=[0.0] * 1536,
            query_text="budget review",
            limit=10,
            since=datetime(2026, 7, 1, tzinfo=UTC),
            until=datetime(2026, 7, 15, tzinfo=UTC),
            run_id="r_win",
        )
    ids = [r.id for r in rows]
    assert ids == ["ev_win_in"]  # the 07-20 hit is outside the window


@pytest.mark.asyncio
async def test_project_unprojected_is_idempotent(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            """
            INSERT INTO pai_raw_apps
              (user_id, id, toolkit, entity_type, occurred_at, title, snippet, payload, dedupe_key)
            VALUES (%s, 'raw_p1', 'gmail', 'messages', %s, 'Hi', 'body', '{}'::jsonb, 'gmail:messages:p1')
            """,
            (user_a, datetime(2026, 6, 1, tzinfo=UTC)),
        )

    async with user_scoped_tx(pool, user_a) as conn:
        appended = await project_unprojected(conn, user_a)
    assert appended == 1

    # Second pass: the raw already has an event (source_ref) → no-op.
    async with user_scoped_tx(pool, user_a) as conn:
        again = await project_unprojected(conn, user_a)
    assert again == 0

    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        rows = await repo.search_structured(status="pending")
    projected = [r for r in rows if r.source_ref == "raw_p1"]
    assert len(projected) == 1
    assert projected[0].event_type == "communication"
    assert projected[0].title == "Hi"


@pytest.mark.asyncio
async def test_project_never_projects_device_apps_contacts_health_1to1(pool, user_ids):
    """No device source is projected 1→1: apps / contacts are state/reference
    (skipped entirely, rollup R2), health goes through window rollup by
    (date, metric) not 1→1 (rollup R3, see the window test below). So a bare
    health row with no local_date/metric produces no event at all."""
    user_a, _ = user_ids
    now = datetime(2026, 6, 1, tzinfo=UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        for kind in ("apps", "contacts", "health"):
            await conn.execute(
                """
                INSERT INTO pai_raw_device
                  (user_id, id, kind, external_id, occurred_at, title, payload, dedupe_key)
                VALUES (%s, %s, %s, 'dev1', %s, %s, '{}'::jsonb, %s)
                """,
                (user_a, f"draw_{kind}", kind, now, kind, f"d:{kind}"),
            )

    async with user_scoped_tx(pool, user_a) as conn:
        await project_unprojected(conn, user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        rows = await repo.search_structured(status="pending")
    refs = {r.source_ref for r in rows}
    assert "draw_apps" not in refs  # state, not an event → skipped
    assert "draw_contacts" not in refs  # reference data → skipped
    assert "draw_health" not in refs  # health → window rollup, never 1→1


@pytest.mark.asyncio
async def test_window_rollup_health_aggregates_complete_days_only(pool, user_ids):
    """Window rollup (R3): complete-day (local_date < today) health observations
    aggregate by (local_date, metric) into ONE movement event with summed value;
    the in-progress day waits (its aggregate would be unstable); idempotent."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        # 2 steps observations on a complete day (yesterday) + 1 on today.
        for i, (day_off, val) in enumerate([(1, 3000), (1, 5000), (0, 1000)]):
            await conn.execute(
                """
                INSERT INTO pai_raw_device
                  (user_id, id, kind, external_id, occurred_at, payload, dedupe_key)
                VALUES (%s, %s, 'health', 'dev1', now(),
                        jsonb_build_object(
                          'local_date', to_char(current_date - %s, 'YYYY-MM-DD'),
                          'metric', 'steps', 'value', %s, 'unit', 'count'),
                        %s)
                """,
                (user_a, f"h{i}", day_off, val, f"h:{i}"),
            )

    async with user_scoped_tx(pool, user_a) as conn:
        await project_unprojected(conn, user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        rows = await repo.search_structured(event_type="movement", status="pending")
    windowed = [r for r in rows if (r.structured or {}).get("rollup") == "window"]
    # Only the complete day rolled up (today waits) — exactly one event.
    assert len(windowed) == 1
    e = windowed[0]
    assert e.structured["metric"] == "steps"
    assert e.structured["count"] == 2  # the 2 yesterday observations
    assert e.structured["sum"] == 8000  # 3000 + 5000; today's 1000 not included

    # Idempotent: re-rolling appends nothing (NOT EXISTS + dedupe_key).
    async with user_scoped_tx(pool, user_a) as conn:
        again = await project_unprojected(conn, user_a)
    assert again == 0


@pytest.mark.asyncio
async def test_mark_curated_stamps_curated_at(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(
            AppendEventInput(
                id="p1",
                source="composio",
                event_type="meeting",
                occurred_at=datetime(2026, 6, 1, tzinfo=UTC),
                dedupe_key="pk1",
                title="Pending",
            )
        )
        # Projector-written event lands uncurated (curated_at NULL).
        before = await repo.get("p1")
        assert before is not None
        assert before.curated_at is None
        # evolve marks it curated → leaves the uncurated queue.
        assert await repo.mark_curated("p1")
        ev = await repo.get("p1")
    assert ev is not None
    assert ev.curated_at is not None


@pytest.mark.asyncio
async def test_append_supersede_links_old_row(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(
            AppendEventInput(
                id="old1",
                source="composio",
                event_type="meeting",
                occurred_at=datetime(2026, 6, 1, tzinfo=UTC),
                dedupe_key="oldk",
                title="Old",
                curated=True,
            )
        )
        await repo.append(
            AppendEventInput(
                id="new1",
                source="composio",
                event_type="meeting",
                occurred_at=datetime(2026, 6, 2, tzinfo=UTC),
                dedupe_key="newk",
                title="New",
                curated=True,
                supersedes_id="old1",
            )
        )
        old = await repo.get("old1")
    assert old is not None
    assert old.superseded_by_id == "new1"  # the supersede chain expresses "archived"


# ── WP3 · reference signal chain (bump on hit + objective ranking) ──────
#
# doc §5.5 / §七-327/329: events_search hits bump the reference triple
# (the SOURCE of the objective signal chain), and retrieval ranks by the
# objective score (reference × recency × event_type weight × similarity),
# not raw recency / vector distance.

_DIM = 1536
_OCC = datetime(2026, 6, 1, tzinfo=UTC)


def _active(id_: str, event_type: str, *, occurred_at: datetime = _OCC) -> AppendEventInput:
    return AppendEventInput(
        id=id_,
        source="composio",
        event_type=event_type,
        occurred_at=occurred_at,
        dedupe_key=f"wp3:{id_}",
        title=id_,
        curated=True,
    )


async def _ref_state(conn, user_id: int, event_id: str):
    """(reference_count, last_referenced_at, referenced_by_runs) read raw —
    referenced_by_runs is deliberately off the repo read path (see migration 116)."""
    cur = await conn.execute(
        "SELECT reference_count, last_referenced_at, referenced_by_runs "
        "FROM pai_events WHERE user_id = %s AND id = %s",
        (user_id, event_id),
    )
    row = await cur.fetchone()
    return row["reference_count"], row["last_referenced_at"], row["referenced_by_runs"]


def _vec_lit(*head: float) -> str:
    """1536-d vector literal with `head` as leading components, rest zero —
    cosine distance to other such vectors is decided by the leading dims."""
    v = [0.0] * _DIM
    for i, x in enumerate(head):
        v[i] = float(x)
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


@pytest.mark.asyncio
async def test_reference_bump_increments_count_time_and_records_run(pool, user_ids):
    """A retrieval hit bumps reference_count + last_referenced_at and records the
    retrieving run (deduped). No run_id (UI browse / internal read) does NOT bump
    — only agent retrieval is the "use" that drives importance, so passive reads
    can't inflate the signal."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(_active("rb1", "meeting"))

        # First retrieval with a run id → count 1, time set, run recorded.
        hits = await repo.search_structured(status="active", run_id="run_A")
        assert "rb1" in [r.id for r in hits]
        count, last_ref, runs = await _ref_state(conn, user_a, "rb1")
        assert count == 1
        assert last_ref is not None
        assert runs == ["run_A"]

        # Same run again → count climbs, run de-duplicated (not 2× run_A).
        await repo.search_structured(status="active", run_id="run_A")
        count, _, runs = await _ref_state(conn, user_a, "rb1")
        assert count == 2
        assert runs == ["run_A"]

        # A different run → appended to the provenance list.
        await repo.search_structured(status="active", run_id="run_B")
        count, _, runs = await _ref_state(conn, user_a, "rb1")
        assert count == 3
        assert runs == ["run_A", "run_B"]

        # No run_id (UI browse / internal) → NO bump: count stays 3, runs unchanged.
        await repo.search_structured(status="active")
        count, _, runs = await _ref_state(conn, user_a, "rb1")
        assert count == 3
        assert runs == ["run_A", "run_B"]


@pytest.mark.asyncio
async def test_high_reference_event_ranks_first_same_window(pool, user_ids):
    """Same time window + event_type: the higher-reference event ranks first
    (objective usage signal), not the insertion / recency order."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(_active("low", "meeting"))
        await repo.append(_active("high", "meeting"))
        # Pin recency equal (both anchored at _OCC) and vary only reference_count.
        await conn.execute(
            "UPDATE pai_events SET reference_count = 5, last_referenced_at = %s "
            "WHERE user_id = %s AND id = 'high'",
            (_OCC, user_a),
        )

        ranked = await repo.search_structured(event_type="meeting", run_id="r")
    assert [r.id for r in ranked] == ["high", "low"]


@pytest.mark.asyncio
async def test_event_type_weight_ranks_transaction_over_utterance(pool, user_ids):
    """Cold start (reference_count=0, same window): the structural event_type
    prior orders results — transaction (1.0) over utterance (0.3)."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(_active("chatter", "utterance"))
        await repo.append(_active("payment", "transaction"))

        ranked = await repo.search_structured(run_id="r")
    assert [r.id for r in ranked] == ["payment", "chatter"]


@pytest.mark.asyncio
async def test_structured_no_run_id_keeps_chronological_order(pool, user_ids):
    """Without a run_id (UI timeline / preference list / internal), ordering stays
    strict occurred_at DESC — objective ranking must not scramble those surfaces."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        # `old` is a high-weight transaction; `new` is a low-weight utterance.
        # Objective ranking would float `old`; chronological keeps `new` first.
        await repo.append(_active("old", "transaction", occurred_at=_OCC))
        await repo.append(_active("new", "utterance", occurred_at=datetime(2026, 6, 2, tzinfo=UTC)))

        rows = await repo.search_structured()  # no run_id
    assert [r.id for r in rows] == ["new", "old"]


@pytest.mark.asyncio
async def test_semantic_ranking_fuses_reference_over_similarity(pool, user_ids):
    """Retrieve-then-rerank: a slightly-less-similar but heavily-referenced event
    outranks a more-similar unreferenced one once usage is fused in (doc §5.5)."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(_active("near", "communication"))
        await repo.append(_active("far", "communication"))
        # near: cosine sim 0.9 to the query, never referenced.
        # far:  cosine sim 0.8 to the query, but referenced 10×.
        await conn.execute(
            "UPDATE pai_events SET embedding = %s::vector WHERE user_id = %s AND id = 'near'",
            (_vec_lit(0.9, 0.4359), user_a),
        )
        await conn.execute(
            "UPDATE pai_events SET embedding = %s::vector, reference_count = 10, "
            "last_referenced_at = %s WHERE user_id = %s AND id = 'far'",
            (_vec_lit(0.8, 0.6), _OCC, user_a),
        )

        ranked = await repo.search_semantic(
            query_vector=[1.0] + [0.0] * (_DIM - 1), limit=10, run_id="r"
        )
    assert [r.id for r in ranked] == ["far", "near"]


@pytest.mark.asyncio
async def test_reference_bump_failure_does_not_break_search(pool, user_ids, monkeypatch):
    """The bump is a best-effort side effect on the READ path: a genuine DB error
    inside its SAVEPOINT must be contained — search still returns, the outer
    transaction stays usable, and the bump simply leaves no trace."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)
        await repo.append(_active("bf1", "meeting"))

        # Redirect the bump's UPDATE (issued via conn.execute) to a genuinely
        # failing statement so the subtransaction really aborts. The SELECT path
        # uses cursor.execute and the SAVEPOINT machinery uses _exec_command, so
        # both stay intact.
        orig_execute = conn.execute

        async def boom(*_args, **_kwargs):
            await orig_execute("SELECT 1 / 0")

        monkeypatch.setattr(conn, "execute", boom)
        rows = await repo.search_structured(status="active", run_id="r")
        assert [r.id for r in rows] == ["bf1"]  # search returned despite bump failure
        monkeypatch.undo()

        # Outer transaction survived (SAVEPOINT contained the abort) and the bump
        # left no partial trace.
        count, last_ref, runs = await _ref_state(conn, user_a, "bf1")
        assert count == 0
        assert last_ref is None
        assert runs == []
