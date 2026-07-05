from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pinai_db.rls import user_scoped_tx
from pinai_reward_dashboard.personal_data_snapshot import (
    REDACTED_SECRET,
    PersonalDataSnapshotService,
    _item,
)


def test_item_redacts_sensitive_payload_values() -> None:
    out = _item(
        {
            "item_id": "connector_1",
            "category": "connectors",
            "source_key": "composio",
            "source_label": "Composio",
            "title": "Gmail connector",
            "payload": {
                "accessToken": "secret-access-token",
                "api_key": "secret-api-key",
                "nested": {
                    "clientSecret": "secret-client-secret",
                    "publicLabel": "visible label",
                },
            },
        }
    )

    assert out["payload"] == {
        "accessToken": REDACTED_SECRET,
        "api_key": REDACTED_SECRET,
        "nested": {
            "clientSecret": REDACTED_SECRET,
            "publicLabel": "visible label",
        },
    }


def test_item_redacts_sensitive_name_value_pairs() -> None:
    out = _item(
        {
            "item_id": "connector_1",
            "category": "connectors",
            "source_key": "composio",
            "source_label": "Composio",
            "title": "Gmail connector",
            "payload": {
                "headers": [
                    {
                        "name": "Authorization",
                        "value": "Bearer secret-access-token",
                    },
                    {
                        "headerName": "X-Refresh-Token",
                        "rawValue": "secret-raw-token",
                    },
                    {
                        "name": "X-Public-Label",
                        "value": "visible label",
                    },
                ],
                "authPair": {
                    "name": "sb-refresh-token",
                    "value": "secret-refresh-token",
                },
            },
        }
    )

    assert out["payload"]["headers"] == [
        {
            "name": "Authorization",
            "value": REDACTED_SECRET,
        },
        {
            "headerName": "X-Refresh-Token",
            "rawValue": REDACTED_SECRET,
        },
        {
            "name": "X-Public-Label",
            "value": "visible label",
        },
    ]
    assert out["payload"]["authPair"] == {
        "name": "sb-refresh-token",
        "value": REDACTED_SECRET,
    }


# ── DB-backed: the four sections migrated off the retired tables now read the
# new lifelong-memory architecture (pai_user_settings identity + pai_user_strings
# portrait + pai_events). These exercise the real SQL against Postgres. ──


async def _seed_profile(conn, user_id: int) -> None:
    # Identity now lives in pai_user_settings (timezone via 113,
    # generation_language as the locale successor); pai_profile is retired (114).
    await conn.execute(
        """
        INSERT INTO pai_user_settings (user_id, generation_language, timezone)
        VALUES (%s, 'en-US', 'Europe/London')
        ON CONFLICT (user_id) DO UPDATE
          SET generation_language = EXCLUDED.generation_language,
              timezone = EXCLUDED.timezone
        """,
        (user_id,),
    )


async def _seed_user_strings(conn, user_id: int) -> None:
    await conn.execute(
        """
        INSERT INTO pai_user_strings (user_id, slot, content, version)
        VALUES
          (%s, 'USER', '§ Founder; meets investor Alex on Thursdays.', 3),
          (%s, 'GOALS', '§ Ship the lifelong-memory rebuild this quarter.', 2)
        """,
        (user_id, user_id),
    )


async def _seed_events(conn, user_id: int) -> None:
    await conn.execute(
        """
        INSERT INTO pai_events
          (user_id, id, source, event_type, occurred_at, title, body,
           curated_at, superseded_by_id, dedupe_key)
        VALUES
          (%s, 'ev_meeting', 'composio', 'meeting',
           %s, 'Investor meeting Thursday', 'Confirm 4pm with Alex',
           now(), NULL, 'dk_meeting'),
          (%s, 'ev_move', 'device', 'movement',
           %s, 'Arrived at office', 'Geofence enter HQ',
           NULL, NULL, 'dk_move'),
          (%s, 'ev_filtered', 'composio', 'communication',
           %s, 'HuggingFace Daily Papers', 'this week''s papers',
           now(), 'ev_filtered__sup', 'dk_filtered')
        """,
        (
            user_id,
            datetime(2026, 6, 20, 10, 0, tzinfo=UTC),
            user_id,
            datetime(2026, 6, 20, 9, 0, tzinfo=UTC),
            user_id,
            datetime(2026, 6, 20, 11, 0, tzinfo=UTC),
        ),
    )


