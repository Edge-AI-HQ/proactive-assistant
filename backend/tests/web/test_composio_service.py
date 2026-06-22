"""composio_service unit tests.

Strategy: stub `composio_service._composio()` to return a mock SDK
client whose method calls we control. Tests are sync at the SDK
boundary because the SDK itself is sync; the service wraps via
`asyncio.to_thread`. No real Composio API calls.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from pinai_api.domains.connector.apps import composio_service as cs
from pinai_api.platform.auth.user_service import User


def _user(internal_id: int = 7, supabase_uuid: str | None = None) -> User:
    """Minimal User instance for service-layer tests.

    Default supabase_uuid is `u-{internal_id}` so test expectations stay
    readable (e.g. composio namespace becomes "pai-u-7"). Tests can pass
    an explicit UUID-shaped string when format matters."""
    return User(
        id=internal_id,
        supabase_user_id=supabase_uuid or f"u-{internal_id}",
        email=None,
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


@pytest.fixture(autouse=True)
def reset_caches():
    """Clear session cache between tests so leakage doesn't mask
    stale-state bugs. Identity is now persisted to pai_connector_labels
    (migration 040), no in-memory cache to reset."""
    cs._SESSION_REGISTRY.clear()
    yield
    cs._SESSION_REGISTRY.clear()


@pytest.fixture
def mock_sdk(monkeypatch):
    """Returns a MagicMock standing in for `composio.Composio()`. Test
    bodies set `.tools.execute.return_value` etc. to drive behavior."""
    sdk = MagicMock()
    monkeypatch.setattr(cs, "_composio", lambda: sdk)
    return sdk


# ── Identity helpers ────────────────────────────────────────────────────


def test_composio_user_id_namespace():
    """Namespace is derived from the Supabase UUID, not the BIGINT id —
    so it stays stable across env-specific SERIAL sequences. See
    AGENTS.md "用户标识规约"."""
    assert cs.composio_user_id(_user(42, "uuid-42")) == "pai-uuid-42"


def _account(
    *, cid: str, toolkit: str, status: str = "ACTIVE", user_info: dict | None = None
) -> MagicMock:
    """Build an SDK-style connected_account item with model_dump()."""
    obj = MagicMock()
    obj.model_dump.return_value = {
        "id": cid,
        "toolkit": {"slug": toolkit},
        "status": status,
        "user_info": user_info,
    }
    return obj


# ── list_connections ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_connections_empty(mock_sdk):
    mock_sdk.connected_accounts.list.return_value = SimpleNamespace(items=[])
    out = await cs.list_connections(_user(7))
    assert out == []


@pytest.mark.asyncio
async def test_list_connections_basic(mock_sdk):
    mock_sdk.connected_accounts.list.return_value = SimpleNamespace(
        items=[
            _account(cid="ca_1", toolkit="github"),
            _account(cid="ca_2", toolkit="slack"),
        ]
    )
    # No identity action for github/slack means identity stays None
    # unless cached. We disable identity in this test by clearing the
    # toolkit map.
    out = await cs.list_connections(_user(7))
    slugs = {c.toolkit for c in out}
    assert slugs == {"github", "slack"}
    assert all(c.connected_account_id.startswith("ca_") for c in out)


@pytest.mark.asyncio
async def test_list_connections_filters_by_user(mock_sdk):
    mock_sdk.connected_accounts.list.return_value = SimpleNamespace(items=[])
    await cs.list_connections(_user(123, "uuid-123"))
    call = mock_sdk.connected_accounts.list.call_args
    assert call.kwargs["user_ids"] == ["pai-uuid-123"]
    assert call.kwargs["statuses"] == ["ACTIVE"]


@pytest.mark.asyncio
async def test_list_connections_passes_inline_user_info(mock_sdk):
    """Pure SDK pass-through: user_info on the connected_account object
    (when Composio happens to populate it) is forwarded as-is. Label
    resolution + caching live in the route + repository, not here."""
    mock_sdk.connected_accounts.list.return_value = SimpleNamespace(
        items=[
            _account(cid="ca_1", toolkit="gmail", user_info={"emailAddress": "alice@example.com"}),
        ]
    )
    out = await cs.list_connections(_user(7))
    assert out[0].user_info == {"emailAddress": "alice@example.com"}
    # list_connections is pure SDK now — no extra identity action call.
    mock_sdk.tools.execute.assert_not_called()


@pytest.mark.asyncio
async def test_list_connections_no_identity_call(mock_sdk):
    """Regression: list_connections used to fire per-toolkit GET_PROFILE
    calls inline. Post-migration-040 it must not — the route joins
    pai_connector_labels itself. Re-introducing inline resolution would
    re-introduce the N-Composio-calls-per-page-load latency cliff."""
    mock_sdk.connected_accounts.list.return_value = SimpleNamespace(
        items=[
            _account(cid="ca_1", toolkit="gmail"),
        ]
    )
    await cs.list_connections(_user(7))
    mock_sdk.tools.execute.assert_not_called()


# ── Label extractors ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("toolkit", "raw", "expected"),
    [
        ("gmail", {"emailAddress": "boliang@pinai.io"}, "boliang@pinai.io"),
        ("gmail", {"email": "fallback@x.com"}, "fallback@x.com"),
        ("github", {"login": "boliangzhang"}, "boliangzhang"),
        (
            "calendly",
            {"resource": {"email": "user@example.com", "name": "User"}},
            "user@example.com",
        ),
        ("slack", {"user": {"email": "u@slack.com", "name": "slacker"}}, "u@slack.com"),
        (
            "googledrive",
            {"user": {"emailAddress": "g@drive.com", "displayName": "G"}},
            "g@drive.com",
        ),
        ("googlecalendar", {"id": "boliang@gmail.com", "summary": "boliang"}, "boliang@gmail.com"),
        (
            "youtube",
            {"items": [{"snippet": {"title": "MyChannel", "customUrl": "@mych"}}]},
            "@mych",
        ),
        ("youtube", {"items": [{"snippet": {"title": "MyChannel"}}]}, "MyChannel"),
        ("linkedin", {"name": {"first_name": "Boliang", "last_name": "Zhang"}}, "Boliang Zhang"),
    ],
)
def test_label_extractors(toolkit, raw, expected):
    spec = cs._IDENTITY_SPECS[toolkit]
    assert spec.extract(raw) == expected


def test_label_extractor_missing_fields_returns_none():
    # Empty / unexpected payload → extractor returns None; the
    # resolve_and_persist_label caller then writes None to DB and the
    # route surfaces fallback_label().
    for toolkit in ("gmail", "slack", "github", "googledrive", "googlecalendar", "youtube"):
        spec = cs._IDENTITY_SPECS[toolkit]
        assert spec.extract({}) is None


def test_fallback_label_stable_and_unique():
    assert cs.fallback_label("stripe", "ca_AbCdEf123456") == "stripe (...123456)"
    assert cs.fallback_label("stripe", "") == "stripe (...?)"
    # Different cids produce different fallbacks.
    a = cs.fallback_label("gmail", "ca_aaaaaa111111")
    b = cs.fallback_label("gmail", "ca_bbbbbb222222")
    assert a != b


def test_stripe_has_no_identity_spec():
    """Stripe's Composio catalog doesn't expose an account-retrieve action.
    Documented absence — resolve_and_persist_label takes the None-spec
    branch and writes a row with label=NULL so list_connections falls
    back to fallback_label() consistently."""
    assert "stripe" not in cs._IDENTITY_SPECS


# ── list_catalog ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_catalog_passes_search_and_category(mock_sdk):
    mock_sdk.client.toolkits.list.return_value = SimpleNamespace(
        items=[
            {
                "slug": "googledrive",
                "name": "Google Drive",
                "meta": {"categories": ["file management & storage"]},
                "auth_schemes": ["OAUTH2"],
            }
        ],
        next_cursor="next",
        total_count=1234,
    )

    out = await cs.list_catalog(
        category="file management & storage",
        query="drive",
        cursor="cursor-1",
        limit=40,
    )

    call = mock_sdk.client.toolkits.list.call_args
    assert call.kwargs["category"] == "file management & storage"
    assert call.kwargs["search"] == "drive"
    assert call.kwargs["cursor"] == "cursor-1"
    assert call.kwargs["limit"] == 40.0
    assert out.items[0].slug == "googledrive"
    assert out.next_cursor == "next"
    assert out.total_count == 1234


# ── search_tools ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_tools_maps_fields(mock_sdk):
    raw_tool = SimpleNamespace(
        slug="GMAIL_FETCH_EMAILS",
        toolkit={"slug": "gmail"},
        name="Fetch Emails",
        description="Fetch recent Gmail messages.",
        tags=["read", "important"],
    )
    mock_sdk.tools.get_raw_composio_tools.return_value = [raw_tool]
    out = await cs.search_tools(_user(7), "recent emails", toolkit="gmail", limit=5)
    assert len(out) == 1
    hit = out[0]
    assert hit.slug == "GMAIL_FETCH_EMAILS"
    assert hit.toolkit == "gmail"
    assert hit.name == "Fetch Emails"
    assert "read" in hit.tags

    call = mock_sdk.tools.get_raw_composio_tools.call_args
    assert call.kwargs["search"] == "recent emails"
    assert call.kwargs["toolkits"] == ["gmail"]
    assert call.kwargs["limit"] == 5


@pytest.mark.asyncio
async def test_search_tools_skips_slugless(mock_sdk):
    """Defensive: SDK occasionally returns partial entries; drop them
    rather than emit ToolHits with empty slugs."""
    bad = SimpleNamespace(slug=None, toolkit={"slug": "gmail"}, name="x", description="x", tags=[])
    mock_sdk.tools.get_raw_composio_tools.return_value = [bad]
    out = await cs.search_tools(_user(7), "anything")
    assert out == []


# ── get_tool_schema ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_tool_schema_maps_fields(mock_sdk):
    raw = SimpleNamespace(
        slug="GMAIL_FETCH_EMAILS",
        toolkit={"slug": "gmail"},
        name="Fetch Emails",
        description="d",
        input_parameters={"properties": {"max_results": {"type": "integer"}}},
        output_parameters={"properties": {"messages": {"type": "array"}}},
        tags=["read"],
        scopes=["gmail.readonly"],
    )
    mock_sdk.tools.get_raw_composio_tool_by_slug.return_value = raw
    schema = await cs.get_tool_schema("GMAIL_FETCH_EMAILS")
    assert schema.slug == "GMAIL_FETCH_EMAILS"
    assert schema.toolkit == "gmail"
    assert "max_results" in schema.input_schema["properties"]
    assert schema.scopes == ["gmail.readonly"]


@pytest.mark.asyncio
async def test_get_tool_schema_404(mock_sdk):
    mock_sdk.tools.get_raw_composio_tool_by_slug.return_value = None
    with pytest.raises(cs.ComposioError) as exc:
        await cs.get_tool_schema("NONEXISTENT")
    assert exc.value.status_code == 404


# ── execute / multi_execute ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_execute_success(mock_sdk):
    resp = MagicMock()
    resp.model_dump.return_value = {
        "successful": True,
        "data": {"messages": [{"id": "m1"}]},
        "error": None,
    }
    mock_sdk.tools.execute.return_value = resp
    result = await cs.execute(_user(7), "GMAIL_FETCH_EMAILS", {"max_results": 10})
    assert result.successful is True
    assert result.data == {"messages": [{"id": "m1"}]}
    assert result.error is None

    call = mock_sdk.tools.execute.call_args
    assert call.args == ("GMAIL_FETCH_EMAILS", {"max_results": 10})
    assert call.kwargs["user_id"] == "pai-u-7"


@pytest.mark.asyncio
async def test_execute_with_connected_account_id(mock_sdk):
    """Multi-account: caller pins which connected_account_id."""
    resp = MagicMock()
    resp.model_dump.return_value = {"successful": True, "data": {}}
    mock_sdk.tools.execute.return_value = resp
    await cs.execute(_user(7), "GMAIL_FETCH_EMAILS", {}, connected_account_id="ca_42")
    call = mock_sdk.tools.execute.call_args
    assert call.kwargs["connected_account_id"] == "ca_42"


@pytest.mark.asyncio
async def test_execute_captures_error(mock_sdk):
    """SDK error is captured into ExecuteResult.error, not raised."""
    from composio.exceptions import HTTPError as SdkHTTP

    mock_sdk.tools.execute.side_effect = SdkHTTP("Bad Request", status_code=400)
    result = await cs.execute(_user(7), "BAD_SLUG", {})
    assert result.successful is False
    assert result.error and "400" in result.error


@pytest.mark.asyncio
async def test_multi_execute_preserves_order(mock_sdk):
    counter = {"n": 0}

    def _exec(slug, args, **kwargs):
        counter["n"] += 1
        r = MagicMock()
        r.model_dump.return_value = {
            "successful": True,
            "data": {"slug": slug},
        }
        return r

    mock_sdk.tools.execute.side_effect = _exec
    calls = [
        cs.ExecuteCall(slug="A", args={"i": 1}),
        cs.ExecuteCall(slug="B", args={"i": 2}),
        cs.ExecuteCall(slug="C", args={"i": 3}),
    ]
    out = await cs.multi_execute(_user(7), calls)
    assert [r.slug for r in out] == ["A", "B", "C"]
    assert counter["n"] == 3


@pytest.mark.asyncio
async def test_multi_execute_partial_failure(mock_sdk):
    """One call's failure does not block the others."""
    from composio.exceptions import HTTPError as SdkHTTP

    def _exec(slug, args, **kwargs):
        if slug == "B":
            raise SdkHTTP("upstream broken", status_code=502)
        r = MagicMock()
        r.model_dump.return_value = {"successful": True, "data": {}}
        return r

    mock_sdk.tools.execute.side_effect = _exec
    out = await cs.multi_execute(
        _user(7),
        [
            cs.ExecuteCall(slug="A"),
            cs.ExecuteCall(slug="B"),
            cs.ExecuteCall(slug="C"),
        ],
    )
    assert [r.successful for r in out] == [True, False, True]
    assert "upstream broken" in out[1].error


