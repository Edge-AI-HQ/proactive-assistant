from __future__ import annotations

from pinai_api.domains.connector.device.ambient_speaker import (
    ambient_speaker_preview,
    inline_speaker_text,
    speaker_text_from_segments,
)


def test_ambient_speaker_preview_derives_text_from_metadata():
    # speaker_text wins verbatim (line-preserving clean); self_text collapsed.
    assert ambient_speaker_preview(
        {
            "self_text": " I need to finish the review first ",
            "speaker_text": 'speaker_1: "lunch?"\nself: "review first"',
        }
    ) == {
        "selfText": "I need to finish the review first",
        "speakerText": 'speaker_1: "lunch?"\nself: "review first"',
    }
    # speakerText falls back to speaker_segments when speaker_text is absent.
    assert ambient_speaker_preview(
        {
            "self_text": "after the review",
            "speaker_segments": [
                {"speaker": "self", "text": "after the review"},
                {"speaker": "speaker_1", "text": "lunch?"},
            ],
        }
    ) == {
        "selfText": "after the review",
        "speakerText": 'self: "after the review"\nspeaker_1: "lunch?"',
    }
    # no transcript attribution → no keys added.
    assert ambient_speaker_preview({"salience": 0.7}) == {}


def test_speaker_text_from_segments_skips_malformed_entries():
    assert (
        speaker_text_from_segments(
            [
                {"speaker": "self", "text": "hi"},
                {"speaker": "", "text": "dropped"},
                {"speaker": "speaker_1"},
                "not-a-dict",
                {"speaker": "speaker_1", "text": "there"},
            ]
        )
        == 'self: "hi"\nspeaker_1: "there"'
    )
    assert speaker_text_from_segments([]) is None
    assert speaker_text_from_segments("nope") is None


def test_inline_speaker_text_collapses_to_one_line():
    assert (
        inline_speaker_text(
            {
                "speaker_segments": [
                    {"speaker": "self", "text": "lunch later?"},
                    {"speaker": "speaker_1", "text": "sure"},
                ],
            }
        )
        == 'self: "lunch later?"  speaker_1: "sure"'
    )
    # No diarized segments → None so callers fall back to the title.
    assert inline_speaker_text({}) is None
    assert inline_speaker_text(None) is None
