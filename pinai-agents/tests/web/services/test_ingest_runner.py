"""ingest_runner unit tests.

Strategy: stub `composio_service.execute` so we can observe what args
get assembled from each recipe + cursor. No real Composio.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from pinai_agents.web import composio_service as cs
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.services import ingest_runner as ir


def _user(internal_id: int = 7) -> User:
    return User(
        id=internal_id,
        supabase_user_id=f"u-{internal_id}",
        email=None,
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


@pytest.fixture
def stub_execute(monkeypatch):
    """Replace cs.execute with a capture stub. Returns a list that
    the test can inspect. Each call appends (slug, args, cid)."""
    calls: list[tuple[str, dict, str | None]] = []

    async def fake_execute(user, slug, args, *, connected_account_id=None):
        calls.append((slug, args, connected_account_id))
        # Simulate Composio response based on slug — minimum viable
        # for recipes the tests touch.
        if slug == "CALENDLY_GET_USER":
            data = {"resource": {"uri": "https://api.calendly.com/users/u1"}}
        elif slug == "CALENDLY_LIST_SCHEDULED_EVENTS":
            data = {"collection": [{"uri": "evt-1"}, {"uri": "evt-2"}]}
        elif slug == "GMAIL_FETCH_EMAILS":
            data = {"messages": [{"messageId": "m1"}, {"messageId": "m2"}]}
        elif slug == "GOOGLECALENDAR_EVENTS_LIST":
            data = {"items": [{"id": "evt-1"}, {"id": "evt-2"}]}
        elif slug == "STRIPE_LIST_INVOICES":
            data = {"object": "list", "data": [{"id": "in_1"}]}
        elif slug == "LINKEDIN_GET_MY_INFO":
            data = {"id": "urn:li:person:abc", "headline": "PM"}
        else:
            data = {}
        return cs.ExecuteResult(slug=slug, successful=True, data=data)

    monkeypatch.setattr(cs, "execute", fake_execute)
    return calls


# ── Recipe loading ─────────────────────────────────────────────────────


def test_all_recipes_load():
    """All live yaml files parse into Recipe."""
    expected = {
        "calendly",
        "github",
        "gmail",
        "googlecalendar",
        "googledocs",
        "googledrive",
        "googlesheets",
        "googlesuper",
        "linkedin",
        "notion",
        "slack",
        "stripe",
        "youtube",
    }
    assert ir.supported_toolkits() == expected


def test_load_recipe_missing_returns_none():
    assert ir.load_recipe("nonexistent_toolkit") is None


def test_calendly_recipe_has_prereq():
    r = ir.load_recipe("calendly")
    assert r is not None
    assert len(r.prereqs) == 1
    pre = r.prereqs[0]
    assert pre.slug == "CALENDLY_GET_USER"
    assert pre.inject_arg == "user"
    assert pre.inject_path == ["resource", "uri"]


# ── since formatting ───────────────────────────────────────────────────


def test_format_since_iso():
    dt = datetime(2026, 5, 8, 12, 0, tzinfo=UTC)
    assert ir._format_since(dt, "iso").startswith("2026-05-08")


def test_format_since_gmail_query():
    dt = datetime(2026, 5, 8, 12, 0, tzinfo=UTC)
    expected_unix = int(dt.timestamp())
    assert ir._format_since(dt, "gmail_query") == f"after:{expected_unix}"


def test_format_since_gdrive_query():
    dt = datetime(2026, 5, 8, 12, 0, tzinfo=UTC)
    out = ir._format_since(dt, "gdrive_query")
    assert "modifiedTime > '2026-05-08T12:00:00" in out
    assert "trashed = false" in out


def test_format_since_slack_query():
    dt = datetime(2026, 5, 8, 12, 0, tzinfo=UTC)
    assert ir._format_since(dt, "slack_query") == "after:2026-05-08"


def test_format_since_unknown_raises():
    dt = datetime(2026, 5, 8, tzinfo=UTC)
    with pytest.raises(ValueError):
        ir._format_since(dt, "totally_made_up_format")


# ── _set_dotted ────────────────────────────────────────────────────────


def test_set_dotted_simple_key():
    target: dict = {}
    ir._set_dotted(target, "limit", 100)
    assert target == {"limit": 100}


def test_set_dotted_nested():
    target: dict = {"limit": 100}
    ir._set_dotted(target, "created.gte", 1234567890)
    assert target == {"limit": 100, "created": {"gte": 1234567890}}


def test_set_dotted_preserves_sibling():
    target: dict = {"created": {"lte": 999}}
    ir._set_dotted(target, "created.gte", 1234567890)
    assert target == {"created": {"lte": 999, "gte": 1234567890}}


# ── _walk_path ─────────────────────────────────────────────────────────


def test_walk_path_simple():
    payload = {"a": {"b": {"c": "found"}}}
    assert ir._walk_path(payload, ["a", "b", "c"]) == "found"


def test_walk_path_miss_returns_none():
    payload = {"a": {"b": 1}}
    assert ir._walk_path(payload, ["a", "x", "c"]) is None


def test_walk_path_empty_path_returns_payload():
    payload = [{"id": 1}]
    assert ir._walk_path(payload, []) is payload


# ── run_fetch ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_fetch_unknown_toolkit_returns_empty(stub_execute):
    items = await ir.run_fetch(_user(), "nonexistent", "ca_x")
    assert items == []
    assert stub_execute == []


@pytest.mark.asyncio
async def test_run_fetch_calendly_resolves_prereq(stub_execute):
    items = await ir.run_fetch(_user(), "calendly", "ca_cal")
    assert len(items) == 2
    # Two calls: GET_USER then LIST_SCHEDULED_EVENTS
    assert [c[0] for c in stub_execute] == [
        "CALENDLY_GET_USER",
        "CALENDLY_LIST_SCHEDULED_EVENTS",
    ]
    list_args = stub_execute[1][1]
    # Prereq inject: user URI from GET_USER response.
    assert list_args["user"] == "https://api.calendly.com/users/u1"


@pytest.mark.asyncio
async def test_run_fetch_gmail_uses_query_after_unix(stub_execute):
    since = datetime(2026, 5, 1, tzinfo=UTC)
    items = await ir.run_fetch(_user(), "gmail", "ca_gm", since=since)
    assert len(items) == 2
    args = stub_execute[0][1]
    assert args["query"] == f"after:{int(since.timestamp())}"
    assert args["max_results"] == 100  # from args_template
    # verbose=true is what makes Composio return the decoded full body
    # (messageText → body column); include_payload=false drops the giant
    # raw MIME payload that would otherwise 413 at ~100 msgs.
    assert args["verbose"] is True
    assert args["include_payload"] is False


@pytest.mark.asyncio
async def test_run_fetch_googlecalendar_uses_100_item_window(stub_execute):
    items = await ir.run_fetch(_user(), "googlecalendar", "ca_cal")
    assert len(items) == 2
    args = stub_execute[0][1]
    assert args["maxResults"] == 100


@pytest.mark.asyncio
async def test_run_fetch_stripe_uses_nested_dotted_filter(stub_execute):
    since = datetime(2026, 5, 1, tzinfo=UTC)
    items = await ir.run_fetch(_user(), "stripe", "ca_st", since=since)
    assert len(items) == 1
    args = stub_execute[0][1]
    # since_param "created.gte" → args["created"]["gte"]
    assert args["created"]["gte"] == int(since.timestamp())
    assert args["limit"] == 100


@pytest.mark.asyncio
async def test_run_fetch_linkedin_wraps_single_object(stub_execute):
    """LinkedIn returns a single profile dict; runner wraps as 1-item list."""
    items = await ir.run_fetch(_user(), "linkedin", "ca_li")
    assert len(items) == 1
    assert items[0]["headline"] == "PM"


@pytest.mark.asyncio
async def test_run_fetch_omits_since_when_recipe_has_no_param(stub_execute):
    """LinkedIn / YouTube / Twitter have since_param=null; runner must
    not invent an arg even if `since` is supplied."""
    since = datetime(2026, 5, 1, tzinfo=UTC)
    await ir.run_fetch(_user(), "linkedin", "ca_li", since=since)
    args = stub_execute[0][1]
    # No injection of any since-related arg.
    assert "since" not in args
    assert "after" not in args


@pytest.mark.asyncio
async def test_run_fetch_prereq_failure_short_circuits(stub_execute, monkeypatch):
    async def failing_execute(user, slug, args, *, connected_account_id=None):
        return cs.ExecuteResult(slug=slug, successful=False, error="auth")

    monkeypatch.setattr(cs, "execute", failing_execute)
    items = await ir.run_fetch(_user(), "calendly", "ca_cal")
    assert items == []
