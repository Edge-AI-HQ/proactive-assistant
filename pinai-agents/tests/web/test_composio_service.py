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

from pinai_agents.web import composio_service as cs


@pytest.fixture(autouse=True)
def reset_caches():
    """Clear identity + session caches between tests so leakage doesn't
    mask stale-state bugs. Module-level state is the trade-off for
    singleton patterns."""
    cs._identity_cache.clear()
    cs._SESSION_REGISTRY.clear()
    yield
    cs._identity_cache.clear()
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
    assert cs.composio_user_id(42) == "pai-42"


def _account(*, cid: str, toolkit: str, status: str = "ACTIVE",
             user_info: dict | None = None) -> MagicMock:
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
    out = await cs.list_connections(7)
    assert out == []


@pytest.mark.asyncio
async def test_list_connections_basic(mock_sdk):
    mock_sdk.connected_accounts.list.return_value = SimpleNamespace(items=[
        _account(cid="ca_1", toolkit="github"),
        _account(cid="ca_2", toolkit="slack"),
    ])
    # No identity action for github/slack means identity stays None
    # unless cached. We disable identity in this test by clearing the
    # toolkit map.
    out = await cs.list_connections(7)
    slugs = {c.toolkit for c in out}
    assert slugs == {"github", "slack"}
    assert all(c.connected_account_id.startswith("ca_") for c in out)


@pytest.mark.asyncio
async def test_list_connections_filters_by_user(mock_sdk):
    mock_sdk.connected_accounts.list.return_value = SimpleNamespace(items=[])
    await cs.list_connections(123)
    call = mock_sdk.connected_accounts.list.call_args
    assert call.kwargs["user_ids"] == ["pai-123"]
    assert call.kwargs["statuses"] == ["ACTIVE"]


@pytest.mark.asyncio
async def test_list_connections_uses_inline_user_info(mock_sdk, monkeypatch):
    """user_info already on the response should not trigger an extra
    GET_PROFILE call."""
    monkeypatch.setattr(cs, "_IDENTITY_ACTIONS", {"gmail": "GMAIL_GET_PROFILE"})
    mock_sdk.connected_accounts.list.return_value = SimpleNamespace(items=[
        _account(cid="ca_1", toolkit="gmail",
                 user_info={"emailAddress": "alice@example.com"}),
    ])
    out = await cs.list_connections(7)
    assert out[0].user_info == {"emailAddress": "alice@example.com"}
    mock_sdk.tools.execute.assert_not_called()


@pytest.mark.asyncio
async def test_list_connections_resolves_identity_when_missing(mock_sdk, monkeypatch):
    monkeypatch.setattr(cs, "_IDENTITY_ACTIONS", {"gmail": "GMAIL_GET_PROFILE"})
    mock_sdk.connected_accounts.list.return_value = SimpleNamespace(items=[
        _account(cid="ca_1", toolkit="gmail"),
    ])
    profile_resp = MagicMock()
    profile_resp.model_dump.return_value = {
        "data": {"emailAddress": "bob@x.com"},
    }
    mock_sdk.tools.execute.return_value = profile_resp
    out = await cs.list_connections(7)
    assert out[0].user_info == {"emailAddress": "bob@x.com"}

    # Second call must hit the cache (no extra execute).
    mock_sdk.tools.execute.reset_mock()
    await cs.list_connections(7)
    mock_sdk.tools.execute.assert_not_called()


@pytest.mark.asyncio
async def test_list_connections_drops_stale_cache(mock_sdk, monkeypatch):
    """When a previously-active account is no longer in the list, its
    identity cache entry is dropped."""
    monkeypatch.setattr(cs, "_IDENTITY_ACTIONS", {"gmail": "GMAIL_GET_PROFILE"})
    mock_sdk.connected_accounts.list.return_value = SimpleNamespace(items=[
        _account(cid="ca_1", toolkit="gmail"),
    ])
    profile_resp = MagicMock()
    profile_resp.model_dump.return_value = {"data": {"emailAddress": "x@y"}}
    mock_sdk.tools.execute.return_value = profile_resp
    await cs.list_connections(7)
    assert "ca_1" in cs._identity_cache

    # Second list returns no accounts → cache for ca_1 should drop.
    mock_sdk.connected_accounts.list.return_value = SimpleNamespace(items=[])
    await cs.list_connections(7)
    assert "ca_1" not in cs._identity_cache


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
    out = await cs.search_tools(7, "recent emails", toolkit="gmail", limit=5)
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
    bad = SimpleNamespace(slug=None, toolkit={"slug": "gmail"},
                          name="x", description="x", tags=[])
    mock_sdk.tools.get_raw_composio_tools.return_value = [bad]
    out = await cs.search_tools(7, "anything")
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
    result = await cs.execute(7, "GMAIL_FETCH_EMAILS", {"max_results": 10})
    assert result.successful is True
    assert result.data == {"messages": [{"id": "m1"}]}
    assert result.error is None

    call = mock_sdk.tools.execute.call_args
    assert call.args == ("GMAIL_FETCH_EMAILS", {"max_results": 10})
    assert call.kwargs["user_id"] == "pai-7"


@pytest.mark.asyncio
async def test_execute_with_connected_account_id(mock_sdk):
    """Multi-account: caller pins which connected_account_id."""
    resp = MagicMock()
    resp.model_dump.return_value = {"successful": True, "data": {}}
    mock_sdk.tools.execute.return_value = resp
    await cs.execute(7, "GMAIL_FETCH_EMAILS", {}, connected_account_id="ca_42")
    call = mock_sdk.tools.execute.call_args
    assert call.kwargs["connected_account_id"] == "ca_42"