# ── connect / disconnect ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_connect_uses_existing_auth_config(mock_sdk):
    mock_sdk.auth_configs.list.return_value = SimpleNamespace(
        items=[SimpleNamespace(model_dump=lambda: {"id": "ac_existing"})],
    )
    mock_sdk.connected_accounts.link.return_value = SimpleNamespace(
        id="ca_new",
        redirect_url="https://oauth/...",
    )
    init = await cs.connect(_user(7), "gmail")
    assert init.connected_account_id == "ca_new"
    assert init.redirect_url == "https://oauth/..."
    mock_sdk.auth_configs.create.assert_not_called()
    call = mock_sdk.connected_accounts.link.call_args
    assert call.kwargs["user_id"] == "pai-u-7"
    assert call.kwargs["auth_config_id"] == "ac_existing"


@pytest.mark.asyncio
async def test_connect_creates_auth_config_when_missing(mock_sdk):
    mock_sdk.auth_configs.list.return_value = SimpleNamespace(items=[])
    mock_sdk.auth_configs.create.return_value = SimpleNamespace(
        model_dump=lambda: {"id": "ac_new"},
    )
    mock_sdk.connected_accounts.link.return_value = SimpleNamespace(
        id="ca_new",
        redirect_url="https://oauth/...",
    )
    init = await cs.connect(_user(7), "gmail")
    assert init.connected_account_id == "ca_new"
    mock_sdk.auth_configs.create.assert_called_once()


