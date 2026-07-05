"""Generic ingest runner — read yaml recipe, execute Composio tool,
walk the result, hand items to a toolkit-specific upserter.

Recipes live in `backend/db/ingest_recipes/<toolkit>.yaml`.
Schema is `Recipe` below — see
docs/plans/2026-05-07-composio-architecture-redesign.mdx for full
field reference.

This runner owns the fetch half of ingest (Composio call → list of items),
table-driven by the yaml recipe. The upsert half is the recipe-driven
generic_ingest mapper, which writes every toolkit into the unified pai_raw
store — there is no per-toolkit upsert code anymore.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

from ....domains.billing.metering import (
    estimate_composio_tool_call_charge,
    record_provider_usage_charge,
)
from ....platform.auth.user_service import User
from . import composio_service as cs

logger = logging.getLogger(__name__)


# ── Recipe schema ──────────────────────────────────────────────────────


class Prereq(BaseModel):
    """Two-step calls (e.g. Calendly: GET_USER → LIST_SCHEDULED_EVENTS).
    Runner executes the prereq first, walks `inject_path` on the
    response, and injects the resulting value as `inject_arg` of the
    main call's args."""

    slug: str
    args: dict[str, Any] = Field(default_factory=dict)
    inject_arg: str
    inject_path: list[str]


class Recipe(BaseModel):
    """One toolkit's pull spec. yaml ↔ this model 1:1."""

    toolkit: str
    slug: str | None = None
    args_template: dict[str, Any] = Field(default_factory=dict)
    since_param: str | None = None
    since_format: str | None = None
    # init bootstrap window. Design: init pulls an EXPLICIT [now-lookback,
    # now+lookahead] snapshot (so history reaches back + future meetings reach
    # forward) and paginates it, instead of the toolkit's opaque default window
    # (which just returns the first `maxResults` — the "only got last few days"
    # bug). sync stays incremental via since_param. All-empty/zero → init keeps
    # the legacy since=None single-shot default-window behavior.
    init_since_param: str | None = None  # e.g. gcal timeMin
    init_until_param: str | None = None  # e.g. gcal timeMax (future window)
    init_since_format: str | None = None  # reuses the _format_since formats
    init_lookback_days: int = 0  # how far back the init snapshot reaches
    init_lookahead_days: int = 0  # how far forward (0 for sources with no future)
    init_max_items: int = 100  # cap on total items pulled across pages per init
    # pagination: follow the response's next-page token until exhausted or the
    # cap is hit. Empty page_token_response_path → single-shot (legacy).
    page_token_response_path: list[str] = Field(default_factory=list)
    page_token_arg: str | None = None
    result_path: list[str] = Field(default_factory=list)
    id_field: str | None = None
    sync_interval_hours: int = 12
    connect_only: bool = False
    prereqs: list[Prereq] = Field(default_factory=list)
    description: str = ""
    notes: str = ""
    # Projection fields: every recipe lands in the unified pai_raw store via
    # the generic mapper (generic_ingest); these drive the projection.
    entity_type: str | None = None
    timestamp_path: list[str] = Field(default_factory=list)
    # Fallback timestamp path, tried when timestamp_path yields nothing — for
    # sources whose time field moves with item shape. Canonical case: GCal
    # all-day events carry start.date (not start.dateTime), so a recipe with
    # timestamp_path=[start,dateTime] must fall back to [start,date] — without
    # it, all-day items get occurred_at=NOW and pile onto the ingest day.
    timestamp_fallback_path: list[str] = Field(default_factory=list)
    title_path: list[str] = Field(default_factory=list)
    snippet_path: list[str] = Field(default_factory=list)
    # Timeless sources (e.g. a profile snapshot) have no natural event time, so
    # occurred_at = ingest time is expected and they're exempt from the
    # timestamp_path gate — they're reference data, not part of the 24h window.
    timeless: bool = False
    # Rollup strategy — the raw→event pipeline's optional stage (design §4.2):
    #   off      — 1 raw → 1 event (discrete data: email / meeting / feedback).
    #   window   — periodic-state sources (app usage / location points): a fixed
    #              time window is deduped / aggregated (rule-based, no LLM).
    #   semantic — firehose (utterance / screenshots): NOT projected one-by-one
    #              (would flood L1); evolve's semantic rollup collapses them into
    #              episode events. The projector skips these.
    # Composio recipes are all "off" today; the device sources that use window /
    # semantic have no recipe — their strategy lives in the shared
    # pinai_contracts.rollup_policy (doc §4.2).
    rollup: str = "off"
    # Inferred-recipe confidence (recipe_infer writes mid/low; handwritten
    # yaml defaults to high).
    confidence: str = "high"
    # Aggregate toolkits (googlesuper): one OAuth account drives the listed
    # sub-toolkits' ingest instead of running a slug of its own.
    fanout: list[str] = Field(default_factory=list)

    def is_ingestable(self) -> bool:
        """Connect-only recipes (e.g. Discord) deliberately skip ingest;
        runner short-circuits to a no-op for them. Fanout recipes
        (googlesuper) have no slug of their own — their sub-toolkits do
        the fetching."""
        return not self.connect_only and (self.slug is not None or bool(self.fanout))


