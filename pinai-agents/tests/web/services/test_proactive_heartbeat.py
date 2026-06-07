from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pinai_agents.web.db.repositories.timeline import TimelineEventRow
from pinai_agents.web.services.proactive_window import _format_heartbeat


def _row(source: str, title: str, metadata: dict[str, Any], occurred: datetime) -> TimelineEventRow:
    return TimelineEventRow.from_record(
        {
            "id": "e1",
            "occurred_at": occurred,
            "source": source,
            "event_type": "utterance",
            "title": title,
            "metadata": metadata,
            "importance": 0.5,
            "confidence": 1.0,
            "is_predicted": False,
            "curation_status": "pending",
            "version": 1,
            "ingested_at": occurred,
            "updated_at": occurred,
            "reference_count": 0,
        }
    )


_NOW = datetime(2026, 5, 29, 12, 0, tzinfo=UTC)
_OCCURRED = datetime(2026, 5, 29, 11, 59, tzinfo=UTC)


def test_heartbeat_renders_speaker_attribution_for_utterances():
    events = [
        _row(
            "ambient.utterance",
            "lunch later?",  # truncated plain-text title preview
            {
                "speaker_segments": [
                    {"speaker": "self", "text": "lunch later?"},
                    {"speaker": "speaker_1", "text": "sure"},
                ]
            },
            _OCCURRED,
        )
    ]
    text = _format_heartbeat(_NOW, _OCCURRED, events, "UTC")
    assert 'self: "lunch later?"' in text
    assert 'speaker_1: "sure"' in text


def test_heartbeat_falls_back_to_title_without_segments():
    # Plain-text fallback transcript (diarization failed) has no segments.
    events = [_row("ambient.utterance", "muffled speech", {}, _OCCURRED)]
    text = _format_heartbeat(_NOW, _OCCURRED, events, "UTC")
    assert "muffled speech" in text


def test_heartbeat_keeps_title_for_non_ambient_events():
    events = [_row("gmail", "Re: Q2 planning", {}, _OCCURRED)]
    text = _format_heartbeat(_NOW, _OCCURRED, events, "UTC")
    assert "Re: Q2 planning" in text
