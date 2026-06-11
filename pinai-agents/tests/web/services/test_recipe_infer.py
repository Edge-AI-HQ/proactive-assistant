"""Unit tests for recipe_infer — pure inference over synthetic Composio
tool schemas (no network)."""

from __future__ import annotations

from types import SimpleNamespace

from pinai_agents.web.services.recipe_infer import infer_from_tools


def _tool(slug: str, *, required: list[str] | None = None, output: dict | None = None):
    return SimpleNamespace(
        slug=slug,
        input_parameters={
            "type": "object",
            "properties": {},
            "required": required or [],
        },
        output_parameters=output or {},
    )


_CLEAN_LIST_OUTPUT = {
    "type": "object",
    "properties": {
        "data": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "content": {"type": "string"},
                            "created_at": {"type": "string"},
                            "updated_at": {"type": "string"},
                        },
                    },
                }
            },
        }
    },
}


def test_clean_list_action_infers_high_confidence():
    recipe = infer_from_tools(
        "todoist",
        [
            _tool("TODOIST_CREATE_TASK"),  # write — rejected
            _tool("TODOIST_LIST_TASKS", output=_CLEAN_LIST_OUTPUT),
        ],
    )
    assert recipe is not None
    assert recipe.slug == "TODOIST_LIST_TASKS"
    assert recipe.confidence == "high"
    assert recipe.is_ingestable()
    assert recipe.result_path == ["data", "tasks"]
    assert recipe.id_field == "id"
    assert recipe.entity_type == "tasks"
    # updated_at preferred over created_at (refresh moves the row forward)
    assert recipe.timestamp_path == ["updated_at"]


def test_required_business_param_disqualifies_action():
    recipe = infer_from_tools(
        "foo",
        [
            _tool("FOO_LIST_ITEMS", required=["project_id"], output=_CLEAN_LIST_OUTPUT),
            _tool("FOO_GET_THING_BY_ID", required=["thing_id"]),
        ],
    )
    assert recipe is not None
    assert recipe.connect_only  # nothing pullable without params
    assert recipe.confidence == "low"
    assert not recipe.is_ingestable()


def test_pagination_only_required_is_fine():
    recipe = infer_from_tools(
        "bar",
        [_tool("BAR_LIST_THINGS", required=["limit"], output=_CLEAN_LIST_OUTPUT)],
    )
    assert recipe is not None
    assert recipe.is_ingestable()


def test_missing_id_field_degrades_to_mid():
    output = {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {"type": "object", "properties": {"text": {"type": "string"}}},
            }
        },
    }
    recipe = infer_from_tools("baz", [_tool("BAZ_LIST_NOTES", output=output)])
    assert recipe is not None
    assert recipe.confidence == "mid"
    assert recipe.id_field is None
    assert recipe.is_ingestable()  # dedupe falls back to payload hash


def test_write_only_toolkit_degrades_to_connect_only():
    recipe = infer_from_tools(
        "writer",
        [_tool("WRITER_CREATE_DOC"), _tool("WRITER_SEND_MESSAGE")],
    )
    assert recipe is not None
    assert recipe.connect_only


def test_no_tools_returns_none():
    assert infer_from_tools("ghost", []) is None


def test_prefers_list_over_search():
    recipe = infer_from_tools(
        "multi",
        [
            _tool("MULTI_SEARCH_RECORDS", output=_CLEAN_LIST_OUTPUT),
            _tool("MULTI_LIST_RECORDS", output=_CLEAN_LIST_OUTPUT),
        ],
    )
    assert recipe is not None
    assert recipe.slug == "MULTI_LIST_RECORDS"