# ── Recipe loader ──────────────────────────────────────────────────────


def _recipes_dir() -> Path:
    """Yaml files live alongside `db/migrations/` so they ship with
    the runtime image and are reviewable in PRs."""
    # backend/services/api/src/pinai_api/domains/connector/apps/ingest_runner.py
    # → backend/db/ingest_recipes/
    return Path(__file__).resolve().parents[7] / "db" / "ingest_recipes"


@lru_cache(maxsize=64)
def load_recipe(toolkit: str) -> Recipe | None:
    """Read `<toolkit>.yaml`. Returns None if no recipe exists (callers
    treat that as 'unsupported, skip')."""
    path = _recipes_dir() / f"{toolkit}.yaml"
    if not path.is_file():
        return None
    raw = yaml.safe_load(path.read_text())
    if not isinstance(raw, dict):
        msg = f"recipe {path.name}: expected mapping, got {type(raw).__name__}"
        raise ValueError(msg)
    return Recipe.model_validate(raw)


def supported_toolkits() -> set[str]:
    """All toolkits with a recipe file (whether ingestable or
    connect_only). Used by the scheduler to know what to enqueue and by
    `/api/composio/connect` to validate the toolkit slug."""
    return {p.stem for p in _recipes_dir().glob("*.yaml")}


# ── since formatting ───────────────────────────────────────────────────


def _format_since(dt: datetime, fmt: str | None) -> Any:
    """Translate a datetime cursor into the toolkit's accepted shape.
    Returns the value to assign to recipe.since_param. New formats
    require a code change — keeping this dict explicit so reviewers
    can see at a glance what's supported."""
    if fmt is None:
        return dt.isoformat()
    if fmt == "iso":
        return dt.isoformat()
    if fmt == "unix":
        return int(dt.timestamp())
    if fmt == "gmail_query":
        # Gmail's `q` arg uses `after:<unix_seconds>`; Gmail accepts
        # epoch seconds and dodges the YYYY/MM/DD timezone day-boundary
        # off-by-one.
        return f"after:{int(dt.timestamp())}"
    if fmt == "gdrive_query":
        # Drive's q DSL: combine modifiedTime > '<iso>' with
        # `and trashed = false` so deleted files don't reappear.
        return f"modifiedTime > '{dt.replace(microsecond=0).isoformat()}' and trashed = false"
    if fmt == "slack_query":
        # Slack search supports `after:YYYY-MM-DD` only (day-level).
        # Stripping the time component is fine; raw dedupe absorbs the
        # boundary overlap.
        return f"after:{dt.strftime('%Y-%m-%d')}"
    if fmt == "stripe_nested_unix":
        # Stripe uses a nested object filter: created.gte; we only
        # supply the value here. The runner sets it as args[since_param]
        # which assumes since_param is `created.gte` — the runner
        # special-cases dotted paths below.
        return int(dt.timestamp())
    msg = f"unsupported since_format: {fmt}"
    raise ValueError(msg)


def _set_dotted(target: dict[str, Any], key: str, value: Any) -> None:
    """Assign `target[a][b]...[last] = value` from dotted key. Used for
    Stripe-style filters where `created.gte` translates to
    args['created']['gte']."""
    parts = key.split(".")
    if len(parts) == 1:
        target[key] = value
        return
    cur = target
    for p in parts[:-1]:
        nxt = cur.get(p)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[p] = nxt
        cur = nxt
    cur[parts[-1]] = value


def _walk_path(payload: Any, path: Iterable[str]) -> Any:
    """Walk a list of keys through nested dicts. Returns None on miss
    (no error — caller decides what an empty result means)."""
    cur: Any = payload
    for key in path:
        if isinstance(cur, dict):
            cur = cur.get(key)
        else:
            return None
    return cur


# ── Public runner ──────────────────────────────────────────────────────


