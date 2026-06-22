"""Recipe inference — derive an ingest Recipe from Composio tool schemas.

With the full dynamic catalog (1000+ toolkits) handwritten yaml per
toolkit doesn't scale. For toolkits WITHOUT a yaml, this module picks a
side-effect-free "list my data" action from the toolkit's tool schemas
and infers result_path / id_field / timestamp_path from the action's
output JSON Schema. Handwritten yaml always wins (load_recipe checks
files first); inference only fills the gap.

Confidence ladder (plan: docs/plans — data collector rework):
  high — clean list action, no required business params, result_path +
         id_field both located → ingest enabled.
  mid  — list action found but id_field/timestamp missing → ingest runs,
         dedupe falls back to payload hash; flagged for a yaml follow-up.
  (none) — no usable read action → connect_only recipe; the connection
         works, ingest is skipped (same path as Discord).

Schema quality varies wildly across the long tail — inference is
best-effort by design. Every outcome is logged so misfires can be
patched with a handwritten yaml.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from . import composio_service as cs
from .ingest_runner import Recipe

logger = logging.getLogger(__name__)

# Read-action slug hints. Order matters: earlier = preferred shape.
_READ_HINTS = ("LIST", "FETCH", "SEARCH", "GET")
# Any of these in the slug disqualifies the action outright.
_WRITE_HINTS = (
    "CREATE",
    "UPDATE",
    "DELETE",
    "SEND",
    "POST",
    "REMOVE",
    "ADD",
    "UPLOAD",
    "INSERT",
    "UPSERT",
    "PATCH",
    "MOVE",
    "ARCHIVE",
    "TRASH",
    "MARK",
    "REPLY",
    "EXECUTE",
    "SET",
    "WRITE",
    "PUBLISH",
    "ASSIGN",
    "INVITE",
)
# Required params that don't block a parameterless pull.
_PAGINATION_PARAMS = {
    "limit",
    "page",
    "page_size",
    "pagesize",
    "per_page",
    "cursor",
    "page_token",
    "pagetoken",
    "max_results",
    "maxresults",
    "offset",
    "count",
    "page_number",
}
_ID_FIELD_NAMES = ("id",)
_ID_FIELD_SUFFIXES = ("_id", "Id")
_TS_NAME_HINTS = ("created", "updated", "modified", "time", "date", "timestamp")

# Process-wide inference cache: one Composio meta-API round-trip per
# toolkit per process; syncs reuse the cached recipe. None is cached too
# (toolkit with no tools at all) so we don't re-probe failures every tick.
_CACHE: dict[str, Recipe | None] = {}
_LOCK = asyncio.Lock()


def cached_recipe(toolkit: str) -> Recipe | None:
    """Cache-only lookup for sync contexts (raw-source discovery). Does
    NOT trigger inference — that happens on the first connector.init."""
    return _CACHE.get(toolkit.strip().lower())


async def ainfer_recipe(toolkit: str) -> Recipe | None:
    """Infer (and cache) a recipe for a toolkit without yaml. Returns
    None only when the toolkit has no tools at all (unknown slug)."""
    tk = toolkit.strip().lower()
    async with _LOCK:
        if tk in _CACHE:
            return _CACHE[tk]
    try:
        tools = await asyncio.to_thread(_fetch_tool_schemas, tk)
    except Exception as e:
        # Meta-API failure: don't cache, next init retries.
        logger.warning("[recipe_infer] %s: schema fetch failed: %s", tk, e)
        return None
    recipe = infer_from_tools(tk, tools)
    async with _LOCK:
        _CACHE[tk] = recipe
    if recipe is None:
        logger.info("[recipe_infer] %s: no tools — not a known toolkit", tk)
    else:
        logger.info(
            "[recipe_infer] %s: slug=%s confidence=%s entity=%s result_path=%s "
            "id_field=%s timestamp_path=%s connect_only=%s",
            tk,
            recipe.slug,
            recipe.confidence,
            recipe.entity_type,
            recipe.result_path,
            recipe.id_field,
            recipe.timestamp_path,
            recipe.connect_only,
        )
    return recipe


def _fetch_tool_schemas(toolkit: str) -> list[Any]:
    return list(cs._composio().tools.get_raw_composio_tools(toolkits=[toolkit], limit=200) or [])


def infer_from_tools(toolkit: str, tools: list[Any]) -> Recipe | None:
    """Pure inference half — separated from the Composio fetch so tests
    feed synthetic schemas. None when `tools` is empty."""
    if not tools:
        return None

    best: dict[str, Any] | None = None
    for tool in tools:
        cand = _evaluate_action(tool)
        if cand is None:
            continue
        if best is None or cand["score"] > best["score"]:
            best = cand

    if best is None:
        # Connectable but nothing pullable — same degrade as Discord.
        return Recipe(
            toolkit=toolkit,
            connect_only=True,
            confidence="low",
            description=f"inferred: no parameterless read action in {toolkit}",
        )

    confidence = "high" if best["result_path"] and best["id_field"] else "mid"
    return Recipe(
        toolkit=toolkit,
        slug=best["slug"],
        result_path=best["result_path"],
        id_field=best["id_field"],
        entity_type=best["entity_type"],
        timestamp_path=best["timestamp_path"],
        confidence=confidence,
        description=f"inferred from Composio schema ({best['slug']})",
    )


def _evaluate_action(tool: Any) -> dict[str, Any] | None:
    slug = str(getattr(tool, "slug", "") or "").upper()
    if not slug or any(h in slug for h in _WRITE_HINTS):
        return None
    hint_rank = next(
        (len(_READ_HINTS) - i for i, h in enumerate(_READ_HINTS) if h in slug),
        0,
    )
    if hint_rank == 0:
        return None

    input_schema = getattr(tool, "input_parameters", None) or {}
    required = [
        r for r in (input_schema.get("required") or []) if str(r).lower() not in _PAGINATION_PARAMS
    ]
    if required:
        # Needs business params we can't invent (ids, queries) — not a
        # standing pull. Other actions may still qualify.
        return None

    output_schema = getattr(tool, "output_parameters", None) or {}
    result_path, item_schema = _find_array(output_schema)
    id_field = _find_id_field(item_schema) if item_schema else None
    ts_field = _find_timestamp_field(item_schema) if item_schema else None

    score = (
        hint_rank * 100
        + (50 if result_path else 0)
        + (30 if id_field else 0)
        + (10 if ts_field else 0)
        # Shorter slug ≈ the canonical list action, not a niche variant.
        - len(slug) // 10
    )
    entity = result_path[-1] if result_path else "items"
    return {
        "slug": str(getattr(tool, "slug", "")),
        "score": score,
        "result_path": result_path or [],
        "id_field": id_field,
        "timestamp_path": [ts_field] if ts_field else [],
        "entity_type": entity,
    }


def _properties(schema: Any) -> dict[str, Any]:
    if not isinstance(schema, dict):
        return {}
    props = schema.get("properties")
    return props if isinstance(props, dict) else {}


def _find_array(output_schema: Any) -> tuple[list[str] | None, dict[str, Any] | None]:
    """BFS (depth ≤ 3) for the first array-of-objects property. Returns
    (path, item_schema). Composio outputs commonly nest under `data`."""
    queue: list[tuple[list[str], Any]] = [([], output_schema)]
    depth = 0
    while queue and depth < 3:
        next_queue: list[tuple[list[str], Any]] = []
        for path, schema in queue:
            for name, prop in _properties(schema).items():
                if not isinstance(prop, dict):
                    continue
                if prop.get("type") == "array":
                    items = prop.get("items")
                    item_schema = items if isinstance(items, dict) else {}
                    return ([*path, name], item_schema)
                if prop.get("type") == "object" or "properties" in prop:
                    next_queue.append(([*path, name], prop))
        queue = next_queue
        depth += 1
    return (None, None)


def _find_id_field(item_schema: dict[str, Any]) -> str | None:
    props = _properties(item_schema)
    for name in props:
        if name.lower() in _ID_FIELD_NAMES:
            return name
    for name in props:
        if any(name.endswith(suf) for suf in _ID_FIELD_SUFFIXES):
            return name
    return None


def _find_timestamp_field(item_schema: dict[str, Any]) -> str | None:
    props = _properties(item_schema)
    # Prefer update-ish over create-ish: refreshes move the row forward.
    ranked = sorted(
        (
            name
            for name, prop in props.items()
            if isinstance(prop, dict)
            and prop.get("type") in ("string", "integer", "number", None)
            and any(h in name.lower() for h in _TS_NAME_HINTS)
        ),
        key=lambda n: (0 if "updat" in n.lower() or "modif" in n.lower() else 1, len(n)),
    )
    return ranked[0] if ranked else None
