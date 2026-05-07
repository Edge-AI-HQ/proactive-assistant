"""World signals native @tool wrappers.

World signals = global news / external context. The shared row holds
the payload; per-user view holds salience + status. Recent feed JOINs
both so the agent sees scored items inline.
"""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class WorldRecentInput(BaseModel):
    status: str = Field(
        default="open",
        pattern="^(open|consumed|archived|all|new)$",
        description=(
            "Per-user lifecycle of the world signal. open=scored & active; "
            "new=just ingested, no score yet; consumed=already turned into "
            "a card. Default open is the right answer for 'what's relevant'."
        ),
    )
    provider: str | None = Field(
        default=None,
        description="Filter by news provider (e.g. 'newsapi', 'rss').",
    )
    hours: int | None = Field(
        default=72, ge=1, le=336,
        description="Look-back window over published_at. None disables.",
    )
    min_salience: float | None = Field(
        default=None, ge=0, le=1, alias="minSalience",
        description="Filter to user-relevance ≥ threshold.",
    )
    limit: int = Field(default=20, ge=1, le=100)


@tool("world_recent", args_schema=WorldRecentInput)
async def world_recent(
    status: str, provider: str | None, hours: int | None,
    min_salience: float | None, limit: int,
):
    """Recent globally-shared news / world signals scored for the
    current user. Use to answer 'what's new in the world relevant to me'
    or to surface external context for a card."""
    payload = await http_client.get(
        "/api/agent/world/recent",
        status=status, provider=provider, hours=hours,
        minSalience=min_salience, limit=limit,
    )
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    items = payload.get("items", []) if isinstance(payload, dict) else []
    return [
        {
            "id": s["id"],
            "provider": s.get("provider"),
            "title": s.get("title"),
            "summary": (s.get("summary") or "")[:200],
            "url": s.get("url"),
            "publishedAt": s.get("publishedAt"),
            "salience": s.get("salience"),
            "status": s.get("status"),
        }
        for s in items
    ]


class WorldSearchInput(BaseModel):
    q: str = Field(
        min_length=1, max_length=500,
        description="Natural-language query — server embeds it then runs hybrid keyword + semantic match over recent news.",
    )
    limit: int = Field(default=10, ge=1, le=30)
    status: str = Field(
        default="open",
        pattern="^(open|consumed|archived|all|new)$",
        description="Per-user lifecycle filter. Default 'open'; pass 'all' to search across everything regardless of consume state.",
    )


@tool("world_search", args_schema=WorldSearchInput)
async def world_search(q: str, limit: int, status: str):
    """Hybrid (keyword + semantic) search over world news for a SPECIFIC
    topic / query. Server runs tsvector full-text and pgvector cosine in
    parallel and fuses by RRF. Use when the user asks about a particular
    subject ('what's happening with X') — `world_recent` is for browsing
    the latest by salience without a query."""
    payload = await http_client.get(
        "/api/agent/world/search", q=q, limit=limit, status=status,
    )
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    items = payload.get("items", []) if isinstance(payload, dict) else []
    return [
        {
            "id": s["id"],
            "provider": s.get("provider"),
            "title": s.get("title"),
            "summary": (s.get("summary") or "")[:200],
            "url": s.get("url"),
            "publishedAt": s.get("publishedAt"),
            "salience": s.get("salience"),
            "rrfScore": s.get("rrfScore"),
            "kwRank": s.get("kwRank"),
            "semRank": s.get("semRank"),
        }
        for s in items
    ]
