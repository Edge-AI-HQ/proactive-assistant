"""World signals ingester — RSS → pai_world_signals + per-user scoring.

Port of `pinai-openclaw/plugins/proactive-ai/world/ingest.ts`.

Three RSS sources, hard-coded matching the old plugin (deliberate
parity — these are the news streams the old generator was trained
against, so behavioral diffs come from the model side, not the data):

  * Google News RSS — WORLD topic feed
  * Google News RSS — BUSINESS topic feed
  * SEC press releases
  * Federal Reserve press releases

Per-source dedup is via `normalized_url` (UNIQUE in pai_world_signals);
ON CONFLICT in the repository's `ingest_world` returns the existing
row's id, so re-pulling unchanged feeds is idempotent.

After each newly-inserted (or updated) row, we:
  1. enqueue an embedding job (pai_embedding_queue) — the queue worker
     fills `pai_world_signals.embedding` async, normally < 30s after.
  2. invoke `world_scoring.score_for_active_users()` so every user with
     last_active_at within the last 30 days gets an open user_view row
     pre-scored. Subsequent /api/agent/world/recent calls then return
     a list ordered by salience.

Scheduling is via a single asyncio.Task launched in web/app.py
lifespan, NOT through pai_scheduled_tasks. That table is per-user
(`user_id NOT NULL`), but world ingest is a global side effect — one
RSS pull serves every user in the deployment. The global loop runs
every 30 minutes and is safe across multiple replicas because the
ingest_world UPSERT is idempotent (per-URL).
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlparse, urlunparse

import feedparser
import httpx
from pinai_db.rls import service_tx

from ....platform.embeddings import enqueue as enqueue_embedding
from . import world_scoring
from .world_signals import IngestWorldSignalInput, WorldSignalsRepository

logger = logging.getLogger(__name__)

# 30-minute global cadence matches the old plugin's auto_ingest_interval_ms.
INGEST_INTERVAL_SEC = 30 * 60

# Strip these query-string keys when normalizing URLs — UTM and similar
# trackers are the #1 cause of "same article, different URL" duplicates.
_TRACKER_PARAMS = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "fbclid",
        "gclid",
        "mc_cid",
        "mc_eid",
        "ref",
        "ref_src",
    }
)


@dataclass(slots=True)
class _Source:
    provider: str
    url: str
    topics: list[str]
    importance: str  # "high" | "medium"
    regions: list[str]


_SOURCES: list[_Source] = [
    _Source(
        provider="google_news",
        url="https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en",
        topics=["world", "geopolitics"],
        importance="high",
        regions=["world"],
    ),
    _Source(
        provider="google_news",
        url="https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en",
        topics=["business", "finance"],
        importance="high",
        regions=["world"],
    ),
    _Source(
        provider="sec",
        url="https://www.sec.gov/news/pressreleases.rss",
        topics=["sec", "regulation", "finance"],
        importance="high",
        regions=["us"],
    ),
    _Source(
        provider="federal_reserve",
        url="https://www.federalreserve.gov/feeds/press_all.xml",
        topics=["fed", "monetary-policy", "finance"],
        importance="high",
        regions=["us"],
    ),
]


# ── URL normalization + dedup id ───────────────────────────────────


def normalize_url(url: str) -> str:
    """Strip tracker params, lowercase host, drop fragment.
    Same algorithm as the old plugin so we don't double-ingest items
    that crossed migration."""
    if not url:
        return ""
    parsed = urlparse(url.strip())
    host = (parsed.hostname or "").lower()
    if parsed.port and parsed.port not in (80, 443):
        host = f"{host}:{parsed.port}"
    # Strip tracker query keys.
    if parsed.query:
        kept = []
        for kv in parsed.query.split("&"):
            if not kv:
                continue
            key = kv.split("=", 1)[0].lower()
            if key not in _TRACKER_PARAMS:
                kept.append(kv)
        new_query = "&".join(kept)
    else:
        new_query = ""
    # Drop fragment, normalize trailing slash on path
    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    return urlunparse((parsed.scheme.lower(), host, path, "", new_query, ""))


def _signal_id(provider: str, normalized_url: str, title: str) -> str:
    """Stable surrogate id. SHA256 of (provider | normalized_url | title)
    truncated for readability — collisions are infinitesimal for our row
    counts."""
    h = hashlib.sha256(f"{provider}|{normalized_url}|{title}".encode()).hexdigest()
    return f"world_{h[:24]}"


# ── HTTP fetch + parse ─────────────────────────────────────────────


async def _fetch_feed(client: httpx.AsyncClient, source: _Source) -> bytes | None:
    """Fetch one RSS feed. Returns None on hard failure so the caller
    can soldier on with the other sources (one bad feed shouldn't kill
    the run)."""
    try:
        resp = await client.get(
            source.url,
            headers={"User-Agent": "pinai-agents-world-ingest/0.2"},
            follow_redirects=True,
            timeout=httpx.Timeout(connect=5.0, read=20.0, write=5.0, pool=5.0),
        )
        if resp.status_code != 200:
            logger.warning(
                "world.ingest %s HTTP %s: %s",
                source.provider,
                resp.status_code,
                resp.text[:200],
            )
            return None
        return resp.content
    except Exception as e:
        logger.warning("world.ingest %s fetch failed: %s", source.provider, e)
        return None


@dataclass(slots=True)
class _ParsedItem:
    title: str
    url: str
    summary: str | None
    published_at: datetime | None
    external_id: str | None


def _parse_feed(body: bytes) -> list[_ParsedItem]:
    """Parse RSS / Atom via feedparser. We want plain str fields with no
    HTML — the agent reads `title` + `summary` verbatim and we don't want
    `<p>` tags leaking into card sources."""
    parsed = feedparser.parse(body)
    items: list[_ParsedItem] = []
    for entry in parsed.entries:
        title = (getattr(entry, "title", None) or "").strip()
        link = (getattr(entry, "link", None) or "").strip()
        if not title or not link:
            continue
        # `summary` may contain HTML from some feeds; feedparser also
        # strips for `description`. We take whichever is shorter +
        # plaintext-ish. For SEC / Fed feeds the summary is short
        # plain text already.
        summary = (getattr(entry, "summary", None) or "").strip()
        # Drop trivial HTML tags — keep this cheap; anything fancier
        # belongs in a real sanitizer if we ingest hostile content.
        if "<" in summary and ">" in summary:
            summary = _strip_simple_html(summary)
        # Published time. feedparser exposes `.published_parsed` as a
        # struct_time tuple; convert to UTC datetime.
        published_at: datetime | None = None
        pp = getattr(entry, "published_parsed", None) or getattr(entry, "updated_parsed", None)
        if pp is not None:
            try:
                published_at = datetime(
                    pp[0],
                    pp[1],
                    pp[2],
                    pp[3],
                    pp[4],
                    pp[5],
                    tzinfo=UTC,
                )
            except Exception:
                published_at = None
        external_id = getattr(entry, "id", None) or getattr(entry, "guid", None)
        items.append(
            _ParsedItem(
                title=title[:500],
                url=link,
                summary=(summary or None) and summary[:1500],
                published_at=published_at,
                external_id=external_id if isinstance(external_id, str) else None,
            )
        )
    return items


def _strip_simple_html(text: str) -> str:
    """Cheap HTML tag stripping for summaries. Not a security boundary —
    just keeps the agent from reading literal angle brackets."""
    out: list[str] = []
    inside = False
    for ch in text:
        if ch == "<":
            inside = True
        elif ch == ">":
            inside = False
        elif not inside:
            out.append(ch)
    return "".join(out).strip()


# ── Top-level run ──────────────────────────────────────────────────


async def run_once(pool) -> dict[str, int]:
    """One ingest pass over all configured sources.

    Returns a per-source counter dict (used for log lines + tests).
    Idempotent: running twice in a row inserts ≤ a handful of new rows
    (rss feeds typically don't roll over fully in 30 min).
    """
    stats: dict[str, int] = {"fetched": 0, "parsed": 0, "inserted_or_updated": 0}
    inserted_ids: list[str] = []

    async with httpx.AsyncClient() as client:
        feeds = await asyncio.gather(
            *(_fetch_feed(client, s) for s in _SOURCES),
            return_exceptions=False,
        )

    for source, body in zip(_SOURCES, feeds, strict=True):
        if body is None:
            continue
        stats["fetched"] += 1
        items = _parse_feed(body)
        stats["parsed"] += len(items)
        if not items:
            continue

        async with service_tx(pool) as conn:
            # WorldSignalsRepository ingest_world doesn't actually use
            # user_id on the global table, but the base class requires
            # one — pass a sentinel valid user_id (the lowest active).
            # Ingest writes pai_world_signals (no RLS scoping needed),
            # not pai_world_signal_user_view, so the user_id is unused
            # in practice. We still keep the abstraction so the SQL
            # path goes through the repository, not raw cur.execute.
            cur = await conn.execute(
                "SELECT id FROM users ORDER BY id ASC LIMIT 1",
            )
            sentinel_row = await cur.fetchone()
            if sentinel_row is None:
                logger.warning(
                    "world.ingest skipped — no users in DB so no sentinel "
                    "user_id to bind WorldSignalsRepository against",
                )
                return stats
            sentinel_uid = int(sentinel_row["id"])
            repo = WorldSignalsRepository(sentinel_uid, conn)
            for item in items:
                norm = normalize_url(item.url)
                if not norm:
                    continue
                sig_id = _signal_id(source.provider, norm, item.title)
                row = await repo.ingest_world(
                    IngestWorldSignalInput(
                        id=sig_id,
                        provider=source.provider,
                        stream_type="rss",
                        title=item.title,
                        url=item.url,
                        normalized_url=norm,
                        external_id=item.external_id,
                        summary=item.summary,
                        published_at=item.published_at,
                        topics=source.topics,
                        regions=source.regions,
                        importance=source.importance,
                        metadata={
                            "source_url": source.url,
                            "ingest_at": datetime.now(UTC).isoformat(),
                        },
                    )
                )
                stats["inserted_or_updated"] += 1
                inserted_ids.append(row.id)

                # Enqueue embedding. Text is the corpus the semantic
                # index will use for the cosine search; matches the
                # field selection the old plugin used (title + summary
                # + topics).
                emb_text = " ".join(
                    [
                        item.title,
                        item.summary or "",
                        " ".join(source.topics),
                        " ".join(source.regions),
                    ]
                ).strip()
                if emb_text:
                    # enqueue() needs a user_id but the queue table is
                    # only used as a worklist — for the shared world
                    # table the worker writes back via WHERE id only,
                    # ignoring user_id (see embeddings.py:186-196).
                    await enqueue_embedding(
                        conn,
                        user_id=sentinel_uid,
                        table_name="pai_world_signals",
                        row_id=row.id,
                        text=emb_text,
                    )

    if inserted_ids:
        # Per-user scoring runs in a separate tx so the ingest commit
        # lands first; if scoring crashes the world rows are still
        # there, just unscored.
        try:
            scored_users = await world_scoring.score_for_active_users(
                pool,
                world_signal_ids=inserted_ids,
            )
            stats["scored_user_rows"] = scored_users
        except Exception:
            logger.exception("world.scoring failed; world rows ingested but unscored")

    logger.info("world.ingest run_once stats=%s", stats)
    return stats


# ── Background loop launched from web/app.py lifespan ──────────────


async def loop(pool) -> None:
    """Forever-loop: run_once → sleep INGEST_INTERVAL_SEC → repeat.
    First run fires after a short stagger so we don't pile work onto
    the cold-start tick."""
    # Initial stagger so we don't slam the DB the moment web boots —
    # also gives migrations time to settle on a fresh deploy.
    await asyncio.sleep(60)
    while True:
        try:
            await run_once(pool)
        except asyncio.CancelledError:
            logger.info("world.ingest loop cancelled")
            raise
        except Exception:
            # Don't kill the loop on a transient failure — sleep and retry.
            logger.exception("world.ingest run_once raised")
        await asyncio.sleep(INGEST_INTERVAL_SEC)


# Convenience for ad-hoc invocation in tests / CLI.
async def trigger(pool) -> dict[str, int]:
    """Run once on demand. Used by tests + manual `python -m
    pinai_api.domains.connector.world.world_ingest` for ops-level verification."""
    return await run_once(pool)


if __name__ == "__main__":
    # Standalone entrypoint: `python -m pinai_api.domains.connector.world.world_ingest`.
    # Useful for one-off ops triggers without spinning up the whole web app.
    import os

    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    @functools.cache
    def _setup_logging() -> None:
        logging.basicConfig(
            level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s :: %(message)s"
        )

    async def _main() -> None:
        _setup_logging()
        dsn = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL")
        if not dsn:
            raise SystemExit("SUPABASE_DB_URL or DATABASE_URL required")
        pool = AsyncConnectionPool(
            conninfo=dsn,
            min_size=1,
            max_size=4,
            kwargs={"row_factory": dict_row},
            open=False,
        )
        await pool.open()
        try:
            stats = await trigger(pool)
            print(f"done: {stats}")
        finally:
            await pool.close()

    asyncio.run(_main())
