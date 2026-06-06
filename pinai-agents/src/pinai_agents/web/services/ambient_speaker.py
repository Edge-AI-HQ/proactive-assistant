"""Diarized speaker attribution helpers for ambient timeline events.

The end-side capture pipeline stores per-utterance diarization in each
`ambient.utterance` event's metadata (`self_text` / `speaker_segments`).
These helpers turn that metadata into a self/other preview using the same
`self: "..."` labels the live UI renders. Shared by:

  * the agent timeline read path (`agent/timeline.py`) — per-event
    `selfText` / `speakerText` preview, since the list view drops `metadata`;
  * the proactive heartbeat (`proactive_loop.py`) — inline speaker
    attribution in the "new since last check" list.

Pure functions, no IO — safe to import from both routes and services.
"""

from __future__ import annotations

import json
from typing import Any


def clean_text(value: Any, *, preserve_lines: bool = False) -> str | None:
    if not isinstance(value, str):
        return None
    if preserve_lines:
        lines = [" ".join(line.split()) for line in value.splitlines()]
        text = "\n".join(line for line in lines if line)
    else:
        text = " ".join(value.split())
    return text or None


def speaker_text_from_segments(value: Any) -> str | None:
    """Render a `speaker_segments` list as `self: "hi"\nspeaker_1: "yo"`."""
    if not isinstance(value, list):
        return None
    lines: list[str] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        speaker = clean_text(item.get("speaker"))
        text = clean_text(item.get("text"))
        if speaker and text:
            lines.append(f"{speaker}: {json.dumps(text, ensure_ascii=False)}")
    return "\n".join(lines) if lines else None


def ambient_speaker_preview(metadata: dict[str, Any]) -> dict[str, str]:
    """Surface `{selfText, speakerText}` from ambient event metadata.

    `selfText` is the user's own speech (the diarized `self` speaker);
    `speakerText` is the full self/other breakdown. Returns an empty dict
    when the event carries no diarized attribution (e.g. a plain-text
    fallback transcript, or a non-utterance ambient event).
    """
    out: dict[str, str] = {}
    self_text = clean_text(metadata.get("self_text"))
    if self_text:
        out["selfText"] = self_text
    speaker_text = clean_text(
        metadata.get("speaker_text"),
        preserve_lines=True,
    ) or speaker_text_from_segments(metadata.get("speaker_segments"))
    if speaker_text:
        out["speakerText"] = speaker_text
    return out


def inline_speaker_text(metadata: Any) -> str | None:
    """One-line speaker-attributed text for compact lists (the proactive
    heartbeat). Same `self: "..."` labels as `ambient_speaker_preview`'s
    `speakerText`, collapsed onto a single line. Returns None when the event
    has no diarized segments — callers fall back to the event title."""
    if not isinstance(metadata, dict):
        return None
    speaker_text = ambient_speaker_preview(metadata).get("speakerText")
    return speaker_text.replace("\n", "  ") if speaker_text else None
