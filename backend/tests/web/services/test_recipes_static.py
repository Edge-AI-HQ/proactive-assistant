"""Static (offline) invariants over the ingest recipes + raw_sources registry.

These run with no network — they only read db/ingest_recipes/*.yaml and the
registry — so they can be a CI gate, unlike scripts/validate_ingest_recipe.py
(which needs a live Composio account).

The load-bearing invariant: a recipe that lands in the generic pai_raw_events
store MUST declare timestamp_path. Without it generic_ingest falls back to
NOW() for occurred_at, so every re-sync makes the row look fresh and pollutes
the generation 24h window. Typed-store recipes are exempt (their upserters map
occurred_at explicitly).
"""

from __future__ import annotations

import pytest
from pinai_api.domains.connector.apps import connector_ingest, ingest_runner, raw_sources


def _generic_store_toolkits() -> list[str]:
    """Ingestable, non-fanout recipes whose toolkit has no typed table —
    i.e. the ones that land in pai_raw_events."""
    typed = raw_sources.typed_composio_toolkits()
    out: list[str] = []
    for tk in sorted(ingest_runner.supported_toolkits()):
        recipe = ingest_runner.load_recipe(tk)
        if recipe is None or not recipe.is_ingestable() or recipe.fanout:
            continue
        if tk not in typed:
            out.append(tk)
    return out


@pytest.mark.parametrize("toolkit", _generic_store_toolkits())
def test_generic_recipe_declares_timestamp_and_entity(toolkit: str) -> None:
    recipe = ingest_runner.load_recipe(toolkit)
    assert recipe is not None
    assert recipe.entity_type, (
        f"{toolkit}: generic-store recipe must set entity_type "
        "(it keys the pai_raw_events row and the read path)."
    )
    assert recipe.timestamp_path, (
        f"{toolkit}: generic-store recipe must set timestamp_path, else "
        "occurred_at falls back to NOW() and pollutes the 24h window."
    )


@pytest.mark.parametrize("source", [s for s in raw_sources.ALL_SOURCES if s.store == "events"])
def test_registry_generic_source_matches_recipe(source: raw_sources.RawSource) -> None:
    """Every events-store source in the registry must have a recipe whose
    toolkit/entity_type agree — guards registry↔recipe drift."""
    recipe = ingest_runner.load_recipe(source.path_toolkit)
    assert recipe is not None, f"{source.path_toolkit}: registry source has no recipe"
    assert recipe.entity_type == source.entity, (
        f"{source.path_toolkit}: registry entity={source.entity!r} but recipe "
        f"entity_type={recipe.entity_type!r}"
    )


@pytest.mark.parametrize("source", [s for s in raw_sources.ALL_SOURCES if s.store == "typed"])
def test_registry_typed_source_is_well_formed(source: raw_sources.RawSource) -> None:
    """Typed sources must carry a physical table + display projection."""
    assert source.table is not None, f"{source.path_toolkit}: typed source needs a table"
    assert source.display is not None, f"{source.path_toolkit}: typed source needs display SQL"


def test_registry_typed_set_matches_upserters() -> None:
    """The registry's typed-Composio set must equal connector_ingest's
    write-path upserters — the authoritative typed set. Without this the
    write side (which routes a toolkit to its typed table vs the generic
    store via _UPSERTERS) and the read/registry side could drift: a typed
    table with no upserter would never be written, or an upserter with no
    registry entry would be unreadable through the consolidated paths."""
    assert raw_sources.typed_composio_toolkits() == connector_ingest.supported_toolkits()
