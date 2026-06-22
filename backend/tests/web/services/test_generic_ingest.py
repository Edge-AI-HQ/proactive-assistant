"""Unit tests for generic_ingest (pai_raw_events mapper + upserter) and
the generic fallback wiring in connector_ingest.

Pure mapper tests run anywhere; the upsert/read-back tests need
TEST_DATABASE_URL with migration 089 applied.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from pinai_api.domains.connector.apps import connector_ingest, generic_ingest
from pinai_api.domains.connector.apps.ingest_runner import Recipe
from pinai_api.platform.db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    enqueue_once,
)
from pinai_db.rls import service_tx, user_scoped_tx


def _recipe(**overrides) -> Recipe:
    base = {
        "toolkit": "notion",
        "slug": "NOTION_SEARCH_NOTION_PAGE",
        "entity_type": "pages",
        "id_field": "id",
        "timestamp_path": ["last_edited_time"],
        "title_path": ["title"],
        "snippet_path": ["description"],
    }
    base.update(overrides)
    return Recipe.model_validate(base)


# ── parse_any_ts ────────────────────────────────────────────────────────


def test_parse_any_ts_variants():
    iso = generic_ingest.parse_any_ts("2026-06-01T12:00:00Z")
    assert iso == datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
    secs = generic_ingest.parse_any_ts(1_750_000_000)
    assert secs is not None and secs.year == 2025
    millis = generic_ingest.parse_any_ts(1_750_000_000_000)
    assert millis == secs
    assert generic_ingest.parse_any_ts("not a date") is None
    assert generic_ingest.parse_any_ts(None) is None
    assert generic_ingest.parse_any_ts("") is None


# ── map_item ────────────────────────────────────────────────────────────


def test_map_item_with_id_field():
    item = {
        "id": "page-1",
        "title": "Quarterly plan",
        "description": "Q3 goals",
        "last_edited_time": "2026-06-01T08:00:00Z",
        "extra": {"nested": True},
    }
    mapped = generic_ingest.map_item(item, toolkit="notion", entity_type="pages", recipe=_recipe())
    assert mapped is not None
    assert mapped["external_id"] == "page-1"
    assert mapped["dedupe_key"] == "notion:pages:page-1"
    assert mapped["occurred_at"] == datetime(2026, 6, 1, 8, 0, tzinfo=UTC)
    assert mapped["title"] == "Quarterly plan"
    assert mapped["snippet"] == "Q3 goals"
    assert '"nested": true' in mapped["payload_json"]


def test_map_item_without_id_falls_back_to_hash():
    item = {"name": "no id here"}
    recipe = _recipe(id_field=None, timestamp_path=[], title_path=[], snippet_path=[])
    mapped = generic_ingest.map_item(item, toolkit="foo", entity_type="items", recipe=recipe)
    assert mapped is not None
    assert mapped["external_id"] is None
    assert mapped["dedupe_key"].startswith("foo:items:sha256:")
    assert mapped["occurred_at"] is None
    assert mapped["title"] is None
    # Same payload → same hash (stable dedupe).
    again = generic_ingest.map_item(dict(item), toolkit="foo", entity_type="items", recipe=recipe)
    assert again is not None
    assert again["dedupe_key"] == mapped["dedupe_key"]


def test_map_item_rejects_non_dict():
    assert (
        generic_ingest.map_item(
            "nope",  # type: ignore[arg-type]
            toolkit="foo",
            entity_type="items",
            recipe=_recipe(),
        )
        is None
    )


def test_map_item_truncates_oversized_payload():
    item = {"id": "big-1", "title": "big", "blob": "x" * (300 * 1024)}
    mapped = generic_ingest.map_item(
        item,
        toolkit="foo",
        entity_type="items",
        recipe=_recipe(timestamp_path=[], snippet_path=[]),
    )
    assert mapped is not None
    assert '"__truncated__": true' in mapped["payload_json"]
    assert mapped["dedupe_key"] == "foo:items:big-1"


# ── generic fallback wiring ─────────────────────────────────────────────


def test_resolve_upserter_prefers_typed():
    recipe = _recipe(toolkit="gmail")
    assert (
        connector_ingest._resolve_upserter("gmail", recipe) is connector_ingest._UPSERTERS["gmail"]
    )


def test_resolve_upserter_falls_back_to_generic():
    recipe = _recipe()
    upserter = connector_ingest._resolve_upserter("notion", recipe)
    assert upserter not in connector_ingest._UPSERTERS.values()


def test_cron_for_interval():
    assert connector_ingest._cron_for_interval(12) == "0 */12 * * *"
    assert connector_ingest._cron_for_interval(1) == "0 */1 * * *"
    assert connector_ingest._cron_for_interval(0) == "0 */1 * * *"
    assert connector_ingest._cron_for_interval(24) == "0 6 * * *"
    assert connector_ingest._cron_for_interval(720) == "0 6 * * *"


# ── DB round-trip (needs TEST_DATABASE_URL + migration 089) ────────────


@pytest.mark.asyncio
async def test_upsert_generic_roundtrip_and_dedupe(pool, user_ids):
    user_a, _ = user_ids
    recipe = _recipe()
    items = [
        {
            "id": "page-1",
            "title": "First",
            "description": "first page",
            "last_edited_time": "2026-06-01T08:00:00Z",
        },
        {
            "id": "page-2",
            "title": "Second",
            "description": "second page",
            "last_edited_time": "2026-06-02T09:30:00Z",
        },
        "not-a-dict",
    ]

    async with user_scoped_tx(pool, user_a) as conn:
        inserted = await generic_ingest.upsert_generic(
            conn, user_a, "notion", "pages", recipe, items
        )
    assert inserted == 2

    # Re-ingest: conflict path updates, inserts nothing new.
    items[0]["title"] = "First (edited)"
    async with user_scoped_tx(pool, user_a) as conn:
        inserted = await generic_ingest.upsert_generic(
            conn, user_a, "notion", "pages", recipe, items
        )
    assert inserted == 0

    async with user_scoped_tx(pool, user_a) as conn:
        cur = await conn.execute(
            """
            SELECT external_id, occurred_at, title, snippet, payload, dedupe_key
            FROM pai_raw_events
            WHERE user_id = %s AND toolkit = %s AND entity_type = %s
            ORDER BY occurred_at DESC
            """,
            (user_a, "notion", "pages"),
        )
        rows = await cur.fetchall()
    assert [r["external_id"] for r in rows] == ["page-2", "page-1"]
    assert rows[1]["title"] == "First (edited)"  # refresh-on-conflict
    assert rows[1]["dedupe_key"] == "notion:pages:page-1"
    assert rows[1]["payload"]["description"] == "first page"
    assert rows[1]["occurred_at"] == datetime(2026, 6, 1, 8, 0, tzinfo=UTC)


@pytest.mark.asyncio
async def test_upsert_generic_no_timestamp_keeps_original_occurred_at(pool, user_ids):
    user_a, _ = user_ids
    recipe = _recipe(timestamp_path=[], title_path=[], snippet_path=[])
    item = {"id": "stable-1", "note": "no timestamp field"}

    async with user_scoped_tx(pool, user_a) as conn:
        assert (
            await generic_ingest.upsert_generic(conn, user_a, "foo", "items", recipe, [item]) == 1
        )
        cur = await conn.execute(
            "SELECT occurred_at FROM pai_raw_events WHERE user_id=%s AND dedupe_key=%s",
            (user_a, "foo:items:stable-1"),
        )
        first = (await cur.fetchone())["occurred_at"]

    # Re-sync the same item: occurred_at must NOT advance to NOW(),
    # otherwise timestamp-less rows stay inside the 24h generation
    # window forever.
    async with user_scoped_tx(pool, user_a) as conn:
        await generic_ingest.upsert_generic(conn, user_a, "foo", "items", recipe, [item])
        cur = await conn.execute(
            "SELECT occurred_at FROM pai_raw_events WHERE user_id=%s AND dedupe_key=%s",
            (user_a, "foo:items:stable-1"),
        )
        second = (await cur.fetchone())["occurred_at"]
    assert second == first


def _make_task(
    user_id: int,
    payload: dict,
    *,
    task_id: str,
    kind: str = "connector.init",
) -> ScheduledTaskRow:
    from datetime import datetime as _dt

    return ScheduledTaskRow(
        user_id=user_id,
        id=task_id,
        kind=kind,
        name=None,
        prompt=None,
        trigger_kind="once",
        cron_expr=None,
        interval_seconds=None,
        event_filter=None,
        payload=payload,
        timezone="UTC",
        status="archived",
        next_run_at=None,
        last_run_at=_dt.now(UTC),
        last_run_status="dispatched",
        run_count=1,
        attempts=0,
        max_attempts=3,
        progress={},
        last_error=None,
    )


@pytest.mark.asyncio
async def test_run_init_generic_full_wiring(pool, user_ids, monkeypatch):
    """connector.init for a toolkit with a generic recipe but no typed
    upserter: items land in pai_raw_events, a REAL evolve task is
    enqueued, and the sync schedule cron derives from the recipe's
    sync_interval_hours (not the typed 30-minute cadence)."""
    user_a, _ = user_ids
    recipe = _recipe(
        toolkit="acme",
        slug="ACME_LIST_THINGS",
        entity_type="things",
        timestamp_path=["updated_at"],
        title_path=["name"],
        snippet_path=[],
        sync_interval_hours=12,
    )
    monkeypatch.setattr(connector_ingest.ingest_runner, "load_recipe", lambda tk: recipe)

    async def _fake_fetch(user, toolkit, cid, *, limit=100, since=None, pool=None):
        assert toolkit == "acme"
        return [
            {"id": "t-1", "name": "Thing one", "updated_at": "2026-06-09T10:00:00Z"},
            {"id": "t-2", "name": "Thing two", "updated_at": "2026-06-09T11:00:00Z"},
        ]

    monkeypatch.setattr(connector_ingest.ingest_runner, "run_fetch", _fake_fetch)

    task_id = "init.acme.cid-1"
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id=task_id,
            kind="connector.init",
            payload={"toolkit": "acme", "connectedAccountId": "cid-1"},
            max_attempts=3,
            run_after=datetime.now(UTC) + timedelta(hours=6),
        )
    task = _make_task(
        user_a,
        {"toolkit": "acme", "connectedAccountId": "cid-1", "limit": 50},
        task_id=task_id,
    )
    await connector_ingest.run(pool, task, run_id="run_generic")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT external_id, title, occurred_at FROM pai_raw_events "
            "WHERE user_id=%s AND toolkit='acme' AND entity_type='things' "
            "ORDER BY external_id",
            (user_a,),
        )
        raw_rows = await cur.fetchall()
        cur = await conn.execute(
            "SELECT id, kind, cron_expr, payload FROM pai_scheduled_tasks "
            "WHERE user_id=%s AND id IN ('evolve.acme.cid-1', 'sync.acme.cid-1') "
            "ORDER BY id",
            (user_a,),
        )
        sched_rows = await cur.fetchall()

    assert [r["external_id"] for r in raw_rows] == ["t-1", "t-2"]
    assert raw_rows[0]["title"] == "Thing one"
    assert [r["id"] for r in sched_rows] == ["evolve.acme.cid-1", "sync.acme.cid-1"]
    evolve_row, sync_row = sched_rows
    assert evolve_row["kind"] == "connector.evolve"
    assert evolve_row["payload"]["connector"] == "acme"
    assert sync_row["cron_expr"] == "0 */12 * * *"  # derived, not */30


def test_raw_sources_for_googlesuper_expands_to_typed_and_generic_sources():
    """Real recipes on disk: googlesuper.yaml fans out to typed Google
    sources plus generic Docs/Sheets sources."""
    from pinai_api.domains.connector.apps.raw_agent import (
        _connector_toolkit_covers,
        raw_sources_for_composio_toolkit,
    )

    assert raw_sources_for_composio_toolkit("googlesuper") == [
        ("gmail", "messages"),
        ("gcal", "events"),
        ("gdrive", "files"),
        ("googledocs", "documents"),
        ("googlesheets", "spreadsheets"),
    ]
    assert raw_sources_for_composio_toolkit("gmail") == [("gmail", "messages")]
    assert raw_sources_for_composio_toolkit("notion") == [("notion", "pages")]
    assert raw_sources_for_composio_toolkit("nonexistent-tk") == []
    assert _connector_toolkit_covers("googlesuper", "googledocs")
    assert _connector_toolkit_covers("googlesuper", "googlesheets")
    assert not _connector_toolkit_covers("googledocs", "googlesuper")


def _fanout_recipes() -> dict[str, Recipe]:
    return {
        "gsuper": Recipe.model_validate({"toolkit": "gsuper", "fanout": ["alpha", "beta"]}),
        "alpha": _recipe(
            toolkit="alpha",
            slug="ALPHA_LIST",
            entity_type="items",
            timestamp_path=["ts"],
            title_path=["name"],
            snippet_path=[],
        ),
        "beta": _recipe(
            toolkit="beta",
            slug="BETA_LIST",
            entity_type="items",
            timestamp_path=["ts"],
            title_path=["name"],
            snippet_path=[],
        ),
    }


@pytest.mark.asyncio
async def test_run_init_fanout(pool, user_ids, monkeypatch):
    """Fanout init: one task drives both subs — rows land per sub, each
    sub gets its own evolve task, ONE sync schedule for the aggregate."""
    user_a, _ = user_ids
    recipes = _fanout_recipes()
    monkeypatch.setattr(connector_ingest.ingest_runner, "load_recipe", lambda tk: recipes.get(tk))

    async def _fake_fetch(user, toolkit, cid, *, limit=100, since=None, pool=None):
        return [{"id": f"{toolkit}-1", "name": f"{toolkit} one", "ts": "2026-06-09T10:00:00Z"}]

    monkeypatch.setattr(connector_ingest.ingest_runner, "run_fetch", _fake_fetch)

    task_id = "init.gsuper.cid-9"
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id=task_id,
            kind="connector.init",
            payload={"toolkit": "gsuper", "connectedAccountId": "cid-9"},
            max_attempts=3,
            run_after=datetime.now(UTC) + timedelta(hours=6),
        )
    task = _make_task(
        user_a,
        {"toolkit": "gsuper", "connectedAccountId": "cid-9"},
        task_id=task_id,
    )
    await connector_ingest.run(pool, task, run_id="run_fanout")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT toolkit, external_id FROM pai_raw_events WHERE user_id=%s ORDER BY toolkit",
            (user_a,),
        )
        raw_rows = await cur.fetchall()
        cur = await conn.execute(
            "SELECT id, kind FROM pai_scheduled_tasks WHERE user_id=%s AND id != %s ORDER BY id",
            (user_a, task_id),
        )
        sched = {r["id"]: r["kind"] for r in await cur.fetchall()}
        cur = await conn.execute(
            "SELECT progress FROM pai_scheduled_tasks WHERE user_id=%s AND id=%s",
            (user_a, task_id),
        )
        progress = (await cur.fetchone())["progress"]

    assert [(r["toolkit"], r["external_id"]) for r in raw_rows] == [
        ("alpha", "alpha-1"),
        ("beta", "beta-1"),
    ]
    assert sched.get("evolve.alpha.cid-9") == "connector.evolve"
    assert sched.get("evolve.beta.cid-9") == "connector.evolve"
    assert sched.get("sync.gsuper.cid-9") == "connector.sync"
    assert "sync.alpha.cid-9" not in sched  # one schedule, fans out at fire
    assert progress["stage"] == "evolve"
    assert progress["perToolkit"]["alpha"]["rawInserted"] == 1
    assert progress["perToolkit"]["beta"]["rawInserted"] == 1


@pytest.mark.asyncio
async def test_run_sync_fanout_partial_failure(pool, user_ids, monkeypatch):
    """One sub's fetch failing must not sink the other: alpha ingests and
    advances its cursor; beta's cursor stays unset for re-pull."""
    user_a, _ = user_ids
    recipes = _fanout_recipes()
    monkeypatch.setattr(connector_ingest.ingest_runner, "load_recipe", lambda tk: recipes.get(tk))

    async def _fake_fetch(user, toolkit, cid, *, limit=100, since=None, pool=None):
        if toolkit == "beta":
            msg = "composio 500"
            raise RuntimeError(msg)
        return [{"id": "alpha-2", "name": "fresh", "ts": "2026-06-09T12:00:00Z"}]

    monkeypatch.setattr(connector_ingest.ingest_runner, "run_fetch", _fake_fetch)

    task_id = "sync.gsuper.cid-9"
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id=task_id,
            kind="connector.sync",
            payload={"toolkit": "gsuper", "connectedAccountId": "cid-9"},
            max_attempts=3,
            run_after=datetime.now(UTC) + timedelta(hours=6),
        )
    task = _make_task(
        user_a,
        {"toolkit": "gsuper", "connectedAccountId": "cid-9"},
        task_id=task_id,
        kind="connector.sync",
    )
    await connector_ingest.run(pool, task, run_id="run_fanout_sync")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT toolkit FROM pai_connector_sync_cursors "
            "WHERE user_id=%s AND connected_account_id='cid-9' ORDER BY toolkit",
            (user_a,),
        )
        cursor_toolkits = [r["toolkit"] for r in await cur.fetchall()]
        cur = await conn.execute(
            "SELECT progress FROM pai_scheduled_tasks WHERE user_id=%s AND id=%s",
            (user_a, task_id),
        )
        progress = (await cur.fetchone())["progress"]

    assert cursor_toolkits == ["alpha"]  # beta re-pulls next time
    assert progress["perToolkit"]["alpha"]["rawInserted"] == 1
    assert "error" in progress["perToolkit"]["beta"]


