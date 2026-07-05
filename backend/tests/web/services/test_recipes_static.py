"""Static (offline) invariants over the ingest recipes + raw_sources registry.

These run with no network — they only read db/ingest_recipes/*.yaml and the
registry — so they can be a CI gate, unlike scripts/validate_ingest_recipe.py
(which needs a live Composio account).

The load-bearing invariant: since the L0 contract every source lands in the
unified pai_raw store via the generic mapper, so EVERY ingestable, non-fanout
recipe MUST declare timestamp_path. Without it generic_ingest falls back to NOW()
for occurred_at, so every re-sync makes the row look fresh and pollutes the
generation 24h window. Timeless sources (profile snapshots) are exempt —
occurred_at = ingest time is expected for them (reference data).
"""

from __future__ import annotations

import pytest
from pinai_api.domains.connector.apps import ingest_runner, raw_sources


def _timestamped_recipe_toolkits() -> list[str]:
    """Ingestable, non-fanout, non-timeless recipes — all of which land in
    pai_raw and therefore must carry a timestamp_path."""
    out: list[str] = []
    for tk in sorted(ingest_runner.supported_toolkits()):
        recipe = ingest_runner.load_recipe(tk)
        if recipe is None or not recipe.is_ingestable() or recipe.fanout or recipe.timeless:
            continue
        out.append(tk)
    return out


@pytest.mark.parametrize("toolkit", _timestamped_recipe_toolkits())
def test_recipe_declares_timestamp_and_entity(toolkit: str) -> None:
    recipe = ingest_runner.load_recipe(toolkit)
    assert recipe is not None
    assert recipe.entity_type, (
        f"{toolkit}: recipe must set entity_type (it keys the pai_raw row and the read path)."
    )
    assert recipe.timestamp_path, (
        f"{toolkit}: recipe must set timestamp_path, else occurred_at falls back "
        "to NOW() and pollutes the 24h window."
    )


@pytest.mark.parametrize("source", list(raw_sources.ALL_SOURCES))
def test_registry_source_matches_recipe(source: raw_sources.RawSource) -> None:
    """Every Composio-backed registry source must have a recipe whose
    entity_type agrees — guards registry↔recipe drift. Device sources have no
    Composio connection (composio_toolkit is None) and no recipe."""
    if source.composio_toolkit is None:
        pytest.skip(f"{source.path_toolkit}/{source.entity}: device source, no recipe")
    recipe = ingest_runner.load_recipe(source.composio_toolkit)
    assert recipe is not None, f"{source.composio_toolkit}: registry source has no recipe"
    assert recipe.entity_type == source.entity, (
        f"{source.composio_toolkit}: registry entity={source.entity!r} but recipe "
        f"entity_type={recipe.entity_type!r}"
    )