async def run_fetch(
    user: User,
    toolkit: str,
    connected_account_id: str,
    *,
    limit: int = 100,
    since: datetime | None = None,
    pool: Any | None = None,
) -> list[dict[str, Any]]:
    """Run the fetch half of an ingest cycle (Composio call → list of
    items). Returns [] if the recipe is connect_only or missing.

    The upsert half is intentionally NOT here — the caller
    (connector_ingest._run_init / _run_sync) hands these items to the
    recipe-driven generic upserter (generic_ingest), which writes the
    unified pai_raw store.
    """
    recipe = load_recipe(toolkit)
    if recipe is None:
        logger.info("[ingest_runner] no recipe for toolkit=%s", toolkit)
        return []
    if not recipe.is_ingestable():
        logger.info(
            "[ingest_runner] connect_only toolkit=%s — skipping ingest",
            toolkit,
        )
        return []

    args: dict[str, Any] = dict(recipe.args_template)

    # Resolve prereqs first (e.g. Calendly: GET_USER → user URI).
    for pre in recipe.prereqs:
        pre_result = await cs.execute(
            user,
            pre.slug,
            pre.args,
            connected_account_id=connected_account_id,
        )
        await _record_composio_fetch_call(
            pool,
            user,
            source="composio:ingest_prereq",
            slug=pre.slug,
            successful=pre_result.successful,
            toolkit=toolkit,
        )
        if not pre_result.successful:
            logger.warning(
                "[ingest_runner] prereq %s failed for %s: %s",
                pre.slug,
                toolkit,
                pre_result.error,
            )
            return []
        injected = _walk_path(pre_result.data, pre.inject_path)
        if injected is None:
            logger.warning(
                "[ingest_runner] prereq %s for %s returned no value at %s",
                pre.slug,
                toolkit,
                pre.inject_path,
            )
            return []
        args[pre.inject_arg] = injected

    # Time window — two modes:
    #   sync (since given):  incremental cursor via since_param.
    #   init (since is None): explicit [now-lookback, now+lookahead] window via
    #     init_since_param / init_until_param, so history reaches back AND future
    #     meetings reach forward — not the toolkit's opaque default window (which
    #     just returns the first maxResults). Recipes without init_since_param
    #     keep the legacy since=None default-window behavior.
    if since is not None and recipe.since_param:
        try:
            since_value = _format_since(since, recipe.since_format)
        except ValueError as e:
            logger.warning("[ingest_runner] %s", e)
            return []
        _set_dotted(args, recipe.since_param, since_value)
    elif since is None and recipe.init_since_param:
        now = datetime.now(UTC)
        if recipe.init_lookback_days:
            lo = now - timedelta(days=recipe.init_lookback_days)
            _set_dotted(args, recipe.init_since_param, _format_since(lo, recipe.init_since_format))
        if recipe.init_until_param and recipe.init_lookahead_days:
            hi = now + timedelta(days=recipe.init_lookahead_days)
            _set_dotted(args, recipe.init_until_param, _format_since(hi, recipe.init_since_format))

    # Fetch, following the recipe's page token until exhausted or the cap is hit.
    # Single-shot when the recipe declares no pagination (page_token_response_path
    # empty). Cap: init pulls up to init_max_items across pages; sync clamps to
    # `limit` (its per-cycle budget).
    cap = recipe.init_max_items if since is None else limit
    collected: list[dict[str, Any]] = []
    page_token: Any = None
    while True:
        if page_token is not None and recipe.page_token_arg:
            args[recipe.page_token_arg] = page_token
        result = await cs.execute(
            user,
            recipe.slug or "",
            args,
            connected_account_id=connected_account_id,
        )
        await _record_composio_fetch_call(
            pool,
            user,
            source="composio:ingest_fetch",
            slug=recipe.slug or "",
            successful=result.successful,
            toolkit=toolkit,
        )
        if not result.successful:
            logger.warning("[ingest_runner] %s exec failed: %s", recipe.slug, result.error)
            break
        items: Any = (
            _walk_path(result.data, recipe.result_path) if recipe.result_path else result.data
        )
        if isinstance(items, dict):
            # Single-object endpoints (e.g. LinkedIn profile) — wrap so the
            # downstream upserter sees one row.
            items = [items]
        if isinstance(items, list):
            collected.extend(x for x in items if isinstance(x, dict))
        elif items is not None:
            logger.warning(
                "[ingest_runner] %s: result_path %s did not yield a list (got %s)",
                recipe.slug,
                recipe.result_path,
                type(items).__name__,
            )
        # Next page? Stop when there's no pagination configured, the cap is hit,
        # or the token runs out.
        if not recipe.page_token_response_path or len(collected) >= cap:
            break
        page_token = _walk_path(result.data, recipe.page_token_response_path)
        if not page_token:
            break
    return collected[:cap]


async def _record_composio_fetch_call(
    pool: Any | None,
    user: User,
    *,
    source: str,
    slug: str,
    successful: bool,
    toolkit: str,
) -> None:
    if pool is None:
        return
    charge = estimate_composio_tool_call_charge(
        tool_calls=1,
        source=source,
        metadata={"slug": slug, "toolkit": toolkit, "successful": successful},
        status="succeeded" if successful else "failed",
    )
    await record_provider_usage_charge(
        pool,
        user_id=user.id,
        supabase_user_id=user.supabase_user_id,
        charge=charge,
    )
