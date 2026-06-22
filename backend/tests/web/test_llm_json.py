from __future__ import annotations

import json

from pinai_api.platform.llm_json import parse_json_object

_OBJ = {"title": "T", "summary": "S"}


def test_parses_plain_json_object():
    assert parse_json_object(json.dumps(_OBJ)) == _OBJ


def test_passes_through_dict():
    assert parse_json_object(_OBJ) == _OBJ


def test_unwraps_json_fence():
    assert parse_json_object("```json\n" + json.dumps(_OBJ) + "\n```") == _OBJ


def test_unwraps_bare_fence():
    assert parse_json_object("```\n" + json.dumps(_OBJ) + "\n```") == _OBJ


def test_unwraps_fence_with_prose_preamble():
    text = "Here is the summary:\n```json\n" + json.dumps(_OBJ) + "\n```\nDone."
    assert parse_json_object(text) == _OBJ


def test_empty_dict_on_unparseable():
    assert parse_json_object("not json at all") == {}
    assert parse_json_object("") == {}


def test_empty_dict_on_non_string_non_dict():
    assert parse_json_object(123) == {}
    assert parse_json_object(None) == {}


def test_empty_dict_on_json_array_not_object():
    # A top-level array is valid JSON but not an object — callers want a dict.
    assert parse_json_object("[1, 2, 3]") == {}