@pytest.mark.asyncio
async def test_profile_section_reads_identity_and_portrait(pool, user_ids) -> None:
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await _seed_profile(conn, user_a)
        await _seed_user_strings(conn, user_a)
        snap = await PersonalDataSnapshotService(conn, user_a).snapshot(category="profile")

    section = snap["sections"][0]
    assert section["key"] == "profile"
    assert section["total"] == 1
    item = section["items"][0]
    # display_name has no new home post-pai_profile; the section title is static.
    assert item["title"] == "用户画像"
    assert item["subtitle"] == "en-US · Europe/London"
    # persona now comes from the USER markdown slot, not pai_profile columns
    assert "investor Alex" in (item["summary"] or "")
    assert item["payload"]["portrait_user"] == "§ Founder; meets investor Alex on Thursdays."
    assert item["payload"]["portrait_version"] == 3
    assert item["payload"]["locale"] == "en-US"


@pytest.mark.asyncio
async def test_goals_section_reads_portrait_goals_slot(pool, user_ids) -> None:
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await _seed_user_strings(conn, user_a)
        snap = await PersonalDataSnapshotService(conn, user_a).snapshot(category="goals")

    section = snap["sections"][0]
    assert section["key"] == "goals"
    assert section["total"] == 1
    item = section["items"][0]
    assert item["title"] == "长期目标"
    assert "lifelong-memory rebuild" in (item["summary"] or "")
    assert item["payload"]["slot"] == "GOALS"
    assert item["payload"]["version"] == 2


@pytest.mark.asyncio
async def test_memory_section_reads_events_excluding_superseded(pool, user_ids) -> None:
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await _seed_events(conn, user_a)
        snap = await PersonalDataSnapshotService(conn, user_a).snapshot(category="memory")

    section = snap["sections"][0]
    assert section["key"] == "memory"
    # live rows visible (curated + uncurated), superseded hidden → 2 of 3 seeded
    assert section["total"] == 2
    titles = {item["title"] for item in section["items"]}
    assert titles == {"Investor meeting Thursday", "Arrived at office"}
    assert "HuggingFace Daily Papers" not in titles
    # ordered by occurred_at DESC: meeting (10:00) before movement (09:00)
    meeting = section["items"][0]
    assert meeting["title"] == "Investor meeting Thursday"
    assert meeting["kind"] == "meeting"
    assert meeting["status"] == "curated"  # curated_at non-NULL → "curated"
    assert meeting["score"] == pytest.approx(0.0)  # score = reference_count (unreferenced yet)
    assert meeting["payload"]["event_type"] == "meeting"
    assert meeting["payload"]["source"] == "composio"


@pytest.mark.asyncio
async def test_signals_section_reads_device_events_only(pool, user_ids) -> None:
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await _seed_events(conn, user_a)
        snap = await PersonalDataSnapshotService(conn, user_a).snapshot(category="signals")

    section = snap["sections"][0]
    assert section["key"] == "signals"
    # only source='device' (the movement event); composio events excluded
    assert section["total"] == 1
    item = section["items"][0]
    assert item["title"] == "Arrived at office"
    assert item["payload"]["source"] == "device"
    assert item["kind"] == "movement"


@pytest.mark.asyncio
async def test_memory_section_query_filters_events(pool, user_ids) -> None:
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await _seed_events(conn, user_a)
        snap = await PersonalDataSnapshotService(conn, user_a).snapshot(
            category="memory", query="investor"
        )

    section = snap["sections"][0]
    assert section["total"] == 1
    assert section["items"][0]["title"] == "Investor meeting Thursday"
