"""Per-app secret scoping in scripts/sync_fly_secrets.py.

The script runs under the CI runner's system python3 (no project venv), so it
keeps its own ``_FORBIDDEN_ENVS`` copy and is loaded here via importlib rather
than a normal import. The first test guards that the copy never drifts from the
SSOT in agent_engine.trust_boundary. See
docs/plans/2026-06-21-backend-rearchitecture.mdx §四 / §十二.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sync_fly_secrets.py"
_spec = importlib.util.spec_from_file_location("sync_fly_secrets", _SCRIPT)
assert _spec and _spec.loader
sync_fly_secrets = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync_fly_secrets)


def test_inline_forbidden_matches_trust_boundary_ssot():
    # The script can't import the engine package at deploy time; this asserts
    # its inline copy stays byte-identical to the single source of truth.
    from agent_engine.trust_boundary import FORBIDDEN_ENVS

    assert sync_fly_secrets._FORBIDDEN_ENVS == FORBIDDEN_ENVS


def test_default_no_flags_passes_everything_through():
    # api app (trusted) gets the full set unchanged.
    kvs = {"A": "1", "SUPABASE_SECRET_KEY": "x", "DATABASE_URL": "super"}
    out = sync_fly_secrets._filter_for_app(kvs, exclude_master=False, database_url_from=None)
    assert out == kvs


def test_exclude_master_drops_all_forbidden():
    kvs = {k: "x" for k in sync_fly_secrets._FORBIDDEN_ENVS}
    kvs |= {"DATABASE_URL": "super", "DAYTONA_API_KEY": "dt"}
    out = sync_fly_secrets._filter_for_app(kvs, exclude_master=True, database_url_from=None)
    assert out == {"DATABASE_URL": "super", "DAYTONA_API_KEY": "dt"}


def test_database_url_from_swaps_and_drops_alias():
    kvs = {"DATABASE_URL": "super", "ENGINE_DATABASE_URL": "scoped", "A": "1"}
    out = sync_fly_secrets._filter_for_app(
        kvs, exclude_master=False, database_url_from="ENGINE_DATABASE_URL"
    )
    assert out == {"DATABASE_URL": "scoped", "A": "1"}


def test_database_url_from_missing_key_exits():
    # Refuse to deploy rather than silently leave the superuser DSN in place.
    with pytest.raises(SystemExit):
        sync_fly_secrets._filter_for_app(
            {"DATABASE_URL": "super"},
            exclude_master=False,
            database_url_from="ENGINE_DATABASE_URL",
        )


def test_engine_scoping_combo_drops_master_and_scopes_dsn():
    kvs = {
        "DATABASE_URL": "postgresql://postgres@/super",
        "ENGINE_DATABASE_URL": "postgresql://pai_chat@/langgraph",
        "SUPABASE_SECRET_KEY": "sb_secret",
        "LITELLM_VIRTUAL_KEY": "sk-virtual",  # per-user key, not master — kept
        "DAYTONA_API_KEY": "dt",
    }
    out = sync_fly_secrets._filter_for_app(
        kvs, exclude_master=True, database_url_from="ENGINE_DATABASE_URL"
    )
    assert out == {
        "DATABASE_URL": "postgresql://pai_chat@/langgraph",
        "LITELLM_VIRTUAL_KEY": "sk-virtual",
        "DAYTONA_API_KEY": "dt",
    }


def test_scoping_drops_other_apps_scoped_dsn():
    # Over-sharing guard: an app must not hold ANOTHER app's scoped DSN. The
    # engine scopes to ENGINE_DATABASE_URL, but the env file also carries
    # REWARD_DATABASE_URL / APP_DATABASE_URL — those must NOT reach engine.
    kvs = {
        "DATABASE_URL": "super",
        "ENGINE_DATABASE_URL": "pai_chat_dsn",
        "REWARD_DATABASE_URL": "pai_reward_dsn",
        "APP_DATABASE_URL": "pai_app_dsn",
        "A": "1",
    }
    out = sync_fly_secrets._filter_for_app(
        kvs, exclude_master=True, database_url_from="ENGINE_DATABASE_URL"
    )
    assert out == {"DATABASE_URL": "pai_chat_dsn", "A": "1"}


def test_api_full_set_still_drops_scoped_aliases():
    # Even the trusted api app (no flags) shouldn't carry the engine/reward
    # scoped DSNs — it connects with the superuser DATABASE_URL.
    kvs = {
        "DATABASE_URL": "super",
        "ENGINE_DATABASE_URL": "e",
        "REWARD_DATABASE_URL": "r",
        "X": "1",
    }
    out = sync_fly_secrets._filter_for_app(kvs, exclude_master=False, database_url_from=None)
    assert out == {"DATABASE_URL": "super", "X": "1"}
