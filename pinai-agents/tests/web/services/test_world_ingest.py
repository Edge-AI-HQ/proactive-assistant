"""Unit tests for world_ingest pure helpers (no DB, no network).

The full ingest path is exercised by an integration test that needs a
live DB + RSS mock. These tests pin the deterministic logic — URL
normalization (the dedup key), feed parsing (HTML stripping, date
parsing, missing-link skip), and signal id stability.
"""

from __future__ import annotations

import pytest

from pinai_agents.web.services import world_ingest

# ── normalize_url ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        # Basic: lowercase host, drop fragment.
        ("https://Example.COM/path?x=1#frag", "https://example.com/path?x=1"),
        # Tracker params stripped — utm_source, fbclid, etc.
        (
            "https://news.google.com/article?utm_source=foo&utm_campaign=bar&id=42",
            "https://news.google.com/article?id=42",
        ),
        # All trackers → empty query.
        (
            "https://news.google.com/article?utm_source=foo&fbclid=xx",
            "https://news.google.com/article",
        ),
        # Trailing slash on non-root path stripped.
        ("https://example.com/path/", "https://example.com/path"),
        # Root slash kept.
        ("https://example.com/", "https://example.com/"),
        # Empty input.
        ("", ""),
    ],
)
def test_normalize_url(raw, expected):
    assert world_ingest.normalize_url(raw) == expected


def test_normalize_url_preserves_non_tracker_query_keys():
    """Non-tracker query keys must be preserved verbatim. Some news
    sites encode the article id in the query string — losing those
    would change the canonical URL."""
    out = world_ingest.normalize_url(
        "https://news.example.com/story?id=42&category=tech&utm_source=rss",
    )
    assert "id=42" in out
    assert "category=tech" in out
    assert "utm_source" not in out


# ── _signal_id ─────────────────────────────────────────────────────


def test_signal_id_stable_across_calls():
    """Same inputs → same id. Critical for ON CONFLICT idempotence:
    re-ingesting the same article shouldn't write a new row."""
    a = world_ingest._signal_id("google_news", "https://x.com/a", "Headline")
    b = world_ingest._signal_id("google_news", "https://x.com/a", "Headline")
    assert a == b


def test_signal_id_changes_with_provider():
    a = world_ingest._signal_id("google_news", "https://x.com/a", "Headline")
    b = world_ingest._signal_id("sec", "https://x.com/a", "Headline")
    assert a != b


def test_signal_id_format():
    sid = world_ingest._signal_id("p", "https://x.com/", "T")
    assert sid.startswith("world_")
    assert len(sid) == len("world_") + 24


# ── _strip_simple_html ─────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("<p>Hello <b>world</b></p>", "Hello world"),
        ("plain text", "plain text"),
        ("a<br/>b", "ab"),
        ("<a href='x'>link</a>", "link"),
        ("", ""),
    ],
)
def test_strip_simple_html(raw, expected):
    assert world_ingest._strip_simple_html(raw) == expected


# ── _parse_feed ────────────────────────────────────────────────────


def _build_minimal_rss(items: list[tuple[str, str, str]]) -> bytes:
    """Build a minimal RSS 2.0 doc with given (title, link, description)
    triples. Used in tests below to drive _parse_feed without hitting
    the network."""
    item_xml = "".join(
        f"<item><title>{t}</title><link>{link}</link><description>{d}</description></item>"
        for t, link, d in items
    )
    body = (
        '<?xml version="1.0"?>'
        '<rss version="2.0"><channel>'
        "<title>test</title>"
        f"{item_xml}"
        "</channel></rss>"
    )
    return body.encode("utf-8")


def test_parse_feed_extracts_title_link_summary():
    body = _build_minimal_rss(
        [
            ("Headline 1", "https://news.example.com/1", "Brief summary 1"),
            ("Headline 2", "https://news.example.com/2", "<p>HTML summary</p>"),
        ]
    )
    items = world_ingest._parse_feed(body)
    assert len(items) == 2
    assert items[0].title == "Headline 1"
    assert items[0].url == "https://news.example.com/1"
    assert items[0].summary == "Brief summary 1"
    # HTML stripped from second item
    assert items[1].summary == "HTML summary"


def test_parse_feed_skips_items_missing_link_or_title():
    """Defensive — feed authors sometimes emit empty <link/> or <title/>."""
    body = (
        b'<?xml version="1.0"?>'
        b'<rss version="2.0"><channel>'
        b"<item><title>OK</title><link>https://x.com/ok</link></item>"
        b"<item><title></title><link>https://x.com/empty</link></item>"
        b"<item><title>Has Title</title><link></link></item>"
        b"</channel></rss>"
    )
    items = world_ingest._parse_feed(body)
    assert len(items) == 1
    assert items[0].title == "OK"


def test_parse_feed_handles_empty_body():
    items = world_ingest._parse_feed(b"")
    assert items == []