@pytest.mark.asyncio
async def test_connect_rejects_empty_toolkit(mock_sdk):
    with pytest.raises(ValueError):
        await cs.connect(_user(7), "")


@pytest.mark.asyncio
async def test_disconnect_calls_sdk_delete(mock_sdk):
    """disconnect() at the service layer only revokes via SDK. The
    pai_connector_labels row cleanup happens in the route via
    delete_label() — it needs the pool dep + RLS scoping."""
    await cs.disconnect("ca_1")
    mock_sdk.connected_accounts.delete.assert_called_once_with("ca_1")


# ── session pool ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_or_create_session_caches_per_user(mock_sdk):
    sess_a = MagicMock(name="session_a")
    sess_b = MagicMock(name="session_b")
    mock_sdk.create.side_effect = [sess_a, sess_b]

    s1 = await cs.get_or_create_session(_user(7))
    s2 = await cs.get_or_create_session(_user(7))
    assert s1 is s2
    assert mock_sdk.create.call_count == 1

    # Different user → different session.
    s3 = await cs.get_or_create_session(_user(8))
    assert s3 is sess_b
    assert mock_sdk.create.call_count == 2


@pytest.mark.asyncio
async def test_get_or_create_session_cache_keys_on_config(mock_sdk):
    """Different toolkits / tools allowlists → separate cached sessions."""
    sess_a = MagicMock()
    sess_b = MagicMock()
    mock_sdk.create.side_effect = [sess_a, sess_b]

    s1 = await cs.get_or_create_session(_user(7), toolkits=["gmail"])
    s2 = await cs.get_or_create_session(_user(7), toolkits=["github"])
    assert s1 is sess_a
    assert s2 is sess_b
    assert s1 is not s2


@pytest.mark.asyncio
async def test_execute_meta_tool_forwards_to_session(mock_sdk):
    sess = MagicMock()
    resp = MagicMock()
    resp.model_dump.return_value = {"data": {"hits": []}}
    sess.execute.return_value = resp
    mock_sdk.create.return_value = sess

    out = await cs.execute_meta_tool(
        _user(7), "COMPOSIO_SEARCH_TOOLS", {"queries": [{"use_case": "x"}]}
    )
    assert out == {"data": {"hits": []}}
    sess.execute.assert_called_once_with(
        "COMPOSIO_SEARCH_TOOLS",
        arguments={"queries": [{"use_case": "x"}]},
    )


@pytest.mark.asyncio
async def test_evict_session_clears_user_only(mock_sdk):
    mock_sdk.create.side_effect = [MagicMock(), MagicMock()]
    await cs.get_or_create_session(_user(7))
    await cs.get_or_create_session(_user(8))
    assert len(cs._SESSION_REGISTRY) == 2
    await cs.evict_session(_user(7))
    keys = list(cs._SESSION_REGISTRY)
    assert all(not k.startswith("u-7:") for k in keys)
    assert any(k.startswith("u-8:") for k in keys)