@pytest.mark.asyncio
async def test_execute_captures_error(mock_sdk):
    """SDK error is captured into ExecuteResult.error, not raised."""
    from composio.exceptions import HTTPError as SdkHTTP
    mock_sdk.tools.execute.side_effect = SdkHTTP("Bad Request", status_code=400)
    result = await cs.execute(7, "BAD_SLUG", {})
    assert result.successful is False
    assert result.error and "400" in result.error


@pytest.mark.asyncio
async def test_multi_execute_preserves_order(mock_sdk):
    counter = {"n": 0}

    def _exec(slug, args, **kwargs):
        counter["n"] += 1
        r = MagicMock()
        r.model_dump.return_value = {
            "successful": True, "data": {"slug": slug},
        }
        return r

    mock_sdk.tools.execute.side_effect = _exec
    calls = [
        cs.ExecuteCall(slug="A", args={"i": 1}),
        cs.ExecuteCall(slug="B", args={"i": 2}),
        cs.ExecuteCall(slug="C", args={"i": 3}),
    ]
    out = await cs.multi_execute(7, calls)
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
    out = await cs.multi_execute(7, [
        cs.ExecuteCall(slug="A"), cs.ExecuteCall(slug="B"),
        cs.ExecuteCall(slug="C"),
    ])
    assert [r.successful for r in out] == [True, False, True]
    assert "upstream broken" in out[1].error


# ── connect / disconnect ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_connect_uses_existing_auth_config(mock_sdk):
    mock_sdk.auth_configs.list.return_value = SimpleNamespace(
        items=[SimpleNamespace(model_dump=lambda: {"id": "ac_existing"})],
    )
    mock_sdk.connected_accounts.link.return_value = SimpleNamespace(
        id="ca_new", redirect_url="https://oauth/...",
    )
    init = await cs.connect(7, "gmail")
    assert init.connected_account_id == "ca_new"
    assert init.redirect_url == "https://oauth/..."
    mock_sdk.auth_configs.create.assert_not_called()
    call = mock_sdk.connected_accounts.link.call_args
    assert call.kwargs["user_id"] == "pai-7"
    assert call.kwargs["auth_config_id"] == "ac_existing"


@pytest.mark.asyncio
async def test_connect_creates_auth_config_when_missing(mock_sdk):
    mock_sdk.auth_configs.list.return_value = SimpleNamespace(items=[])
    mock_sdk.auth_configs.create.return_value = SimpleNamespace(
        model_dump=lambda: {"id": "ac_new"},
    )
    mock_sdk.connected_accounts.link.return_value = SimpleNamespace(
        id="ca_new", redirect_url="https://oauth/...",
    )
    init = await cs.connect(7, "gmail")
    assert init.connected_account_id == "ca_new"
    mock_sdk.auth_configs.create.assert_called_once()


@pytest.mark.asyncio
async def test_connect_rejects_empty_toolkit(mock_sdk):
    with pytest.raises(ValueError):
        await cs.connect(7, "")


@pytest.mark.asyncio
async def test_disconnect_clears_identity_cache(mock_sdk):
    cs._identity_cache["ca_1"] = ({"x": 1}, 0.0)
    await cs.disconnect("ca_1")
    assert "ca_1" not in cs._identity_cache
    mock_sdk.connected_accounts.delete.assert_called_once_with("ca_1")


# ── session pool ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_or_create_session_caches_per_user(mock_sdk):
    sess_a = MagicMock(name="session_a")
    sess_b = MagicMock(name="session_b")
    mock_sdk.create.side_effect = [sess_a, sess_b]

    s1 = await cs.get_or_create_session(7)
    s2 = await cs.get_or_create_session(7)
    assert s1 is s2
    assert mock_sdk.create.call_count == 1

    # Different user → different session.
    s3 = await cs.get_or_create_session(8)
    assert s3 is sess_b
    assert mock_sdk.create.call_count == 2


@pytest.mark.asyncio
async def test_get_or_create_session_cache_keys_on_config(mock_sdk):
    """Different toolkits / tools allowlists → separate cached sessions."""
    sess_a = MagicMock()
    sess_b = MagicMock()
    mock_sdk.create.side_effect = [sess_a, sess_b]

    s1 = await cs.get_or_create_session(7, toolkits=["gmail"])
    s2 = await cs.get_or_create_session(7, toolkits=["github"])
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

    out = await cs.execute_meta_tool(7, "COMPOSIO_SEARCH_TOOLS",
                                      {"queries": [{"use_case": "x"}]})
    assert out == {"data": {"hits": []}}
    sess.execute.assert_called_once_with(
        "COMPOSIO_SEARCH_TOOLS",
        arguments={"queries": [{"use_case": "x"}]},
    )


@pytest.mark.asyncio
async def test_evict_session_clears_user_only(mock_sdk):
    mock_sdk.create.side_effect = [MagicMock(), MagicMock()]
    await cs.get_or_create_session(7)
    await cs.get_or_create_session(8)
    assert len(cs._SESSION_REGISTRY) == 2
    await cs.evict_session(7)
    keys = list(cs._SESSION_REGISTRY)
    assert all(not k.startswith("7:") for k in keys)
    assert any(k.startswith("8:") for k in keys)
