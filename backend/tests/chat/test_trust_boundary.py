"""Engine trust-boundary helpers: FORBIDDEN_ENVS + boot-guard gate.

The engine (LLM loop) must never hold master credentials. These pure helpers
back two enforcement points: the flag-gated boot fail-fast in ``asgi.py`` and
the per-app secret filtering in ``scripts/sync_fly_secrets.py``. See
docs/plans/2026-06-21-backend-rearchitecture.mdx §四 (trust boundary 四道防线).
"""

from __future__ import annotations

import pytest
from agent_engine import trust_boundary


def test_forbidden_envs_lock_the_master_credential_list():
    # Locks the canonical list. Adding/removing a master credential must be a
    # deliberate edit kept in lockstep with CLAUDE.md and the inline copy in
    # scripts/sync_fly_secrets.py (test_sync_fly_secrets guards that copy).
    assert set(trust_boundary.FORBIDDEN_ENVS) == {
        "SUPABASE_SECRET_KEY",
        "PAI_JWT_SIGNING_KEY",
        "COMPOSIO_API_KEY",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "LITELLM_MASTER_KEY",
        "APNS_AUTH_KEY",
        "TENCENT_ASR_SECRET_KEY",
    }


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "Yes", " true "])
def test_failfast_enabled_truthy(value):
    assert trust_boundary.failfast_enabled({"ENGINE_TRUST_FAILFAST": value}) is True


@pytest.mark.parametrize("value", ["", "0", "false", "no", "off", "nope"])
def test_failfast_disabled_for_falsy(value):
    assert trust_boundary.failfast_enabled({"ENGINE_TRUST_FAILFAST": value}) is False


def test_failfast_disabled_when_unset():
    # Default OFF: single fly app shares env across web+engine, so the guard
    # stays disarmed until the app split sets ENGINE_TRUST_FAILFAST=1.
    assert trust_boundary.failfast_enabled({}) is False


def test_leaked_master_creds_flags_present_master_credentials():
    env = {
        "SUPABASE_SECRET_KEY": "sb_secret_xxx",
        "LITELLM_MASTER_KEY": "sk-master",
        "DATABASE_URL": "postgresql://...",  # NOT forbidden — engine needs it
        "DAYTONA_API_KEY": "dt_...",  # execution credential, not master
    }
    assert set(trust_boundary.leaked_master_creds(env)) == {
        "SUPABASE_SECRET_KEY",
        "LITELLM_MASTER_KEY",
    }


def test_leaked_master_creds_empty_for_clean_engine_env():
    env = {
        "DATABASE_URL": "postgresql://pai_chat@.../langgraph",  # scoped DSN
        "DAYTONA_API_KEY": "dt_...",
        "BROWSERBASE_API_KEY": "bb_...",
        "TAVILY_API_KEY": "tvly-...",
        "LITELLM_VIRTUAL_KEY": "sk-virtual",  # per-user virtual key, not master
    }
    assert trust_boundary.leaked_master_creds(env) == []


def test_leaked_master_creds_ignores_empty_string_values():
    # An exported-but-empty var (common in docker-compose) is not a leak.
    assert trust_boundary.leaked_master_creds({"STRIPE_SECRET_KEY": ""}) == []
