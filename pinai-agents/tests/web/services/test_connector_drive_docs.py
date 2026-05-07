"""gdrive + gdocs connectors — extractor / mapper / DB round-trip.

Both share Drive metadata semantics (owners[].emailAddress,
modifiedTime, mime/web links). gdocs is technically a Drive subset
filtered to docs; tests pin the field shape distinctions.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from pinai_agents.web.db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    enqueue_once,
)
from pinai_agents.web.db.rls import service_tx, user_scoped_tx
from pinai_agents.web.services import connector_ingest


def test_flatten_drive_owners_prefers_email():
    raw = {"owners": [
        {"emailAddress": "alice@x.com", "displayName": "Alice"},
        {"displayName": "Bob"},
        {"emailAddress": ""},  # empty email skipped
        {},
    ]}
    out = connector_ingest._flatten_drive_owners(raw)
    assert out == ["alice@x.com", "Bob"]


def test_flatten_drive_last_modifying_user():
    assert connector_ingest._flatten_drive_last_modifying_user(
        {"lastModifyingUser": {"emailAddress": "u@x.com"}},
    ) == "u@x.com"
    assert connector_ingest._flatten_drive_last_modifying_user(
        {"lastModifyingUser": {"displayName": "Carol"}},
    ) == "Carol"
    assert connector_ingest._flatten_drive_last_modifying_user({}) is None


# ── gdrive mapper ───────────────────────────────────────────────────────


def test_map_gdrive_file_basic():
    raw = {
        "id": "1abc",
        "name": "design.pdf",
        "mimeType": "application/pdf",
        "modifiedTime": "2026-04-15T10:00:00Z",
        "createdTime": "2026-04-01T00:00:00Z",
        "size": "12345",  # Drive returns size as string
        "webViewLink": "https://drive.google.com/file/d/1abc",
        "owners": [{"emailAddress": "alice@x.com"}],
    }
    mapped = connector_ingest._map_gdrive_file(raw)
    assert mapped is not None
    assert mapped["file_id"] == "1abc"
    assert mapped["name"] == "design.pdf"
    assert mapped["mime_type"] == "application/pdf"
    assert mapped["size_bytes"] == 12345
    assert mapped["owners"] == ["alice@x.com"]
    assert mapped["modified_time"].year == 2026
    assert mapped["occurred_at"] == mapped["modified_time"]


def test_map_gdrive_file_handles_int_size():
    mapped = connector_ingest._map_gdrive_file({"id": "x", "size": 99})
    assert mapped is not None
    assert mapped["size_bytes"] == 99


def test_map_gdrive_file_unparseable_size_is_none():
    mapped = connector_ingest._map_gdrive_file({"id": "x", "size": "abc"})
    assert mapped is not None
    assert mapped["size_bytes"] is None


def test_map_gdrive_file_returns_none_without_id():
    assert connector_ingest._map_gdrive_file({"name": "no id"}) is None


def test_extract_drive_files_unwraps_files_key():
    response = {"data": {"files": [{"id": "1"}, {"id": "2"}]}}
    out = connector_ingest._extract_drive_files(response)
    assert len(out) == 2


# ── gdocs mapper ────────────────────────────────────────────────────────


def test_map_gdocs_document_basic():
    raw = {
        "id": "doc-1",
        "name": "spec.gdoc",
        "modifiedTime": "2026-04-15T12:00:00Z",
        "createdTime": "2026-04-01T00:00:00Z",
        "webViewLink": "https://docs.google.com/document/d/doc-1",
        "owners": [{"emailAddress": "owner@x.com"}],
        "lastModifyingUser": {"emailAddress": "editor@x.com"},
        "starred": True,
        "shared": True,
    }
    mapped = connector_ingest._map_gdocs_document(raw)
    assert mapped is not None
    assert mapped["document_id"] == "doc-1"
    assert mapped["owners"] == ["owner@x.com"]
    assert mapped["last_modifying_user"] == "editor@x.com"
    assert mapped["starred"] is True
    assert mapped["shared"] is True
    assert mapped["modified_time"].year == 2026


def test_extract_gdocs_documents_composio_documents_key():
    """Composio wraps under data.documents per plugin notes."""
    response = {"data": {"documents": [{"id": "d1"}]}}
    out = connector_ingest._extract_gdocs_documents(response)
    assert out == [{"id": "d1"}]


def test_extract_gdocs_documents_raw_drive_files_fallback():
    response = {"data": {"files": [{"id": "f1"}]}}
    out = connector_ingest._extract_gdocs_documents(response)
    assert out == [{"id": "f1"}]


def test_map_gdocs_document_returns_none_without_id():
    assert connector_ingest._map_gdocs_document({"name": "no id"}) is None


# ── DB round-trip: gdrive sync mutates row on second fire ──────────────


def _sync_task(toolkit: str, user_id: int, cid: str) -> ScheduledTaskRow:
    return ScheduledTaskRow(
        user_id=user_id,
        id=f"sync.{toolkit}.{cid}",
        kind="connector.sync",
        name=None, prompt=None,
        trigger_kind="schedule", cron_expr="*/30 * * * *",
        interval_seconds=None, event_filter=None,
        payload={"toolkit": toolkit, "connectedAccountId": cid},
        timezone="UTC", status="active",
        next_run_at=None, last_run_at=datetime.now(UTC),
        last_run_status="dispatched", run_count=1,
        attempts=0, max_attempts=3, progress={}, last_error=None,
    )


def _patch_fetch(monkeypatch, toolkit: str, items_box: dict):
    real = connector_ingest._ADAPTERS[toolkit]

    async def fake_fetch(api_key, cx_user_id, cid, limit, since):
        return list(items_box["items"])

    monkeypatch.setitem(
        connector_ingest._ADAPTERS, toolkit,
        connector_ingest.ToolkitAdapter(
            toolkit=toolkit, raw_table=real.raw_table,
            fetch=fake_fetch, upsert=real.upsert,
        ),
    )
    monkeypatch.setattr(
        connector_ingest, "get_web_settings",
        lambda: SimpleNamespace(composio_api_key="test-key"),
    )


@pytest.mark.asyncio
async def test_gdrive_sync_renames_file_in_place(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    box = {"items": [
        {
            "id": "f-X",
            "name": "draft.pdf",
            "modifiedTime": "2026-04-01T00:00:00Z",
            "owners": [{"emailAddress": "a@x.com"}],
        },
    ]}
    _patch_fetch(monkeypatch, "googledrive", box)

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn, user_id=user_a, task_id="sync.googledrive.cidGD",
            kind="connector.sync",
            payload={"toolkit": "googledrive", "connectedAccountId": "cidGD"},
        )

    await connector_ingest.run(pool, _sync_task("googledrive", user_a, "cidGD"), "rd1")

    box["items"] = [
        {
            "id": "f-X",
            "name": "final.pdf",  # renamed
            "modifiedTime": "2026-04-20T00:00:00Z",
            "owners": [{"emailAddress": "a@x.com"}],
        },
    ]
    await connector_ingest.run(pool, _sync_task("googledrive", user_a, "cidGD"), "rd2")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT name FROM pai_raw_gdrive_files WHERE user_id = %s",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["name"] == "final.pdf"


@pytest.mark.asyncio
async def test_gdocs_sync_writes_doc(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    box = {"items": [
        {
            "id": "doc-A",
            "name": "RFC 0001",
            "modifiedTime": "2026-04-15T00:00:00Z",
            "owners": [{"displayName": "Alice"}],
        },
    ]}
    _patch_fetch(monkeypatch, "googledocs", box)

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn, user_id=user_a, task_id="sync.googledocs.cidGOD",
            kind="connector.sync",
            payload={"toolkit": "googledocs", "connectedAccountId": "cidGOD"},
        )

    await connector_ingest.run(pool, _sync_task("googledocs", user_a, "cidGOD"), "rdoc1")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT document_id, name, owners FROM pai_raw_gdocs_documents "
            "WHERE user_id = %s",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["document_id"] == "doc-A"
    assert rows[0]["owners"] == ["Alice"]


@pytest.mark.asyncio
async def test_drive_docs_registered():
    assert "googledrive" in connector_ingest.supported_toolkits()
    assert "googledocs" in connector_ingest.supported_toolkits()