@pytest.mark.asyncio
async def test_run_sync_fanout_missing_sub_cursor_fetches_latest_page(pool, user_ids, monkeypatch):
    """When an existing aggregate connection gains a new fanout sub, that
    sub has no cursor. It should get the same latest-page pull as init,
    not a 24h incremental window."""
    user_a, _ = user_ids
    recipes = _fanout_recipes()
    monkeypatch.setattr(connector_ingest.ingest_runner, "load_recipe", lambda tk: recipes.get(tk))

    seen_since: dict[str, datetime | None] = {}

    async def _fake_fetch(user, toolkit, cid, *, limit=100, since=None, pool=None):
        seen_since[toolkit] = since
        return [{"id": f"{toolkit}-3", "name": "fresh", "ts": "2026-06-09T13:00:00Z"}]

    monkeypatch.setattr(connector_ingest.ingest_runner, "run_fetch", _fake_fetch)

    task_id = "sync.gsuper.cid-9"
    alpha_cursor = datetime(2026, 6, 9, 12, 0, tzinfo=UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        repo = connector_ingest.ConnectorsRepository(user_a, conn)
        await repo.set_cursor(
            toolkit="alpha",
            connected_account_id="cid-9",
            last_synced_at=alpha_cursor,
        )
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id=task_id,
            kind="connector.sync",
            payload={"toolkit": "gsuper", "connectedAccountId": "cid-9"},
            max_attempts=3,
            run_after=datetime.now(UTC) + timedelta(hours=6),
        )
    task = _make_task(
        user_a,
        {"toolkit": "gsuper", "connectedAccountId": "cid-9"},
        task_id=task_id,
        kind="connector.sync",
    )
    await connector_ingest.run(pool, task, run_id="run_fanout_sync_latest")

    assert seen_since["alpha"] == alpha_cursor
    assert seen_since["beta"] is None


@pytest.mark.asyncio
async def test_upsert_generic_user_scoping(pool, user_ids):
    """Reader-path scoping: the raw.py envelope query always filters
    user_id, so user_b's window over the same (toolkit, entity) must not
    see user_a's rows. (RLS itself doesn't fire under the test's
    table-owner connection — same convention as test_rls.py.)"""
    user_a, user_b = user_ids
    recipe = _recipe(timestamp_path=[], title_path=[], snippet_path=[])
    async with user_scoped_tx(pool, user_a) as conn:
        await generic_ingest.upsert_generic(
            conn, user_a, "foo", "items", recipe, [{"id": "a-only"}]
        )
    async with user_scoped_tx(pool, user_b) as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM pai_raw_events WHERE user_id=%s AND toolkit='foo'",
            (user_b,),
        )
        row = await cur.fetchone()
    assert row["n"] == 0
