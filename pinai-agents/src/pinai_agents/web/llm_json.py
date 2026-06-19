"""Tolerant JSON-object parsing for LLM output.

A model asked for a JSON object sometimes wraps it in ```` ```json ```` fences
or adds a prose preamble even when ``response_format={"type":"json_object"}``
is requested, so a bare ``json.loads`` raises on otherwise-valid content. This
helper tries the raw string, a newline-normalized form, and any fenced
``` ```json {...} ``` ``` block, returning the first that parses to a dict.

Returns ``{}`` when nothing parses to an object — callers treat an empty dict
as "no usable JSON".
"""

from __future__ import annotations

import json
import re
from typing import Any

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def parse_json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    raw = value.strip()
    normalized = raw.replace("\\n", "\n")
    candidates = [raw, normalized]
    fenced = _JSON_FENCE_RE.search(normalized)
    if fenced:
        candidates.insert(0, fenced.group(1).strip())
    elif raw.startswith("```"):
        candidates.insert(
            0,
            raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip(),
        )
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return {}
